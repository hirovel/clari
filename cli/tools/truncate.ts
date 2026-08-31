// 截断策略(Q28):开放接口,工具在输出超限时按策略选择保留哪部分。
// 内置三种覆盖常见场景;自定义策略从外部传入工具工厂即可,不改任何现有代码。

export type Truncation = {
  /** 展示给模型的部分。 */
  text: string;
  truncated: boolean;
  /** 保留范围的说明,如"显示第 100-2099 行,共 2099 行"。 */
  note?: string;
};

export type TruncationPolicy = (output: string) => Truncation;

export type TruncationLimits = { maxLines?: number; maxBytes?: number };

const DEFAULT_LINES = 2000;
const DEFAULT_BYTES = 50 * 1024;

/** 保尾:适合命令输出 —— 错误与结论通常在末尾。bash 工具的默认。 */
export function keepTail(limits: TruncationLimits = {}): TruncationPolicy {
  const { maxLines = DEFAULT_LINES, maxBytes = DEFAULT_BYTES } = limits;
  return (output) => {
    const lines = output.split("\n");
    if (fits(output, lines.length, maxLines, maxBytes)) return { text: output, truncated: false };
    let kept = lines.slice(-maxLines);
    while (bytes(kept.join("\n")) > maxBytes && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 10));
    }
    const from = lines.length - kept.length + 1;
    return {
      text: kept.join("\n"),
      truncated: true,
      note: `显示第 ${from}-${lines.length} 行,共 ${lines.length} 行`,
    };
  };
}

/** 保头:适合文件内容与列表 —— 开头是结构所在。read 工具的默认。 */
export function keepHead(limits: TruncationLimits = {}): TruncationPolicy {
  const { maxLines = DEFAULT_LINES, maxBytes = DEFAULT_BYTES } = limits;
  return (output) => {
    const lines = output.split("\n");
    if (fits(output, lines.length, maxLines, maxBytes)) return { text: output, truncated: false };
    let kept = lines.slice(0, maxLines);
    while (bytes(kept.join("\n")) > maxBytes && kept.length > 1) {
      kept = kept.slice(0, Math.floor(kept.length * 0.9));
    }
    return {
      text: kept.join("\n"),
      truncated: true,
      note: `显示第 1-${kept.length} 行,共 ${lines.length} 行`,
    };
  };
}

/** 两头保中略:适合长日志 —— 开头有启动信息,末尾有结局。 */
export function keepBothEnds(
  opts: { headLines?: number; tailLines?: number; maxBytes?: number } = {},
): TruncationPolicy {
  const { headLines = 200, tailLines = DEFAULT_LINES - 200, maxBytes = DEFAULT_BYTES } = opts;
  return (output) => {
    const lines = output.split("\n");
    if (fits(output, lines.length, headLines + tailLines, maxBytes)) {
      return { text: output, truncated: false };
    }
    const head = lines.slice(0, headLines);
    let tail = lines.slice(-tailLines);
    const gap = () => `\n……[中略 ${lines.length - head.length - tail.length} 行]……\n`;
    while (bytes(head.join("\n") + gap() + tail.join("\n")) > maxBytes && tail.length > 1) {
      tail = tail.slice(Math.ceil(tail.length / 10));
    }
    return {
      text: head.join("\n") + gap() + tail.join("\n"),
      truncated: true,
      note: `显示首 ${head.length} 行与末 ${tail.length} 行,共 ${lines.length} 行`,
    };
  };
}

/**
 * 单行长度上限(Q29):压扁超长行(压缩产物/单行 JSON),防止一行吃穿字节预算。
 * 与头尾策略正交,在策略之前应用。
 */
export function capLineLength(maxChars: number): (text: string) => string {
  return (text) =>
    text
      .split("\n")
      .map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…[行截断至 ${maxChars} 字符]` : l))
      .join("\n");
}

function fits(output: string, lineCount: number, maxLines: number, maxBytes: number): boolean {
  return lineCount <= maxLines && bytes(output) <= maxBytes;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}
