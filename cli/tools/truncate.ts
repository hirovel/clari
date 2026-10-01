// 截断策略:开放接口,工具在输出超限时按策略选择保留哪部分。
// 内置保头与保尾;自定义策略从外部传入工具工厂即可,不改任何现有代码。

export type Truncation = {
  /** 展示给模型的部分。 */
  text: string;
  truncated: boolean;
  /** 保留范围的说明,如"显示第 100-2099 行,共 2099 行"。 */
  note?: string;
};

export type TruncationPolicy = (output: string, override?: TruncationLimits) => Truncation;

export type TruncationLimits = { maxLines?: number; maxBytes?: number };

const DEFAULT_LINES = 2000;
const DEFAULT_BYTES = 50 * 1024;

/** 保尾:适合命令输出 —— 错误与结论通常在末尾。bash 工具的默认。 */
export function keepTail(limits: TruncationLimits = {}): TruncationPolicy {
  const { maxLines = DEFAULT_LINES, maxBytes = DEFAULT_BYTES } = limits;
  return (output, override) => {
    const byteLimit = override?.maxBytes ?? maxBytes;
    const lines = output.split("\n");
    if (fits(output, lines.length, maxLines, byteLimit)) return { text: output, truncated: false };
    let kept = lines.slice(-maxLines);
    while (bytes(kept.join("\n")) > byteLimit && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 10));
    }
    if (kept.length === 1 && bytes(kept[0] ?? "") > byteLimit) {
      const line = kept[0] as string;
      const text = clipUtf8(line, byteLimit, "tail");
      return {
        text,
        truncated: true,
        note: `showing last ${bytes(text)} of ${bytes(line)} bytes of line ${lines.length}`,
      };
    }
    const from = lines.length - kept.length + 1;
    return {
      text: kept.join("\n"),
      truncated: true,
      note: `showing lines ${from}-${lines.length} of ${lines.length}`,
    };
  };
}

/** 保头:适合文件内容与列表 —— 开头是结构所在。read 工具的默认。 */
export function keepHead(limits: TruncationLimits = {}): TruncationPolicy {
  const { maxLines = DEFAULT_LINES, maxBytes = DEFAULT_BYTES } = limits;
  return (output, override) => {
    const byteLimit = override?.maxBytes ?? maxBytes;
    const lines = output.split("\n");
    if (fits(output, lines.length, maxLines, byteLimit)) return { text: output, truncated: false };
    let kept = lines.slice(0, maxLines);
    while (bytes(kept.join("\n")) > byteLimit && kept.length > 1) {
      kept = kept.slice(0, Math.floor(kept.length * 0.9));
    }
    if (kept.length === 1 && bytes(kept[0] ?? "") > byteLimit) {
      const line = kept[0] as string;
      const text = clipUtf8(line, byteLimit, "head");
      return {
        text,
        truncated: true,
        note: `showing first ${bytes(text)} of ${bytes(line)} bytes of line 1`,
      };
    }
    return {
      text: kept.join("\n"),
      truncated: true,
      note: `showing lines 1-${kept.length} of ${lines.length}`,
    };
  };
}

/**
 * 单行长度上限:压扁超长行(压缩产物/单行 JSON),防止一行吃穿字节预算。
 * 与头尾策略正交,在策略之前应用。
 */
export function capLineLength(maxChars: number): (text: string) => string {
  return (text) =>
    text
      .split("\n")
      .map((l) =>
        l.length > maxChars ? `${l.slice(0, maxChars)}…[line truncated to ${maxChars} chars]` : l,
      )
      .join("\n");
}

function fits(output: string, lineCount: number, maxLines: number, maxBytes: number): boolean {
  return lineCount <= maxLines && bytes(output) <= maxBytes;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** 按完整 UTF-8 字符裁切,使单行也遵守字节预算。 */
function clipUtf8(text: string, limit: number, side: "head" | "tail"): string {
  const raw = Buffer.from(text, "utf8");
  if (side === "head") {
    let end = Math.min(raw.length, Math.max(0, limit));
    while (end < raw.length && end > 0 && ((raw[end] as number) & 0xc0) === 0x80) end--;
    return raw.subarray(0, end).toString("utf8");
  }
  let start = Math.max(0, raw.length - Math.max(0, limit));
  while (start < raw.length && ((raw[start] as number) & 0xc0) === 0x80) start++;
  return raw.subarray(start).toString("utf8");
}
