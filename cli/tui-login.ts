// 登录对话框与列表选择器:没有 key 也能进界面,在界面里选供应商、贴 key、验证、选模型。
// 两个组件都不画框线;↑↓ 选,Enter 定,Esc 退。key 输入遮罩,只露尾四位,从不上屏、不进日志。
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import { c } from "./theme.js";

export type PickRow = {
  label: string;
  note?: string;
  /** 不可选的行(只作说明)。 */
  disabled?: boolean;
  /** 高亮显示(如当前模型)。 */
  current?: boolean;
};

const UP = "\x1b[A";
const DOWN = "\x1b[B";

function isUp(data: string): boolean {
  return data === UP || data === "k";
}
function isDown(data: string): boolean {
  return data === DOWN || data === "j";
}

/** 渲染一列可选行:▸ 标当前光标并加粗,行前编号(1–9 直接按),disabled 淡显,current 泥金。 */
export function renderRows(rows: PickRow[], index: number): string[] {
  const width = Math.max(0, ...rows.map((r) => r.label.length));
  const numWidth = String(rows.length).length;
  return rows.map((r, i) => {
    const mark = i === index ? c.ink("▸") : " ";
    const num = i < 9 ? `${i + 1}.`.padStart(numWidth + 1) : " ".repeat(numWidth + 1);
    const label = r.label.padEnd(width);
    const text = r.disabled ? c.faint(label) : i === index ? c.bold(c.ink(label)) : c.ink(label);
    return `  ${mark} ${r.disabled ? c.faint(num) : c.faint(num)} ${text}${r.note ? `  ${c.faint(r.note)}` : ""}`;
  });
}

/** 数字键 1–9 直接选中对应行;不可选的行不响应。 */
export function numberedIndex(rows: PickRow[], data: string): number | undefined {
  if (!/^[1-9]$/.test(data)) return undefined;
  const i = Number(data) - 1;
  return i < rows.length && !rows[i]?.disabled ? i : undefined;
}

function nextIndex(rows: PickRow[], from: number, step: 1 | -1): number {
  let i = from;
  for (let n = 0; n < rows.length; n++) {
    i = (i + step + rows.length) % rows.length;
    if (!rows[i]?.disabled) return i;
  }
  return from;
}

/**
 * 通用列表选择器:/model 与 /models 用。
 * onPick 收到选中的行与触发键(Enter 或 d),d 的语义由调用方定(切换并设为缺省)。
 */
export class ListPicker implements Component {
  private index: number;

  constructor(
    private readonly title: string,
    private readonly rows: PickRow[],
    private readonly hint: string,
    private readonly onPick: (row: PickRow, key: "enter" | "d") => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void = () => {},
  ) {
    const current = rows.findIndex((r) => r.current && !r.disabled);
    const first = rows.findIndex((r) => !r.disabled);
    this.index = current >= 0 ? current : Math.max(0, first);
  }

  invalidate(): void {}

  render(): string[] {
    return [this.title, ...renderRows(this.rows, this.index), c.faint(`  ${this.hint}`)];
  }

  handleInput(data: string): void {
    const numbered = numberedIndex(this.rows, data);
    if (isUp(data)) this.index = nextIndex(this.rows, this.index, -1);
    else if (isDown(data)) this.index = nextIndex(this.rows, this.index, 1);
    else if (numbered !== undefined) this.index = numbered;
    else if (matchesKey(data, Key.enter) || data === "d") {
      const row = this.rows[this.index];
      if (row && !row.disabled) this.onPick(row, data === "d" ? "d" : "enter");
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    this.onChange();
  }
}

export type ProviderSummary = {
  name: string;
  protocol: string;
  /** 存放 key 的环境变量名(配置里给了才有)。 */
  env?: string;
  /** key 现在从哪来;没有就是缺。 */
  keySource?: "env" | "credentials" | "config";
  /** 配置里列出的模型名。 */
  models: string[];
};

export type LoginDeps = {
  providers(): ProviderSummary[];
  /** 用这把 key 向供应商查模型清单;抛错即 key 无效或网络不通。返回服务器上的模型名。 */
  verifyKey(providerName: string, key: string): Promise<string[]>;
  setKey(providerName: string, key: string): void;
  /** 切换到 供应商/模型;setDefault 为真时同时设为缺省。 */
  useModel(name: string, setDefault: boolean): void;
  /** 结束(成功或取消)。 */
  onDone(): void;
  onChange(): void;
};

type Step =
  | { kind: "providers"; index: number }
  | { kind: "key"; provider: ProviderSummary; buffer: string; error?: string | undefined }
  | { kind: "checking"; provider: ProviderSummary }
  | { kind: "models"; provider: ProviderSummary; rows: PickRow[]; index: number; remote: number };

/** 剥掉括号粘贴的包裹标记,只留可打印字符。 */
function pasted(data: string): string {
  return data
    .split("\x1b[200~")
    .join("")
    .split("\x1b[201~")
    .join("")
    .split("")
    .filter((ch) => ch >= " " && ch !== "\x7f")
    .join("");
}

function masked(buffer: string): string {
  if (buffer.length <= 4) return "•".repeat(buffer.length);
  return `${"•".repeat(buffer.length - 4)}${buffer.slice(-4)}`;
}

/**
 * 登录对话框:①选供应商 ②贴 key(遮罩)③用 GET /models 验证并落盘 ④选模型切过去(d 同时设缺省)。
 * 任一步 Esc 退回上一步;供应商列表上 Esc 关闭。
 */
export class LoginDialog implements Component {
  private step: Step;

  constructor(
    private readonly deps: LoginDeps,
    opts: { intro?: string; provider?: string } = {},
  ) {
    this.intro = opts.intro;
    const list = deps.providers();
    const pre = opts.provider ? list.findIndex((p) => p.name === opts.provider) : -1;
    this.step = { kind: "providers", index: Math.max(0, pre) };
    if (pre >= 0) this.step = { kind: "key", provider: list[pre] as ProviderSummary, buffer: "" };
  }

  private readonly intro: string | undefined;

  invalidate(): void {}

  render(): string[] {
    const s = this.step;
    if (s.kind === "providers") {
      const rows = this.providerRows();
      return [
        `${c.bold(c.ink("Set up a provider"))}  ${c.faint(this.intro ?? "pick a provider, paste its key, choose a model")}`,
        ...renderRows(rows, s.index),
        c.faint("  ↑↓ choose · Enter continue · Esc close (/login opens this again)"),
      ];
    }
    if (s.kind === "key") {
      return [
        `${c.bold(c.ink(s.provider.name))}  ${c.faint("paste the API key; input is masked and never shown or logged")}`,
        `  ${c.soft("key:")} ${c.ink(masked(s.buffer))}${c.faint("▏")}`,
        ...(s.error ? [`  ${c.zhu(`✗ ${s.error}`)}`] : []),
        c.faint("  Enter check and save · Esc back"),
      ];
    }
    if (s.kind === "checking") {
      return [
        `${c.bold(c.ink(s.provider.name))}  ${c.faint("checking the key with GET /models …")}`,
      ];
    }
    return [
      `${c.bold(c.ink(s.provider.name))}  ${c.soft("✓")} ${c.soft(`key saved · ${s.remote} models on the server`)}`,
      ...renderRows(s.rows, s.index),
      c.faint("  ↑↓ choose · Enter use this model · d use it and make it the default · Esc done"),
    ];
  }

  handleInput(data: string): void {
    const s = this.step;
    if (s.kind === "providers") {
      const rows = this.providerRows();
      const numbered = numberedIndex(rows, data);
      if (isUp(data)) s.index = nextIndex(rows, s.index, -1);
      else if (isDown(data)) s.index = nextIndex(rows, s.index, 1);
      else if (numbered !== undefined) s.index = numbered;
      else if (matchesKey(data, Key.enter)) {
        const provider = this.deps.providers()[s.index];
        if (provider) this.step = { kind: "key", provider, buffer: "" };
      } else if (matchesKey(data, Key.escape)) {
        this.deps.onDone();
        return;
      }
      this.deps.onChange();
      return;
    }
    if (s.kind === "key") {
      if (matchesKey(data, Key.enter)) {
        const key = s.buffer.trim();
        if (!key) {
          s.error = "the key is empty";
        } else {
          void this.check(s.provider, key);
        }
      } else if (matchesKey(data, Key.escape)) {
        this.step = { kind: "providers", index: this.indexOf(s.provider.name) };
      } else if (data === "\x7f" || data === "\b") {
        s.buffer = s.buffer.slice(0, -1);
        s.error = undefined;
      } else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) {
        s.buffer += pasted(data);
        s.error = undefined;
      }
      this.deps.onChange();
      return;
    }
    if (s.kind === "checking") return;
    const numbered = numberedIndex(s.rows, data);
    if (isUp(data)) s.index = nextIndex(s.rows, s.index, -1);
    else if (isDown(data)) s.index = nextIndex(s.rows, s.index, 1);
    else if (numbered !== undefined) s.index = numbered;
    else if (matchesKey(data, Key.enter) || data === "d") {
      const row = s.rows[s.index];
      if (row && !row.disabled) {
        this.deps.useModel(`${s.provider.name}/${row.label}`, data === "d");
        this.deps.onDone();
        return;
      }
    } else if (matchesKey(data, Key.escape)) {
      this.deps.onDone();
      return;
    }
    this.deps.onChange();
  }

  private indexOf(name: string): number {
    return Math.max(
      0,
      this.deps.providers().findIndex((p) => p.name === name),
    );
  }

  private providerRows(): PickRow[] {
    return this.deps.providers().map((p) => ({
      label: p.name,
      note: `${p.protocol}   key: ${p.keySource ? `set (${p.keySource})` : "missing"}${p.env ? `   ${p.env}` : ""}`,
    }));
  }

  private async check(provider: ProviderSummary, key: string): Promise<void> {
    this.step = { kind: "checking", provider };
    this.deps.onChange();
    let remote: string[];
    try {
      remote = await this.deps.verifyKey(provider.name, key);
    } catch (err) {
      this.step = { kind: "key", provider, buffer: key, error: (err as Error).message };
      this.deps.onChange();
      return;
    }
    this.deps.setKey(provider.name, key);
    const rows: PickRow[] = provider.models.map((m) => ({
      label: m,
      note: remote.includes(m) ? "configured" : "configured · not on the server",
    }));
    for (const m of remote) {
      if (!provider.models.includes(m)) {
        rows.push({ label: m, note: "on the server, not in config", disabled: true });
      }
    }
    const first = rows.findIndex((r) => !r.disabled);
    this.step = {
      kind: "models",
      provider,
      rows,
      index: Math.max(0, first),
      remote: remote.length,
    };
    this.deps.onChange();
  }
}
