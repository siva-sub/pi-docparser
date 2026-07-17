/**
 * Clean model picker logic for /docparser-model.
 *
 * Uses ctx.ui.select() for both TUI and non-TUI — pi handles rendering.
 * Vision-capable models only. Clean labels with provider badges.
 */

import { findVisionModels, formatModelRef, isVisionModel, readConfig, writeConfig } from "./config.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface ShowModelPickerResult {
  ref: string | null;
  cancelled: boolean;
}

/**
 * Show the model picker. Returns the chosen ref (or null for auto),
 * or { cancelled: true } if the user aborted.
 */
export async function showModelPicker(ctx: ExtensionCommandContext): Promise<ShowModelPickerResult> {
  const cfg = readConfig();
  const allModels = ctx.modelRegistry
    .getAll()
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name, input: m.input, reasoning: m.reasoning }));

  const { vision } = findVisionModels(allModels);

  if (vision.length === 0) {
    ctx.ui.notify("No vision-capable models found. Add one with /model.", "error");
    return { ref: null, cancelled: true };
  }

  const currentRef = cfg.visionModel;
  const labels: string[] = [];
  const refs: (string | null)[] = [];

  // "Auto" option
  labels.push(currentRef === null ? "⟳ Auto ✓" : "⟳ Auto");
  refs.push(null);

  for (const m of vision) {
    const ref = formatModelRef(m.provider, m.id);
    const name = m.name || m.id;
    const reasoning = m.reasoning ? " 🧠" : "";
    const current = currentRef === ref ? " ✓" : "";
    labels.push(`${name}${reasoning}  [${ref}]${current}`);
    refs.push(ref);
  }

  const picked = await ctx.ui.select("Vision model for docparser", labels);
  if (picked === undefined) return { ref: null, cancelled: true };

  const idx = labels.indexOf(picked);
  if (idx < 0) return { ref: null, cancelled: true };

  const ref = refs[idx];
  return { ref, cancelled: false };
}
