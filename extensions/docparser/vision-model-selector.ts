/**
 * VisionModelSelectorComponent — interactive TUI for choosing the vision model
 * for document visual analysis in pi-docparser.
 *
 * Full adaptation from pi-vision-handoff's VisionModelSelectorComponent:
 *   - Bordered panel with title
 *   - Fuzzy search/filter via Input component
 *   - Scrollable list with cursor (→) and ✓ for current
 *   - Detail pane: model name, provider, reasoning capability
 *   - Footer: keybindings, model count, current selection
 *   - Keyboard: arrows, enter/ctrl+s confirm, esc/cancel, ctrl+c clear/cancel
 *
 * Key differences from vision-handoff:
 *   - Vision-capable models ONLY (text-only can't analyze document images)
 *   - No thinking controls (docparser's thinking config is separate)
 *   - "Auto" row replaces vision-handoff's "None" row
 */

import {
  Container,
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import { formatModelRef, isVisionModel } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DisplayItem {
  ref: string | null;
  provider: string;
  modelId: string;
  modelName: string;
  reasoning: boolean;
  auto?: boolean;
}

export interface VisionModelSelectorResult {
  ref: string | null;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class VisionModelSelectorComponent implements Component {
  private theme: Theme;
  private done: (result: VisionModelSelectorResult) => void;

  private allItems: DisplayItem[];
  private filteredItems: DisplayItem[];
  private selectedIndex = 0;
  private readonly maxVisible = 10;
  private searchInput: Input;
  private listContainer: Container;
  private footerText: Text;

  private currentRef: string | null;

  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    theme: Theme,
    allModels: Array<{
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }>,
    currentRef: string | null,
    done: (result: VisionModelSelectorResult) => void,
  ) {
    this.theme = theme;
    this.done = done;
    this.currentRef = currentRef;
    this.allItems = this.buildItems(allModels);
    this.filteredItems = this.allItems;

    const startIdx = this.allItems.findIndex((i) => i.ref === currentRef);
    this.selectedIndex = startIdx >= 0 ? startIdx : 0;

    this.searchInput = new Input();
    this.listContainer = new Container();
    this.footerText = new Text(this.getFooterText(), 0, 0);

    this.searchInput.onSubmit = () => {
      const item = this.filteredItems[this.selectedIndex];
      if (item) this.confirm(item);
    };

    this.updateList();
  }

  // -- Component interface --

  render(width: number): string[] {
    const lines: string[] = [];
    const accent = (s: string) => this.theme.fg("accent", s);

    lines.push(...new DynamicBorder(accent).render(width));
    lines.push("");
    lines.push(accent(this.theme.bold("Docparser — Vision Model")));
    lines.push(
      this.theme.fg("muted", "Choose which model analyzes document images (charts, diagrams, screenshots)."),
    );
    lines.push("");
    lines.push(...this.searchInput.render(width));
    lines.push("");
    lines.push(...this.listContainer.render(width));
    lines.push("");
    lines.push(...this.footerText.render(width));
    lines.push(...new DynamicBorder(accent).render(width));
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
      this.updateList();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
      this.updateList();
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) this.confirm(item);
      return;
    }

    if (matchesKey(data, Key.ctrl("s"))) {
      const item = this.filteredItems[this.selectedIndex];
      if (item) this.confirm(item);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish(true);
      return;
    }

    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue("");
        this.refresh();
      } else {
        this.finish(true);
      }
      return;
    }

    this.searchInput.handleInput(data);
    this.refresh();
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.listContainer.invalidate();
    this.footerText.invalidate();
  }

  // ── Internal ────────────────────────────────────────────────────────

  private buildItems(
    allModels: Array<{
      provider: string;
      id: string;
      name: string;
      input?: ("text" | "image")[];
      reasoning?: boolean;
    }>,
  ): DisplayItem[] {
    const items: DisplayItem[] = [
      {
        ref: null,
        provider: "",
        modelId: "auto",
        modelName: "Auto — pick best available vision model",
        reasoning: false,
        auto: true,
      },
    ];

    // Vision-capable models only — text-only models can't analyze document images.
    const visionModels = allModels.filter((m) => isVisionModel(m));
    for (const m of visionModels) {
      items.push({
        ref: formatModelRef(m.provider, m.id),
        provider: m.provider,
        modelId: m.id,
        modelName: m.name || m.id,
        reasoning: !!m.reasoning,
      });
    }

    return items;
  }

  private getFooterText(): string {
    const count = this.allItems.length - 1; // exclude Auto row
    const current = this.currentRef
      ? `current: ${this.currentRef}`
      : "current: auto";

    const parts: string[] = [
      `${keyText("tui.select.confirm")} select`,
      "ctrl+s confirm",
      "esc cancel",
      this.searchInput.getValue()
        ? `${this.filteredItems.length - 1} match`
        : `${count} vision model(s)`,
      current,
    ];

    return this.theme.fg("dim", `  ${parts.join(" · ")} `);
  }

  private refresh(): void {
    const query = this.searchInput.getValue();
    this.filteredItems = query
      ? fuzzyFilter(
          this.allItems,
          query,
          (i) => `${i.provider} ${i.modelId} ${i.ref ?? "auto"} ${i.modelName}`,
        )
      : this.allItems;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();

    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const accent = (s: string) => this.theme.fg("accent", s);
    const success = (s: string) => this.theme.fg("success", s);
    const warning = (s: string) => this.theme.fg("warning", s);

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(muted("  No matching models"), 0, 0),
      );
      this.footerText.setText(this.getFooterText());
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;

      const isSelected = i === this.selectedIndex;
      const cursor = isSelected ? accent("→ ") : "  ";

      let label: string;

      if (item.auto) {
        // "Auto" row — styled differently from models
        if (this.currentRef === null) {
          label = isSelected
            ? accent("✓ Auto (active)")
            : success("✓ Auto (active)");
        } else {
          label = isSelected
            ? accent("  Auto — pick best available")
            : warning("  Auto — pick best available");
        }
      } else {
        // Model row: modelId [provider] 🧠
        const modelLabel = isSelected ? accent(item.modelId) : item.modelId;
        const providerBadge = dim(` [${item.provider}]`);
        const reasoningMarker = item.reasoning ? success(" 🧠") : "";
        label = `${modelLabel}${providerBadge}${reasoningMarker}`;
      }

      // ✓ marker for currently configured model
      const current = (item.ref !== null && item.ref === this.currentRef)
        ? success(" ✓")
        : "";

      this.listContainer.addChild(new Text(`${cursor}${label}${current}`, 0, 0));
    }

    // Scroll indicator
    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(muted(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
      );
    }

    // ── Detail pane ────────────────────────────────────────────────

    const selected = this.filteredItems[this.selectedIndex];
    if (selected) {
      this.listContainer.addChild(new Spacer(1));
      if (selected.auto) {
        this.listContainer.addChild(
          new Text(
            muted("  Automatically picks the first available vision model from your registry."),
            0, 0,
          ),
        );
      } else {
        this.listContainer.addChild(
          new Text(muted(`  ${selected.modelName}`), 0, 0),
        );
        this.listContainer.addChild(
          new Text(
            dim(`  Provider: ${selected.provider}  ·  Model ID: ${selected.modelId}`),
            0, 0,
          ),
        );
        if (selected.reasoning) {
          this.listContainer.addChild(
            new Text(success("  🧠 Reasoning-capable — thinking can be enabled"), 0, 0),
          );
        }
      }
    }

    this.footerText.setText(this.getFooterText());
  }

  private confirm(item: DisplayItem): void {
    this.done({ ref: item.ref, cancelled: false });
  }

  private finish(cancelled: boolean): void {
    this.done({ ref: null, cancelled });
  }
}
