export type FakeMcpOptions = {
  era?: "modern" | "legacy";
  tools?: number;
  page?: number;
  stderr?: boolean;
  slow?: number;
  listChanged?: boolean;
  crashAfter?: number;
};
export type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export function createLogic(
  opts?: FakeMcpOptions,
): (msg: JsonRpc, push?: (m: JsonRpc) => void) => JsonRpc[];
export const MODERN: string;
export const LEGACY: string;
