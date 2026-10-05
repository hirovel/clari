// 登录对话框与列表选择器:没有 key 也能进界面,在界面里选供应商、贴 key、验证、选模型。
// 两个组件都不画框线;↑↓ 选,Enter 定,Esc 退。key 输入遮罩,只露尾四位,从不上屏、不进日志。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ModelConfig } from "../src/config.js";
import { errorMessage } from "../src/providers/errors.js";
import type { ProviderSummary } from "./model-settings.js";
import { describeInferred, type Inferred } from "./registry.js";
import { c, G, selectedText } from "./theme.js";
import { cleanPasteText, printableInput } from "./tui-format.js";

export type PickRow = {
  label: string;
  note?: string;
  /** 不可选的行(只作说明)。 */
  disabled?: boolean;
  /** 高亮显示(如当前模型)。 */
  current?: boolean;
};

export const SAVE_MODEL_DEFAULT = "Use and save as default";

/** 登录与模型菜单共用显式动作,切换和保存作用域不靠隐藏键区分。 */
export function modelUseRows(): PickRow[] {
  return [
    { label: "Use for this session", note: "Saved defaults stay unchanged." },
    { label: SAVE_MODEL_DEFAULT, note: "Also use this model for future starts." },
  ];
}

/** 渲染一列可选行:› 标当前光标并泥金加粗,行前编号(1–9 直接按),disabled 淡显,current 泥金。 */
function renderRows(rows: PickRow[], index: number): string[] {
  const width = Math.max(0, ...rows.map((r) => visibleWidth(r.label)));
  const numWidth = String(rows.length).length;
  return rows.map((r, i) => {
    const mark = i === index ? selectedText(G.cursor) : " ";
    const num = i < 9 ? `${i + 1}.`.padStart(numWidth + 1) : " ".repeat(numWidth + 1);
    const label = r.label + " ".repeat(Math.max(0, width - visibleWidth(r.label)));
    const text = r.disabled ? c.faint(label) : i === index ? selectedText(label) : c.ink(label);
    return `  ${mark} ${i === index ? selectedText(num) : c.faint(num)} ${text}${r.note ? `  ${c.faint(r.note)}` : ""}`;
  });
}

/** 数字键 1–9 直接选中对应行;不可选的行不响应。 */
function numberedIndex(rows: PickRow[], data: string): number | undefined {
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
 * 数字只选择,Enter 执行;普通字母不触发动作。
 */
export class ListPicker implements Component {
  private index: number;
  private detailOffset = 0;
  private detailPage = 1;
  private detailTotal = 0;
  private error = "";

  constructor(
    private readonly title: string,
    private readonly rows: PickRow[],
    private readonly hint: string,
    private readonly onPick: (row: PickRow) => void,
    private readonly onCancel: () => void,
    private readonly onChange: () => void = () => {},
    private readonly height: () => number = () => 24,
  ) {
    const current = rows.findIndex((r) => r.current && !r.disabled);
    const first = rows.findIndex((r) => !r.disabled);
    this.index = current >= 0 ? current : Math.max(0, first);
  }

  invalidate(): void {}

  /** 失败留在当前选择步骤,全文沿用详情分页。 */
  showError(error: string): void {
    this.error = error;
    this.detailOffset = 0;
    this.onChange();
  }

  render(width = 80): string[] {
    const inner = Math.max(1, width - 2);
    const height = Math.max(1, this.height() - 2);
    const selected = this.rows[this.index];
    const wrap = (text: string) =>
      text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
    const details = wrap(
      [this.error && c.zhu(this.error), selected?.label ?? "No options", selected?.note]
        .filter(Boolean)
        .join("\n"),
    );
    this.detailTotal = details.length;
    const hints = wrap(height < 10 ? "↑↓ choose · Enter select · Esc back" : this.hint);
    const pager = (end: number) => `PgUp/PgDn details · ${end}/${this.detailTotal}`;
    const footerHeight = hints.length + wrap(pager(this.detailTotal)).length;
    if (height < 4 + footerHeight)
      return [
        this.error ? c.zhu(this.error) : (selected?.label ?? "No options"),
        "Enter select · Esc back",
      ]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    const bodyHeight = Math.max(2, height - 2 - footerHeight);
    const listPage = Math.min(this.rows.length, Math.max(1, Math.floor(bodyHeight / 2)));
    this.detailPage = Math.max(1, bodyHeight - listPage);
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - this.detailPage));
    const start = Math.min(
      Math.max(0, this.index - Math.floor(listPage / 2)),
      Math.max(0, this.rows.length - listPage),
    );
    const visible = details.slice(this.detailOffset, this.detailOffset + this.detailPage);
    // 列表只负责定位,原值在详情中完整换行;分页不改变选项或确认行为。
    return [
      truncateToWidth(this.title, width),
      ...renderRows(this.rows, this.index)
        .slice(start, start + listPage)
        .map((line) => truncateToWidth(line, width)),
      c.faint(
        truncateToWidth(
          `Selected ${this.rows.length ? this.index + 1 : 0}/${this.rows.length}`,
          width,
        ),
      ),
      ...visible.map((line) => ` ${line}`),
      ...Array<string>(this.detailPage - visible.length).fill(""),
      ...hints.map((line) => c.faint(` ${line}`)),
      ...wrap(pager(Math.min(details.length, this.detailOffset + this.detailPage))).map((line) =>
        c.faint(` ${line}`),
      ),
    ];
  }

  handleInput(data: string): void {
    const previous = this.index;
    const numbered = numberedIndex(this.rows, data);
    if (matchesKey(data, Key.up)) this.index = nextIndex(this.rows, this.index, -1);
    else if (matchesKey(data, Key.down)) this.index = nextIndex(this.rows, this.index, 1);
    else if (numbered !== undefined) this.index = numbered;
    else if (matchesKey(data, Key.pageUp))
      this.detailOffset = Math.max(0, this.detailOffset - this.detailPage);
    else if (matchesKey(data, Key.pageDown))
      this.detailOffset = Math.min(
        Math.max(0, this.detailTotal - this.detailPage),
        this.detailOffset + this.detailPage,
      );
    else if (matchesKey(data, Key.enter)) {
      const row = this.rows[this.index];
      if (row && !row.disabled) this.onPick(row);
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel();
      return;
    }
    if (previous !== this.index) {
      this.detailOffset = 0;
      this.error = "";
    }
    this.onChange();
  }
}

export type LoginDeps = {
  providers(): ProviderSummary[];
  /** 用这把 key 查供应商模型清单;失败可能来自凭据、接口或网络。返回服务器上的模型名。 */
  verifyKey(providerName: string, key: string, signal?: AbortSignal): Promise<string[]>;
  setKey(providerName: string, key: string, verified: boolean): void;
  /** 给配置里没有的模型推出配置(带出处);有它,服务器上多出来的模型就可选。 */
  describeModel?(providerName: string, modelId: string): Promise<Inferred>;
  /** 把模型写进配置。 */
  addModel?(providerName: string, model: ModelConfig): void;
  /** 切换到 供应商/模型;setDefault 为真时同时设为缺省。 */
  useModel(name: string, setDefault: boolean): void;
  /** 结束(成功或取消)。 */
  onDone(): void;
  onChange(): void;
  height?(): number;
};

type Step =
  | { kind: "providers" | "models"; picker: ListPicker }
  | {
      kind: "key";
      provider: ProviderSummary;
      buffer: string;
      error?: string | undefined;
      allowUnverified?: boolean;
    }
  | { kind: "checking"; provider: ProviderSummary; buffer: string; controller: AbortController };

/** 输入只显示遮罩与尾四位。 */
function masked(buffer: string, width: number): string {
  if (buffer.length <= 4) return "•".repeat(buffer.length);
  return `${"•".repeat(Math.min(buffer.length - 4, Math.max(0, width - 4)))}${buffer.slice(-4)}`;
}

/**
 * 登录对话框:①选供应商 ②贴 key(遮罩)③用 GET /models 验证并落盘 ④选模型切过去(d 同时设缺省)。
 * 任一步 Esc 退回上一步;供应商列表上 Esc 关闭。
 */
export class LoginDialog implements Component {
  private step: Step;
  private closed = false;
  private errorOffset = 0;
  private errorPage = 1;
  private errorTotal = 0;

  constructor(
    private readonly deps: LoginDeps,
    opts: { intro?: string; provider?: string } = {},
  ) {
    this.intro = opts.intro;
    const list = deps.providers();
    const provider = list.find((p) => p.name === opts.provider);
    this.step = provider
      ? { kind: "key", provider, buffer: "" }
      : this.providerStep(undefined, list);
  }

  private readonly intro: string | undefined;

  invalidate(): void {}

  /** 视图关闭后,验证的迟到结果不能保存凭据或切换模型。 */
  cancel(): void {
    this.closed = true;
    if (this.step.kind === "checking") this.step.controller.abort();
  }

  render(width = 80): string[] {
    const s = this.step;
    if (s.kind === "providers" || s.kind === "models") return s.picker.render(width);
    const height = Math.max(1, (this.deps.height?.() ?? 24) - 2);
    const wrap = (text: string) =>
      text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 2)));
    if (s.kind === "key") {
      const errors = s.error ? wrap(`✗ ${s.error}`) : [];
      this.errorTotal = errors.length;
      const footer = wrap("Enter check and save · Esc back");
      if (s.error) footer.push(...wrap(`PgUp/PgDn error · ${errors.length} lines`));
      if (s.allowUnverified && s.buffer.trim())
        footer.push(...wrap("Ctrl+S save without verification"));
      const input = truncateToWidth(
        ` ${c.soft("key:")} ${c.ink(masked(s.buffer, Math.max(0, width - 7)))}${c.faint("▏")}`,
        width,
      );
      if (height < 3 + footer.length) {
        this.errorPage = Math.max(1, height - 3);
        this.errorOffset = Math.min(this.errorOffset, Math.max(0, errors.length - this.errorPage));
        const compact = s.error
          ? [
              input,
              ...errors
                .slice(this.errorOffset, this.errorOffset + this.errorPage)
                .map((line) => c.zhu(line)),
              s.allowUnverified ? "Enter retry · Ctrl+S save" : "Enter retry",
              "PgUp/PgDn · Esc back",
            ]
          : [input, "Enter check · Esc back"];
        return compact.slice(0, height).map((line) => truncateToWidth(line, width));
      }
      this.errorPage = Math.max(1, height - 2 - footer.length);
      this.errorOffset = Math.min(this.errorOffset, Math.max(0, errors.length - this.errorPage));
      return [
        truncateToWidth(
          `${c.bold(c.ink(s.provider.name))}  ${c.faint("paste the API key; input is masked and never shown or logged")}`,
          width,
        ),
        input,
        ...errors
          .slice(this.errorOffset, this.errorOffset + this.errorPage)
          .map((line) => ` ${c.zhu(line)}`),
        ...footer.map((line) => ` ${c.faint(line)}`),
      ];
    }
    if (s.kind === "checking") {
      return [
        ...wrap(`${s.provider.name}  checking the key with GET /models …`).slice(
          0,
          Math.max(0, height - 1),
        ),
        truncateToWidth(c.faint("Esc cancel verification and return"), width),
      ];
    }
    return [];
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const s = this.step;
    if (s.kind === "providers" || s.kind === "models") {
      s.picker.handleInput(data);
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
        this.step = this.providerStep(s.provider.name);
      } else if (matchesKey(data, Key.ctrl("s")) && s.allowUnverified && s.buffer.trim()) {
        try {
          this.saveAndSelect(
            s.provider,
            s.buffer.trim(),
            s.provider.models.map((label) => ({ label })),
            undefined,
          );
        } catch (error) {
          this.keyFailure(s.provider, s.buffer.trim(), error, true);
        }
      } else if (matchesKey(data, Key.backspace) || data === "\b") {
        s.buffer = Array.from(s.buffer).slice(0, -1).join("");
        s.error = undefined;
        s.allowUnverified = false;
      } else if (matchesKey(data, Key.pageUp)) {
        this.errorOffset = Math.max(0, this.errorOffset - this.errorPage);
      } else if (matchesKey(data, Key.pageDown)) {
        this.errorOffset = Math.min(
          Math.max(0, this.errorTotal - this.errorPage),
          this.errorOffset + this.errorPage,
        );
      } else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) {
        s.buffer += printableInput(data);
        s.error = undefined;
        s.allowUnverified = false;
      }
      this.deps.onChange();
      return;
    }
    if (s.kind === "checking") {
      if (matchesKey(data, Key.escape)) {
        s.controller.abort();
        this.step = { kind: "key", provider: s.provider, buffer: s.buffer };
        this.deps.onChange();
      }
      return;
    }
  }

  private providerStep(current?: string, providers = this.deps.providers()): Step {
    return {
      kind: "providers",
      picker: new ListPicker(
        `${c.bold(c.ink("Set up a provider"))}${this.intro ? `  ${c.faint(this.intro)}` : ""}`,
        providers.map((p) => ({
          label: p.name,
          current: p.name === current,
          note: `${p.protocol}   ${p.keySource ? `key: ${p.keySource}` : "no key"}${p.env ? `   ${p.env}` : ""}`,
        })),
        "↑↓ choose · Enter continue · Esc close (/login opens this again)",
        (row) => {
          const provider = providers.find((p) => p.name === row.label);
          if (provider) this.step = { kind: "key", provider, buffer: "" };
          this.deps.onChange();
        },
        () => this.deps.onDone(),
        () => this.deps.onChange(),
        () => this.deps.height?.() ?? 24,
      ),
    };
  }

  private async check(provider: ProviderSummary, key: string): Promise<void> {
    const checking: Extract<Step, { kind: "checking" }> = {
      kind: "checking",
      provider,
      buffer: key,
      controller: new AbortController(),
    };
    this.errorOffset = 0;
    this.step = checking;
    this.deps.onChange();
    let verified = false;
    try {
      const remote = await this.deps.verifyKey(provider.name, key, checking.controller.signal);
      if (this.closed || this.step !== checking) return;
      verified = true;
      const rows: PickRow[] = provider.models.map((m) => ({
        label: m,
        ...(remote.includes(m) ? {} : { note: "not on the server" }),
      }));
      // 服务器上多出来的:能推出配置就可选,行上写窗口、价格与出处;推不出就只列出。
      const inferred = new Map<string, ModelConfig>();
      const extra = remote.filter((m) => !provider.models.includes(m));
      if (this.deps.describeModel && this.deps.addModel) {
        const described = await Promise.all(
          extra.map((m) => this.deps.describeModel?.(provider.name, m)),
        );
        if (this.closed || this.step !== checking) return;
        extra.forEach((m, i) => {
          const d = described[i];
          if (d) {
            inferred.set(m, d.model);
            rows.push({ label: m, note: `not in config · ${describeInferred(d)}` });
          } else rows.push({ label: m, note: "not in config", disabled: true });
        });
      } else for (const m of extra) rows.push({ label: m, note: "not in config", disabled: true });
      this.saveAndSelect(provider, key, rows, remote.length, inferred);
      this.deps.onChange();
    } catch (err) {
      if (this.closed || this.step !== checking) return;
      this.keyFailure(provider, key, err, !verified);
      this.deps.onChange();
    }
  }

  private keyFailure(
    provider: ProviderSummary,
    key: string,
    error: unknown,
    allowUnverified: boolean,
  ): void {
    // 供应商可能在错误正文中回显凭据;先去除本次输入,再清除终端控制序列。
    const message = errorMessage(error);
    this.errorOffset = 0;
    this.step = {
      kind: "key",
      provider,
      buffer: key,
      error: cleanPasteText(message.replaceAll(key, "[redacted]")),
      allowUnverified,
    };
  }

  private saveAndSelect(
    provider: ProviderSummary,
    key: string,
    rows: PickRow[],
    verifiedModels: number | undefined,
    inferred = new Map<string, ModelConfig>(),
  ): void {
    const verified = verifiedModels !== undefined;
    this.deps.setKey(provider.name, key, verified);
    const status = verified ? `${verifiedModels} models on the server` : "not verified";
    const picker = new ListPicker(
      `${c.bold(c.ink(provider.name))}  ${c.soft("key saved")} · ${verified ? c.soft(status) : c.zhu(status)}`,
      rows,
      "↑↓ choose · Enter actions · Esc done",
      (row) => {
        const actions = new ListPicker(
          `${provider.name}/${row.label}`,
          modelUseRows(),
          "↑↓ choose · Enter apply · Esc back",
          (action) => {
            try {
              const add = inferred.get(row.label);
              if (add) this.deps.addModel?.(provider.name, add);
              this.deps.useModel(
                `${provider.name}/${row.label}`,
                action.label === SAVE_MODEL_DEFAULT,
              );
              this.deps.onDone();
            } catch (error) {
              const message = errorMessage(error);
              actions.showError(cleanPasteText(message.replaceAll(key, "[redacted]")));
            }
          },
          () => {
            this.step = { kind: "models", picker };
            this.deps.onChange();
          },
          () => this.deps.onChange(),
          () => this.deps.height?.() ?? 24,
        );
        this.step = { kind: "models", picker: actions };
        this.deps.onChange();
      },
      () => this.deps.onDone(),
      () => this.deps.onChange(),
      () => this.deps.height?.() ?? 24,
    );
    this.step = { kind: "models", picker };
  }
}
