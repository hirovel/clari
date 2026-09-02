// 零依赖静态服务器:只为在浏览器面板里看 .preview/ 下的 TUI 预览(不参与产品构建)。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..", ".preview");
const PORT = 4174;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const rel = url === "/" ? "/tui-preview.html" : url;
  const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
  }
}).listen(PORT, () => console.log(`预览 http://localhost:${PORT}/`));
