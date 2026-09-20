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
