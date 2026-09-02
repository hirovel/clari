// provider 错误归一:各家 status/body 形态不同,这里统一成一个可判定"能否重试 / 是否溢出"的错误对象。

export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly body: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; body?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? (opts.status !== undefined && retryableStatus(opts.status));
    this.retryAfterMs = opts.retryAfterMs;
    this.body = opts.body;
  }
}

/** 各家与两大 SDK 一致的可重试状态码集合。 */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** 从响应头解析 retry-after(毫秒优先,其次秒或 HTTP 日期)。 */
export function parseRetryAfter(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms && /^\d+$/.test(ms)) return Number(ms);
  const ra = headers.get("retry-after");
  if (!ra) return undefined;
  if (/^\d+$/.test(ra)) return Number(ra) * 1000;
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** 网络层失败(连接拒绝、DNS、读流中断)与流提前结束都可重试。 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|stream ended/i.test(
      err.message,
    );
  }
  return false;
}

const OVERFLOW = [
  /context_length_exceeded/i,
  /prompt is too long/i,
  /maximum context length/i,
  /exceeds? the (?:model'?s )?(?:maximum )?context/i,
  /context window/i,
  /input is too long/i,
  /too many tokens/i,
  /model_context_window_exceeded/i,
];
const NOT_OVERFLOW = [/rate.?limit/i, /too many requests/i, /quota/i];

/**
 * 上下文溢出识别:没有跨家统一错误码,只能靠文案库 + 反例排除。
 * 必须在重试判定之前处理 —— 溢出重试永远不会成功。
 */
export function isContextOverflow(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.message} ${err instanceof ProviderError ? (err.body ?? "") : ""}`;
  if (NOT_OVERFLOW.some((re) => re.test(text))) return false;
  return OVERFLOW.some((re) => re.test(text));
}
