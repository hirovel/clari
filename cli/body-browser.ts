// 正文浏览模块:只管理块的选择、展开与宽度缓存,不读取会话、不编辑上下文。
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { c, G, selectedText } from "./theme.js";

export type BodyBlock = {
  divider?: string;
  /** 同一调用的参数与证据共用身份;只用于显示,不写入会话。 */
  group?: { id: string; title: string; compactTitle?: string };
  id: string;
  title: string;
  meta: string;
  preview: string;
  /** 展开时才生成或读取正文,折叠列表不触发它。 */
  lines: () => string[];
  /** 正文变化时必须变化;与宽度一起决定排版缓存是否可用。 */
  version: unknown;
};

function wrapBodyLine(line: string, width: number): string[] {
  // 超长 ASCII 原文按列切片,避免逐字分词;Unicode/ANSI 继续使用终端的宽度规则。
  if (line.length > 4096 && /^[\x20-\x7e]+$/.test(line)) {
    const lines: string[] = [];
    for (let i = 0; i < line.length; i += width) lines.push(line.slice(i, i + width));
    return lines;
  }
  return wrapTextWithAnsi(line, width);
}

export class BodyBrowser {
  private key = "";
  private selected = 0;
  private expanded = new Set<string>();
  private blocks: BodyBlock[] = [];
  private reveal = true;
  private formatted = new Map<string, { version: unknown; width: number; lines: string[] }>();

  set(key: string, blocks: BodyBlock[]): void {
    const selectedId = this.blocks[this.selected]?.id;
    if (key === this.key && selectedId) {
      const next = blocks.findIndex((block) => block.id === selectedId);
      if (next >= 0 && next !== this.selected) {
        this.selected = next;
        this.reveal = true;
      }
    }
    if (key !== this.key) {
      this.key = key;
      this.selected = 0;
      this.expanded.clear();
      this.formatted.clear();
      this.reveal = true;
    }
    this.blocks = blocks;
    this.selected = Math.max(0, Math.min(this.selected, blocks.length - 1));
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down))
      this.selected = Math.min(this.blocks.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end)) this.selected = Math.max(0, this.blocks.length - 1);
    else if (matchesKey(data, Key.enter)) {
      const item = this.blocks[this.selected];
      if (item) {
        if (this.expanded.has(item.id)) this.expanded.delete(item.id);
        else this.expanded.add(item.id);
      }
    } else return false;
    this.reveal = true;
    return true;
  }

  render(width: number): {
    lines: string[];
    focus?: number;
    action: string;
    position: string;
    selected: string;
    context?: string;
  } {
    const lines: string[] = [];
    const groupTitle = (group: NonNullable<BodyBlock["group"]>) =>
      truncateToWidth(
        group.compactTitle && visibleWidth(group.title) > width ? group.compactTitle : group.title,
        width,
        "…",
      );
    let focus = 0;
    for (const [i, block] of this.blocks.entries()) {
      const selected = i === this.selected;
      const open = this.expanded.has(block.id);
      if (selected) focus = lines.length;
      if (block.group && block.group.id !== this.blocks[i - 1]?.group?.id)
        lines.push(c.soft(truncateToWidth(`  ${groupTitle(block.group)}`, width, "…")));
      if (block.divider)
        lines.push(c.faint(truncateToWidth(`── ${block.divider} ${"─".repeat(width)}`, width, "")));
      const title = `${selected ? G.cursor : " "} [${open ? "−" : "+"}] ${block.title}`;
      lines.push(
        selected
          ? selectedText(truncateToWidth(title, width, "…"))
          : c.ink(truncateToWidth(title, width, "…")),
      );
      lines.push(c.soft(truncateToWidth(`    ${block.meta}`, width, "…")));
      if (open) {
        let cached = this.formatted.get(block.id);
        if (!cached || cached.version !== block.version || cached.width !== width) {
          cached = {
            version: block.version,
            width,
            lines: block
              .lines()
              .flatMap((line) => wrapBodyLine(line, Math.max(1, width - 4)).map((l) => `    ${l}`)),
          };
          this.formatted.set(block.id, cached);
        }
        for (const line of cached.lines) lines.push(line);
      } else lines.push(c.faint(truncateToWidth(`    ${block.preview || "(empty)"}`, width, "…")));
      lines.push("");
    }
    const reveal = this.reveal;
    this.reveal = false;
    const group = this.blocks[this.selected]?.group;
    return {
      lines,
      ...(reveal && { focus }),
      action: this.expanded.has(this.blocks[this.selected]?.id ?? "") ? "collapse" : "expand",
      position: `${this.blocks.length ? this.selected + 1 : 0}/${this.blocks.length} blocks`,
      selected: this.blocks[this.selected]?.title ?? "No block selected",
      ...(group && { context: groupTitle(group) }),
    };
  }
}
