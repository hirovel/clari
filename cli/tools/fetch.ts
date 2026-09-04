// fetch 工具(Q86):抓一个 URL,按 Content-Type 分流成可读文本。安全边界全是配置项:
// 私网地址拒绝(DNS 解析后查特殊用途地址段,重定向逐跳再查)、字节上限、超时、重定向只在同主机内自动跟、
// 每主机限流。不用小模型摘要:模型看到的就是页面,结果按 read 同一套截断策略分页。
// 会话内缓存 15 分钟(分页续读不重下);GitHub blob 改写成 raw;Cloudflare 403 用浏览器 UA 重试一次。
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
  /** 会话内缓存的存活毫秒数,缺省 15 分钟;0 关。 */
  cacheTtlMs?: number;
  /** 每主机每分钟最多几次真实请求,缺省 10;0 不限。 */
  perHostPerMinute?: number;
};

const DEFAULTS = {
  timeoutMs: 30000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  cacheTtlMs: 15 * 60 * 1000,
  perHostPerMinute: 10,
  userAgent: "Mozilla/5.0 (compatible; clari/0.1; +https://github.com/hirovel/clari)",
};
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** 缓存总量上限(字符数)。 */
const CACHE_CHARS = 20 * 1024 * 1024;

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

/** GitHub blob 与 gist 页面是 JS 壳,改写成 raw 才有正文。返回改写后的 URL 与说明。 */
export function rewriteUrl(u: URL): { url: URL; note?: string } {
  if (u.hostname === "github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) {
      return {
        url: new URL(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`),
        note: "github blob rewritten to raw",
      };
    }
  }
  if (u.hostname === "gist.github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f]+)\/?$/);
    if (m) {
      return {
        url: new URL(`https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`),
        note: "gist rewritten to raw",
      };
    }
  }
  return { url: u };
}

function parseContentType(header: string | null): { type: string; charset?: string } {
  const [mime = "", ...params] = (header ?? "").split(";").map((s) => s.trim().toLowerCase());
  const charset = params.find((p) => p.startsWith("charset="))?.slice("charset=".length);
  return { type: mime, ...(charset && { charset: charset.replace(/^"|"$/g, "") }) };
}

const TEXT_TYPES = new Set(["application/json", "application/xml", "application/javascript"]);

type Fetched = {
  finalUrl: string;
  status: number;
  type: string;
  total: number;
  cut: boolean;
  text: string;
  isHtml: boolean;
  isJson: boolean;
  notes: string[];
  at: number;
};

export type FetchToolOptions = {
  config?: FetchConfig;
  /** HTML → 文本的转换器槽;缺省 htmlToText。 */
  convert?: (html: string, url: string) => string;
  truncate?: TruncationPolicy;
  maxLineChars?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => number;
};

export function createFetchTool(opts: FetchToolOptions = {}) {
  const cfg = { ...DEFAULTS, ...opts.config };
  const convert = opts.convert ?? htmlToText;
  const truncate = opts.truncate ?? keepHead();
  const cap = capLineLength(opts.maxLineChars ?? 2000);
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const resolveHost =
    opts.resolve ??
    (async (host: string) =>
      isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address));
  const cache = new Map<string, Fetched>();
  const hits = new Map<string, number[]>();

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

  const rateLimit = (host: string): void => {
    if (!cfg.perHostPerMinute) return;
    const t = clock();
    const recent = (hits.get(host) ?? []).filter((x) => t - x < 60000);
    if (recent.length >= cfg.perHostPerMinute) {
      throw new Error(
        `rate limit: more than ${cfg.perHostPerMinute} requests to ${host} in 60 s; wait before fetching it again`,
      );
    }
    recent.push(t);
    hits.set(host, recent);
  };

  const cacheGet = (key: string): Fetched | undefined => {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (clock() - hit.at > cfg.cacheTtlMs) {
      cache.delete(key);
      return undefined;
    }
    return hit;
  };

  const cachePut = (key: string, f: Fetched): void => {
    if (!cfg.cacheTtlMs) return;
    cache.set(key, f);
    let total = [...cache.values()].reduce((s, x) => s + x.text.length, 0);
    for (const k of cache.keys()) {
      if (total <= CACHE_CHARS) break;
      total -= cache.get(k)?.text.length ?? 0;
      cache.delete(k);
    }
  };

  const request = async (url: URL, signal: AbortSignal, ua: string): Promise<Response> =>
    doFetch(url.toString(), {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": ua,
        Accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1",
      },
    });

  const download = async (start: URL, ctxSignal: AbortSignal | undefined): Promise<Fetched> => {
    const notes: string[] = [];
    let current = start;
    let response: Response | undefined;
    for (let hop = 0; ; hop++) {
      await guard(current);
      rateLimit(current.host);
      const signal = ctxSignal
        ? AbortSignal.any([ctxSignal, AbortSignal.timeout(cfg.timeoutMs)])
        : AbortSignal.timeout(cfg.timeoutMs);
      let res = await request(current, signal, cfg.userAgent);
      // Cloudflare 拦下的 403 换浏览器 UA 再试一次(OpenCode 做法)。
      if (res.status === 403 && res.headers.get("cf-mitigated")) {
        await res.body?.cancel().catch(() => {});
        res = await request(current, signal, BROWSER_UA);
        notes.push("retried with a browser User-Agent after a Cloudflare 403");
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current);
        await res.body?.cancel().catch(() => {});
        if (next.host !== current.host) {
          return {
            finalUrl: current.toString(),
            status: res.status,
            type: "",
            total: 0,
            cut: false,
            text: `${current} → redirected to ${next} (another host, not followed); call fetch again with that URL if you trust it`,
            isHtml: false,
            isJson: false,
            notes: ["cross-host redirect"],
            at: clock(),
          };
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
    const isJson = ct.type === "application/json" || ct.type.endsWith("+json");
    const isText =
      isHtml ||
      isJson ||
      ct.type.startsWith("text/") ||
      TEXT_TYPES.has(ct.type) ||
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
    return {
      finalUrl: current.toString(),
      status: response.status,
      type: ct.type,
      total,
      cut,
      text,
      isHtml,
      isJson,
      notes,
      at: clock(),
    };
  };

  return defineTool({
    name: "fetch",
    description:
      "Fetch a URL over http(s) and return its content as text. HTML is converted to markdown (headings, lists, links, tables, code blocks); " +
      "JSON is pretty-printed; other text is returned as-is; binary content is refused. GitHub blob and gist pages are rewritten to their raw form. " +
      "Redirects to another host are reported, not followed. Long pages are truncated; continue with offset (pages are cached for 15 minutes, so paging is free). " +
      "Set raw=true to get the body unconverted.",
    parameters: Type.Object({
      url: Type.String({ description: "http or https URL" }),
      offset: Type.Optional(Type.Number({ description: "starting line number, 1-based" })),
      limit: Type.Optional(Type.Number({ description: "maximum number of lines to return" })),
      raw: Type.Optional(Type.Boolean({ description: "return the body without conversion" })),
    }),
    concurrency: "parallel",
    async execute(args, ctx) {
      const rewritten = rewriteUrl(new URL(args.url));
      const key = rewritten.url.toString();
      let fetched = cacheGet(key);
      let cached = true;
      if (!fetched) {
        cached = false;
        fetched = await download(rewritten.url, ctx.signal);
        if (fetched.status < 400 && !fetched.cut) cachePut(key, fetched);
      }
      if (fetched.notes.includes("cross-host redirect")) return fetched.text;

      let body: string;
      if (args.raw) body = fetched.text;
      else if (fetched.isHtml) body = convert(fetched.text, fetched.finalUrl);
      else if (fetched.isJson) {
        try {
          body = JSON.stringify(JSON.parse(fetched.text), null, 2);
        } catch {
          body = fetched.text;
        }
      } else body = fetched.text;

      const notes = [
        ...(rewritten.note ? [rewritten.note] : []),
        ...fetched.notes,
        ...(cached ? ["cached"] : []),
        ...(fetched.cut ? [`stopped at the ${cfg.maxBytes}-byte limit`] : []),
        ...(fetched.isHtml && !args.raw && body.length < 200 && fetched.total > 20000
          ? ["page is probably rendered by JavaScript; content may be missing"]
          : []),
      ];
      const lines = body.split("\n");
      const start = Math.max(1, args.offset ?? 1);
      const slice = lines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
      const t = truncate(cap(slice.join("\n")));
      const head = `${args.url}${fetched.finalUrl !== args.url ? ` → ${fetched.finalUrl}` : ""} · ${fetched.status} · ${fetched.type || "unknown type"} · ${fetched.total} bytes → ${body.length} chars, ${lines.length} lines${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
      if (!t.truncated && !args.limit) return `${head}\n\n${t.text}`;
      const shown = t.text.split("\n").length;
      return `${head}\n\n${t.text}\n[${t.note ?? "truncated"}; page has ${lines.length} lines, continue with offset=${start + shown}]`;
    },
  });
}

export const fetchTool = createFetchTool();
