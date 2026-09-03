// SSE 读流(两个适配器共用):按行切分、逐行旁路(trace)、停滞超时、data 行的 JSON 解析。
// 网络层的三种失败在这里归一成 ProviderError:停滞(可重试)、烂 JSON(不可重试)、打断(交给调用方判定)。
import { ProviderError } from "./errors.js";

export const DEFAULT_STALL_MS = 90_000;

export class StreamStall extends ProviderError {
  constructor(ms: number) {
    super(`stream stalled: ${ms}ms 内没有收到任何字节`, { retryable: true });
    this.name = "StreamStall";
  }
}

export type SseOptions = {
  /** 每收到一行(含空行之外的所有行)回调一次,未解析。 */
  onRaw?: (line: string) => void;
  /** 连续这么久没有字节就判停滞;0 = 不限。 */
  stallTimeoutMs?: number;
  /** 停滞时调用,用来撤销底层请求。 */
  onStall?: () => void;
};

/** 逐个产出已解析的 data 载荷;[DONE] 与非 data 行跳过。 */
export async function* sseEvents(
  body: AsyncIterable<Uint8Array>,
  opts: SseOptions = {},
): AsyncGenerator<unknown> {
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const decoder = new TextDecoder();
  const it = body[Symbol.asyncIterator]();
  let buffer = "";
  while (true) {
    const step = await nextChunk(it, stallMs, opts.onStall);
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (opts.onRaw && line.trim()) opts.onRaw(line);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      yield parseData(data);
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) {
    if (opts.onRaw) opts.onRaw(rest);
    const data = rest.slice(5).trim();
    if (data && data !== "[DONE]") yield parseData(data);
  }
}

function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    // 服务器发来一行解析不了的东西:不猜、不跳过。原文随错误一起进日志。
    throw new ProviderError(`provider stream: 无法解析的一行 ${data.slice(0, 200)}`, {
      retryable: false,
      body: data,
    });
  }
}

async function nextChunk(
  it: AsyncIterator<Uint8Array>,
  stallMs: number,
  onStall: (() => void) | undefined,
): Promise<IteratorResult<Uint8Array>> {
  if (stallMs <= 0) return it.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onStall?.();
      reject(new StreamStall(stallMs));
    }, stallMs);
  });
  try {
    return await Promise.race([it.next(), stall]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
