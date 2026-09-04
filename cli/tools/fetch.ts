// fetch 工具(Q86):抓一个 URL,按 Content-Type 分流成可读文本。安全边界全是配置项:
// 私网地址拒绝(DNS 解析后查特殊用途地址段)、字节上限、超时、重定向只在同主机内自动跟、固定 User-Agent。
// 不缓存、不用小模型摘要:重复抓取的成本由模型看得见的 tool/result 事件承担,结果按 read 同一套截断策略分页。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { htmlToText } from "./html.js";
import { capLineLength, keepHead, type TruncationPolicy } from "./truncate.js";

export type FetchConfig = {
  /** 允许回环与私网地址(本机开发服务器、测试)。缺省拒绝。 */
  allowPrivate?: boolean;
  /** 整个请求(含读 body)的超时毫秒数,缺省 30000。 */
  timeoutMs?: number;
  /** body 字节上限,缺省 5 MB;超过即中断并注明。 */
  maxBytes?: number;
  /** 同主机重定向最多跟几次,缺省 5。 */
  maxRedirects?: number;
  userAgent?: string;
};

const DEFAULTS = { timeoutMs: 30000, maxBytes: 5 * 1024 * 1024, maxRedirects: 5 };

/** IANA 特殊用途 IPv4 段与常见 IPv6 段:回环、私网、链路本地、CGNAT、保留。 */
const PRIVATE_V4: [number, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["240.0.0.0", 4],
].map(([ip, bits]) => [v4ToInt(ip as string), bits as number]);

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => n >>> (32 - bits) === base >>> (32 - bits));
  }
  if (family === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // fc00::/7
    if (/^fe[89ab]/.test(low)) return true; // fe80::/10
    const mapped = low.match(/^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    return false;
  }
  return false;
}

function parseContentType(header: string | null): { type: string; charset?: string } {
  const [mime = "", ...params] = (header ?? "").split(";").map((s) => s.trim().toLowerCase());
  const charset = params.find((p) => p.startsWith("charset="))?.slice("charset=".length);
  return { type: mime, ...(charset && { charset: charset.replace(/^"|"$/g, "") }) };
}

const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript"]);

export type FetchToolOptions = {
  config?: FetchConfig;
  /** HTML → 文本的转换器槽;缺省 htmlToText。 */
  convert?: (html: string, url: string) => string;
  truncate?: TruncationPolicy;
  maxLineChars?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
};

export function createFetchTool(opts: FetchToolOptions = {}) {
  const cfg = { ...DEFAULTS, ...opts.config };
  const convert = opts.convert ?? htmlToText;
  const truncate = opts.truncate ?? keepHead();
  const cap = capLineLength(opts.maxLineChars ?? 2000);
  const doFetch = opts.fetchImpl ?? fetch;
  const resolveHost =
    opts.resolve ??
    (async (host: string) =>
      isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address));

  const guard = async (u: URL): Promise<void> => {
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new Error(`only http and https URLs are fetched, got ${u.protocol}`);
    if (cfg.allowPrivate) return;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    let addrs: string[];
    try {
      addrs = await resolveHost(host);
    } catch (err) {
      throw new Error(`cannot resolve ${host}: ${(err as Error).message}`);
    }
    if (host === "localhost" || addrs.some(isPrivateAddress)) {
      throw new Error(
        `${host} resolves to a private or loopback address; refused (set fetch.allowPrivate to allow)`,
      );
    }
  };

  return defineTool({
    name: "fetch",
    description:
      "Fetch a URL over http(s) and return its content as text. HTML is converted to readable text (headings, lists, links, code blocks); " +
      "JSON, XML and plain text are returned as-is; binary content is refused. Redirects to another host are reported, not followed. " +
      "Long pages are truncated; continue with offset. Set raw=true to get the HTML unconverted.",
    parameters: Type.Object({
      url: Type.String({ description: "http or https URL" }),
      offset: Type.Optional(Type.Number({ description: "starting line number, 1-based" })),
      limit: Type.Optional(Type.Number({ description: "maximum number of lines to return" })),
      raw: Type.Optional(Type.Boolean({ description: "return the body without HTML conversion" })),
    }),
    concurrency: "parallel",
    async execute(args, ctx) {
      let current = new URL(args.url);
      let response: Response | undefined;
      for (let hop = 0; ; hop++) {
        await guard(current);
        const signal = ctx.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(cfg.timeoutMs)])
          : AbortSignal.timeout(cfg.timeoutMs);
        const res = await doFetch(current.toString(), {
          redirect: "manual",
          signal,
          headers: {
            "User-Agent": cfg.userAgent ?? "clari/0.1",
            Accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
          },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          const next = new URL(location, current);
          await res.body?.cancel().catch(() => {});
          if (next.host !== current.host) {
            return `${current} → redirected to ${next} (another host, not followed); call fetch again with that URL if you trust it`;
          }
          if (hop >= cfg.maxRedirects) throw new Error(`more than ${cfg.maxRedirects} redirects`);
          current = next;
          continue;
        }
        response = res;
        break;
      }
      const ct = parseContentType(response.headers.get("content-type"));
      const isHtml = ct.type === "text/html" || ct.type === "application/xhtml+xml";
      const isText =
        isHtml ||
        ct.type.startsWith("text/") ||
        TEXT_TYPES.has(ct.type) ||
        ct.type.endsWith("+json") ||
        ct.type.endsWith("+xml") ||
        ct.type === "";
      if (!isText) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`${current} is ${ct.type}: binary content is not fetched into the context`);
      }
      // 逐块读,超过上限即停:大页面不该整份进内存。
      const chunks: Uint8Array[] = [];
      let total = 0;
      let cut = false;
      const reader = response.body?.getReader();
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
            if (total > cfg.maxBytes) {
              cut = true;
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
      }
      const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      let charset = ct.charset;
      if (!charset && isHtml) {
        const head = bytes.subarray(0, 4096).toString("latin1");
        charset = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1]?.toLowerCase();
      }
      let text: string;
      try {
        text = new TextDecoder(charset ?? "utf-8").decode(bytes);
      } catch {
        text = new TextDecoder("utf-8").decode(bytes);
      }
      const body = isHtml && !args.raw ? convert(text, current.toString()) : text;
      const lines = body.split("\n");
      const start = Math.max(1, args.offset ?? 1);
      const slice = lines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
      const t = truncate(cap(slice.join("\n")));
      const head = `${args.url}${current.toString() !== args.url ? ` → ${current}` : ""} · ${response.status} · ${ct.type || "unknown type"} · ${total} bytes${cut ? ` (stopped at the ${cfg.maxBytes}-byte limit)` : ""} → ${body.length} chars, ${lines.length} lines`;
      if (!t.truncated && !args.limit) return `${head}\n\n${t.text}`;
      const shown = t.text.split("\n").length;
      return `${head}\n\n${t.text}\n[${t.note ?? "truncated"}; page has ${lines.length} lines, continue with offset=${start + shown}]`;
    },
  });
}

export const fetchTool = createFetchTool();
