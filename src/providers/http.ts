import { ProviderError } from "./errors.js";

// 记录发生在协议解析之前。三个适配器共用,正文错误与流中断也留下实际收到的部分。
export type HttpRecord = {
  response(status: number, contentType: string): void;
  chunk(data: Uint8Array): Promise<void>;
  end(state: "complete" | "interrupted", error?: string): Promise<void>;
};
export type HttpRecorder = (body: string) => Promise<HttpRecord>;

export async function recordedFetch(
  url: string,
  init: RequestInit,
  record?: HttpRecorder,
): Promise<{ response: Response; saved: Promise<void> }> {
  if (!record) return { response: await fetch(url, init), saved: Promise.resolve() };
  const capture = await record(String(init.body ?? ""));
  let ended = false;
  let savedResolve!: () => void;
  let savedReject!: (error: unknown) => void;
  const saved = new Promise<void>((resolve, reject) => {
    savedResolve = resolve;
    savedReject = reject;
  });
  // 调用者在解析结束后等待 saved;不能让磁盘等待触发网络停滞计时。
  void saved.catch(() => {});
  const end = (state: "complete" | "interrupted", error?: string) => {
    if (ended) return;
    ended = true;
    try {
      void capture.end(state, error).then(savedResolve, savedReject);
    } catch (error) {
      savedReject(error);
    }
  };
  try {
    init.signal?.throwIfAborted();
    const res = await fetch(url, init);
    capture.response(res.status, res.headers.get("content-type") ?? "");
    if (!res.body) {
      end("complete");
      return { response: res, saved };
    }
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              reader.releaseLock();
              end("complete");
              controller.close();
            } else {
              await capture.chunk(result.value);
              controller.enqueue(result.value);
            }
          } catch (error) {
            await reader.cancel(error).catch(() => {});
            reader.releaseLock();
            end("interrupted", (error as Error).message);
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
            end("interrupted", "Response reading stopped");
          }
        },
      },
      { highWaterMark: 0 },
    );
    return {
      response: new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      }),
      saved,
    };
  } catch (error) {
    end("interrupted", (error as Error).message);
    await saved;
    throw error;
  }
}

/** 所有适配器共用的 GET /models:返回 data[].id。 */
export async function fetchModelIds(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ProviderError(`provider ${res.status}: ${await res.text()}`, { status: res.status });
  }
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

/**
 * 请求级中止控制:用户的 signal 之外,停滞超时也要能撤销底层 fetch。
 * 返回的 signal 给 fetch;abort() 只由停滞调用,不会被误判成用户打断(调用方看的仍是用户的 signal)。
 */
export function linkedAbort(signal?: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}
