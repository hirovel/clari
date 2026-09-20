import type { CompleteOptions } from "../provider.js";
import { isContextOverflow, isRetryable, ProviderError } from "./errors.js";

export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** 测试注入;缺省真实等待。 */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
};

/**
 * 指数退避重试(两大 SDK 与 pi 的共识参数):默认 2 次,×2 退避,加抖动,服务端 retry-after 优先。
 * 溢出不重试(交给压缩恢复),打断不重试,服务端要求等太久(超过上限)直接失败。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (attempt >= maxRetries || isContextOverflow(err) || !isRetryable(err)) throw err;
      const serverWait = err instanceof ProviderError ? err.retryAfterMs : undefined;
      if (serverWait !== undefined && serverWait > cap * 4) throw err;
      const backoff = Math.min(base * 2 ** attempt, cap) * (0.8 + Math.random() * 0.4);
      const delayMs = Math.round(serverWait ?? backoff);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err as Error });
      await sleep(delayMs);
    }
  }
}

/** 把 CompleteOptions 里的 onRetry 并进适配器自己的重试配置,两边都收到通知。 */
export function mergeRetry(
  base: RetryOptions | undefined,
  opts: Pick<CompleteOptions, "signal" | "onRetry">,
): RetryOptions {
  const onRetry: RetryOptions["onRetry"] = (info) => {
    base?.onRetry?.(info);
    opts.onRetry?.(info);
  };
  return { ...base, onRetry, ...(opts.signal && { signal: opts.signal }) };
}
