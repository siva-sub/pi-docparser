/**
 * DocparserSettingsComponent — interactive TUI for configuring ALL docparser
 * settings with a single unified panel.
 *
 * Pattern: same as pi-vision-handoff's VisionModelSelectorComponent:
 *   - Bordered panel with title
 *   - Grouped settings list
 *   - Arrow keys navigate, enter toggles/opens sub-picker, esc saves
 *   - Footer with keybindings
 *
 * Settings grouped by:
 *   1. 📄 Parsing — DPI, OCR, max pages, format, image mode, links, small text
 *   2. 🔍 Search — case sensitivity, max results
 *   3. 📸 Screenshots — screenshot DPI
 *   4. 👁 Vision — model, cloud, DPI, candidates, threshold
 *   5. 🧠 Vision tuning — thinking, level, max tokens
 *   6. 💾 Cache — max entries
 */

import {
  Container,
  type Component,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  type PiDocparserConfig,
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  type RegistryModelEntry,
  findVisionModels,
  formatModelRef,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Setting descriptor
// ---------------------------------------------------------------------------

type SettingKind = "boolean" | "number" | "string" | "enum" | "model" | "thinkingLevel";

interface SettingDef {
  key: keyof PiDocparserConfig;
  label: string;
  kind: SettingKind;
  /** Description shown in detail pane. */
  desc: string;
  /** Enum values when kind is "enum" or "thinkingLevel". */
  options?: readonly string[];
  /** Range for number kind. */
  min?: number;
  max?: number;
  /** For model kind: list of vision-capable model refs */
  modelOptions?: string[];
}

interface SettingGroup {
  icon: string;
  label: string;
  settings: SettingDef[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DocparserSettingsResult {
  config: PiDocparserConfig;
  cancelled: boolean;
}

export class DocparserSettingsComponent implements Component {
  private theme: Theme;
  private done: (result: DocparserSettingsResult) => void;

  private config: PiDocparserConfig;
  private groups: SettingGroup[];
  /** Flat list of (groupIndex, settingIndex) pairs for navigation. */
  private flatSettings: { groupIdx: number; settingIdx: number }[] = [];
  private selectedIndex = 0;
  private readonly maxVisible = 12;
  private listContainer: Container;
  private footerText: Text;

  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; }

  /** When non-null, we're in an inline sub-picker (enum/model choice). */
  private subPicker: {
    settingKey: keyof PiDocparserConfig;
    options: string[];
    selectedIdx: number;
  } | null = null;

  /** When non-null, we're editing a number inline. */
  private numberEditor: {
    settingKey: keyof PiDocparserConfig;
    value: string;
  } | null = null;

  constructor(
    theme: Theme,
    config: PiDocparserConfig,
    allModels: Array<{
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }>,
    done: (result: DocparserSettingsResult) => void,
  ) {
    this.theme = theme;
    this.done = done;
    this.config = { ...config };

    const { vision } = findVisionModels(allModels);
    const visionRefs = vision.map((m) => formatModelRef(m.provider, m.id));

    this.groups = this.buildGroups(visionRefs);
    this.flatSettings = this.buildFlat();
    this.selectFirstSetting();

    this.listContainer = new Container();
    this.footerText = new Text(this.getFooterText(), 0, 0);

    this.updateList();
  }

  // -- Component interface --

  render(width: number): string[] {
    const lines: string[] = [];
    const accent = (s: string) => this.theme.fg("accent", s);

    lines.push(...new DynamicBorder(accent).render(width));
    lines.push("");
    lines.push(accent(this.theme.bold("Docparser — Settings")));
    lines.push(
      this.theme.fg(
        "muted",
        this.numberEditor
          ? `Editing: ${this.numberEditor.settingKey} — type value, enter to confirm, esc to cancel`
          : this.subPicker
            ? `Choose value for ${this.subPicker.settingKey} — arrows/enter to pick, esc to cancel`
            : "Arrow keys to navigate · Enter to toggle/edit · Esc to save & exit",
      ),
    );
    lines.push("");
    lines.push(...this.listContainer.render(width));
    lines.push("");
    lines.push(...this.footerText.render(width));
    lines.push(...new DynamicBorder(accent).render(width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // ── Number editor mode ──
    if (this.numberEditor) {
      if (matchesKey(data, Key.escape)) {
        this.numberEditor = null;
        this.updateList();
        return;
      }
      if (kb.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
        const def = this.findSettingDef(this.numberEditor.settingKey);
        const num = parseFloat(this.numberEditor.value);
        if (!isNaN(num) && def) {
          if (def.min !== undefined && num < def.min) {
            // clamp
          } else if (def.max !== undefined && num > def.max) {
            // clamp
          } else {
            (this.config as any)[this.numberEditor.settingKey] =
              def.kind === "number" && Number.isInteger(num) ? Math.floor(num) : num;
          }
        }
        this.numberEditor = null;
        this.updateList();
        return;
      }
      if (data === "\x7f" || data === "\b") {
        this.numberEditor.value = this.numberEditor.value.slice(0, -1);
        this.updateList();
        return;
      }
      if (data.length === 1 && /[\d.\-]/.test(data)) {
        this.numberEditor.value += data;
        this.updateList();
        return;
      }
      return;
    }

    // ── Sub-picker mode ──
    if (this.subPicker) {
      if (matchesKey(data, Key.escape)) {
        this.subPicker = null;
        this.updateList();
        return;
      }
      if (kb.matches(data, "tui.select.up")) {
        this.subPicker.selectedIdx = Math.max(0, this.subPicker.selectedIdx - 1);
        this.updateList();
        return;
      }
      if (kb.matches(data, "tui.select.down")) {
        this.subPicker.selectedIdx = Math.min(
          this.subPicker.options.length - 1,
          this.subPicker.selectedIdx + 1,
        );
        this.updateList();
        return;
      }
      if (kb.matches(data, "tui.select.confirm")) {
        const val = this.subPicker.options[this.subPicker.selectedIdx]!;
        (this.config as any)[this.subPicker.settingKey] = val;
        this.subPicker = null;
        this.updateList();
        return;
      }
      return;
    }

    // ── Main list navigation ──
    if (kb.matches(data, "tui.select.up")) {
      if (this.flatSettings.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.flatSettings.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      if (this.flatSettings.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.flatSettings.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      this.onConfirm();
      return;
    }

    if (matchesKey(data, Key.ctrl("s"))) {
      this.finish(false);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish(false);
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish(true);
      return;
    }

    // Reset to defaults
    if (matchesKey(data, Key.ctrl("r"))) {
      this.config = { ...DEFAULT_CONFIG };
      this.updateList();
      return;
    }
  }

  invalidate(): void {
    this.listContainer.invalidate();
    this.footerText.invalidate();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private buildGroups(visionRefs: string[]): SettingGroup[] {
    const modelOpts = ["⟳ Auto", ...visionRefs];
    return [
      {
        icon: "📄",
        label: "Parsing",
        settings: [
          { key: "defaultDpi", label: "Default DPI", kind: "number", desc: "DPI for document parsing and OCR (72–600).", min: 72, max: 600 },
          { key: "defaultOcrLanguage", label: "OCR Language", kind: "string", desc: "Default OCR language code (e.g. eng, deu, fra, jpn)." },
          { key: "ocrEnabled", label: "OCR Enabled", kind: "boolean", desc: "Whether OCR is enabled by default for all parses." },
          { key: "defaultMaxPages", label: "Max Pages", kind: "number", desc: "Maximum pages to parse per document (1–10000).", min: 1, max: 10000 },
          { key: "defaultOutputFormat", label: "Output Format", kind: "enum", desc: "Default output format for parsed documents.", options: ["text", "json"] },
          { key: "imageMode", label: "Image Mode", kind: "enum", desc: "How to handle images in parsed output: off (skip), placeholder (reference), embed (inline).", options: ["off", "placeholder", "embed"] },
          { key: "extractLinks", label: "Extract Links", kind: "boolean", desc: "Whether to extract hyperlinks from documents." },
          { key: "preserveSmallText", label: "Preserve Small Text", kind: "boolean", desc: "Keep very small text that would otherwise be filtered out." },
        ],
      },
      {
        icon: "🔍",
        label: "Search",
        settings: [
          { key: "caseSensitive", label: "Case Sensitive", kind: "boolean", desc: "Default for case-sensitive document search." },
          { key: "maxSearchResults", label: "Max Results", kind: "number", desc: "Maximum search hits to return (1–500).", min: 1, max: 500 },
        ],
      },
      {
        icon: "📸",
        label: "Screenshots",
        settings: [
          { key: "screenshotDpi", label: "Screenshot DPI", kind: "number", desc: "Default DPI for document screenshot rendering (72–600).", min: 72, max: 600 },
        ],
      },
      {
        icon: "👁",
        label: "Vision",
        settings: [
          { key: "visionModel", label: "Vision Model", kind: "model", desc: "Model used for document visual analysis. Auto = first available.", modelOptions: modelOpts },
          { key: "allowCloud", label: "Allow Cloud", kind: "boolean", desc: "Safety gate: must be on to send images to remote vision APIs." },
          { key: "visualDpi", label: "Visual DPI", kind: "number", desc: "DPI for screenshots sent to vision model (72–600).", min: 72, max: 600 },
          { key: "maxCandidatePages", label: "Max Candidates", kind: "number", desc: "Max pages to auto-select as visual candidates (1–32).", min: 1, max: 32 },
          { key: "visualCandidateThreshold", label: "Candidate Threshold", kind: "number", desc: "Min score (0–1) to flag a page as visual candidate. Higher = stricter.", min: 0, max: 1 },
        ],
      },
      {
        icon: "🧠",
        label: "Vision Tuning",
        settings: [
          { key: "thinking", label: "Thinking", kind: "boolean", desc: "Whether the vision model should reason before describing. Only works with reasoning-capable models." },
          { key: "thinkingLevel", label: "Thinking Level", kind: "thinkingLevel", desc: "Reasoning depth: minimal → xhigh (xhigh is most thorough but slowest).", options: [...THINKING_LEVELS] },
          { key: "maxDescriptionTokens", label: "Max Tokens", kind: "number", desc: "Cap on vision model output tokens. 0 = model default.", min: 0, max: 32000 },
        ],
      },
      {
        icon: "💾",
        label: "Cache",
        settings: [
          { key: "cacheMax", label: "Cache Size", kind: "number", desc: "Max entries in the LRU result cache (1–500).", min: 1, max: 500 },
        ],
      },
    ];
  }

  private buildFlat(): { groupIdx: number; settingIdx: number }[] {
    const flat: { groupIdx: number; settingIdx: number }[] = [];
    // We render group headers as non-selectable, but settings as selectable.
    // The flat list maps selectedIndex to (groupIdx, settingIdx).
    for (let gi = 0; gi < this.groups.length; gi++) {
      for (let si = 0; si < this.groups[gi]!.settings.length; si++) {
        flat.push({ groupIdx: gi, settingIdx: si });
      }
    }
    return flat;
  }

  private selectFirstSetting(): void {
    // Find first vision model setting to start there (or first setting)
    const idx = this.flatSettings.findIndex((f) => {
      const s = this.groups[f.groupIdx]!.settings[f.settingIdx]!;
      return s.key === "visionModel";
    });
    this.selectedIndex = idx >= 0 ? idx : 0;
  }

  private findSettingDef(key: keyof PiDocparserConfig): SettingDef | undefined {
    for (const g of this.groups) {
      for (const s of g.settings) {
        if (s.key === key) return s;
      }
    }
    return undefined;
  }

  private getFooterText(): string {
    const count = this.flatSettings.length;
    const parts: string[] = [
      `${keyText("tui.select.confirm")} toggle/edit`,
      "ctrl+s save",
      "esc save & exit",
      "ctrl+c discard",
      "ctrl+r reset all",
      `${count} settings`,
    ];
    return this.theme.fg("dim", `  ${parts.join(" · ")} `);
  }

  private onConfirm(): void {
    const flat = this.flatSettings[this.selectedIndex];
    if (!flat) return;
    const setting = this.groups[flat.groupIdx]!.settings[flat.settingIdx]!;
    const value = this.config[setting.key];

    switch (setting.kind) {
      case "boolean":
        (this.config as any)[setting.key] = !value;
        this.updateList();
        break;

      case "enum":
      case "thinkingLevel": {
        const opts = setting.options!;
        const currentIdx = opts.indexOf(String(value));
        this.subPicker = {
          settingKey: setting.key,
          options: [...opts],
          selectedIdx: currentIdx >= 0 ? currentIdx : 0,
        };
        this.updateList();
        break;
      }

      case "model": {
        const opts = setting.modelOptions!;
        const currentVal = this.config.visionModel ?? "⟳ Auto";
        const currentIdx = opts.indexOf(currentVal);
        this.subPicker = {
          settingKey: setting.key,
          options: [...opts],
          selectedIdx: currentIdx >= 0 ? currentIdx : 0,
        };
        this.updateList();
        break;
      }

      case "number": {
        this.numberEditor = {
          settingKey: setting.key,
          value: value === undefined || value === null ? "" : String(value),
        };
        this.updateList();
        break;
      }

      case "string": {
        this.numberEditor = {
          settingKey: setting.key,
          value: String(value ?? ""),
        };
        this.updateList();
        break;
      }
    }
  }

  private updateList(): void {
    this.listContainer.clear();

    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);
    const success = (s: string) => this.theme.fg("success", s);
    const warning = (s: string) => this.theme.fg("warning", s);

    // ── Sub-picker mode ──
    if (this.subPicker) {
      const sp = this.subPicker;
      this.listContainer.addChild(
        new Text(accent(`  Pick value for ${sp.settingKey}:`), 0, 0),
      );
      this.listContainer.addChild(new Spacer(1));

      const startIdx = Math.max(0, Math.min(sp.selectedIdx - 5, sp.options.length - 11));
      const endIdx = Math.min(startIdx + 11, sp.options.length);

      for (let i = startIdx; i < endIdx; i++) {
        const opt = sp.options[i]!;
        const isSel = i === sp.selectedIdx;
        const cursor = isSel ? accent("→ ") : "  ";
        const label = isSel ? accent(opt) : opt;
        this.listContainer.addChild(new Text(`${cursor}${label}`, 0, 0));
      }

      if (sp.options.length > 11) {
        this.listContainer.addChild(
          new Text(muted(`  (${sp.selectedIdx + 1}/${sp.options.length})`), 0, 0),
        );
      }

      this.footerText.setText(
        dim("  ↑↓ navigate · enter confirm · esc cancel"),
      );
      return;
    }

    // ── Number/string editor mode ──
    if (this.numberEditor) {
      const ne = this.numberEditor;
      const def = this.findSettingDef(ne.settingKey);
      this.listContainer.addChild(
        new Text(accent(`  ${def?.label ?? ne.settingKey}:`), 0, 0),
      );
      this.listContainer.addChild(
        new Text(`  ${ne.value}_`, 0, 0),
      );
      if (def?.desc) {
        this.listContainer.addChild(new Spacer(1));
        this.listContainer.addChild(new Text(muted(`  ${def.desc}`), 0, 0));
      }
      if (def?.min !== undefined && def?.max !== undefined) {
        this.listContainer.addChild(
          new Text(dim(`  Range: ${def.min}–${def.max}`), 0, 0),
        );
      }
      this.footerText.setText(
        dim("  type value · enter confirm · esc cancel"),
      );
      return;
    }

    // ── Main settings list ──

    const selFlat = this.flatSettings[this.selectedIndex];
    if (!selFlat) return;

    // Calculate visible window
    const startIdx = Math.max(0, Math.min(
      this.selectedIndex - Math.floor(this.maxVisible / 2),
      Math.max(0, this.flatSettings.length - this.maxVisible),
    ));
    const endIdx = Math.min(startIdx + this.maxVisible, this.flatSettings.length);

    let lastGroupIdx = -1;

    for (let fi = startIdx; fi < endIdx; fi++) {
      const flat = this.flatSettings[fi];
      if (!flat) continue;

      // Group header when entering new group
      if (flat.groupIdx !== lastGroupIdx) {
        if (lastGroupIdx >= 0) this.listContainer.addChild(new Spacer(1));
        const g = this.groups[flat.groupIdx]!;
        this.listContainer.addChild(
          new Text(accent(this.theme.bold(`  ${g.icon} ${g.label}`)), 0, 0),
        );
        lastGroupIdx = flat.groupIdx;
      }

      const setting = this.groups[flat.groupIdx]!.settings[flat.settingIdx]!;
      const value = this.config[setting.key];
      const isSelected = fi === this.selectedIndex;

      const cursor = isSelected ? accent("→ ") : "  ";
      const label = isSelected ? accent(setting.label) : setting.label;
      const valStr = this.formatValue(setting, value);
      const valDisplay = isSelected ? accent(valStr) : dim(valStr);

      // Show if value differs from default
      const defaultVal = DEFAULT_CONFIG[setting.key];
      const isModified = JSON.stringify(value) !== JSON.stringify(defaultVal);
      const modMarker = isModified ? success(" ●") : "  ";

      this.listContainer.addChild(
        new Text(`${cursor}${label}${modMarker}  ${valDisplay}`, 0, 0),
      );
    }

    // Detail pane for selected setting
    const selSetting = this.groups[selFlat.groupIdx]!.settings[selFlat.settingIdx]!;
    this.listContainer.addChild(new Spacer(1));
    this.listContainer.addChild(
      new Text(muted(`  ${selSetting.desc}`), 0, 0),
    );
    const defaultVal = DEFAULT_CONFIG[selSetting.key];
    const isModified = JSON.stringify(this.config[selSetting.key]) !== JSON.stringify(defaultVal);
    if (isModified) {
      this.listContainer.addChild(
        new Text(
          dim(`  Default: ${this.formatValue(selSetting, defaultVal)}`),
          0, 0,
        ),
      );
    }

    // Scroll indicator
    if (startIdx > 0 || endIdx < this.flatSettings.length) {
      this.listContainer.addChild(
        new Text(muted(`  (${this.selectedIndex + 1}/${this.flatSettings.length})`), 0, 0),
      );
    }

    this.footerText.setText(this.getFooterText());
  }

  private formatValue(def: SettingDef, value: unknown): string {
    if (value === null || value === undefined) {
      if (def.key === "maxDescriptionTokens") return "model default";
      if (def.key === "visionModel") return "⟳ Auto";
      return "—";
    }
    switch (def.kind) {
      case "boolean":
        return value ? "✓ on" : "✗ off";
      case "number":
        return String(value);
      case "string":
        return String(value);
      case "enum":
      case "thinkingLevel":
        return String(value);
      case "model": {
        const v = String(value);
        // Truncate long model refs for display
        return v.length > 30 ? v.slice(0, 27) + "..." : v;
      }
      default:
        return String(value);
    }
  }

  private finish(cancelled: boolean): void {
    this.done({ config: { ...this.config }, cancelled });
  }
}
