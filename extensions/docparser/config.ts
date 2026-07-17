/**
 * Persistent configuration for pi-docparser.
 *
 * Mirrors the pattern used by pi-vision-handoff: config lives at
 * ~/.pi/agent/extensions/pi-docparser.json, is read on extension load,
 * and is merged with environment variable overrides at tool-execution time.
 *
 * Priorities (highest to lowest):
 *   1. Per-call tool params
 *   2. Environment variables (PI_DOCPARSER_VISUAL_*)
 *   3. Persisted config file (~/.pi/agent/extensions/pi-docparser.json)
 *   4. Auto-select from pi model registry (for vision model)
 *   5. Active pi model (fallback)
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_SUBDIR = "extensions";
export const CONFIG_FILENAME = "pi-docparser.json";

export function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_SUBDIR, CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PiDocparserConfig {
  // -- Vision model selection --
  /** Preferred vision model as "provider/id". null = auto-select from registry. */
  visionModel: string | null;
  /** When true and visionModel is null, auto-pick the first available vision
   *  model from pi's model registry. When false and visionModel is null, the
   *  tool falls back to the active session model only. */
  autoSelectVisionModel: boolean;

  // -- Quality & safety --
  /** Screenshot DPI for visual analysis (72–600). */
  visualDpi: number;
  /** Cloud-call safety gate. */
  allowCloud: boolean;
  /** Max pages to auto-select as visual candidates. */
  maxCandidatePages: number;
  /** Threshold (0–1) for auto-detecting visual-candidate pages. */
  visualCandidateThreshold: number;

  // -- Vision model tuning --
  /** Whether the vision model should reason before describing. */
  thinking: boolean;
  /** Reasoning depth when thinking is on. */
  thinkingLevel: ThinkingLevel;
  /** Cap on vision model output tokens. undefined = model default. */
  maxDescriptionTokens: number | undefined;

  // -- Cache --
  /** Max entries in the visual-description LRU cache. */
  cacheMax: number;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export function isThinkingLevel(level: unknown): level is ThinkingLevel {
  return typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level);
}

export const DEFAULT_CONFIG: PiDocparserConfig = {
  visionModel: null,
  autoSelectVisionModel: true,
  visualDpi: 220,
  allowCloud: false,
  maxCandidatePages: 6,
  visualCandidateThreshold: 0.4,
  thinking: false,
  thinkingLevel: "medium",
  maxDescriptionTokens: undefined,
  cacheMax: 50,
};

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

/** Split a "provider/id" reference. Returns null on malformed input. */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) return null;
  const provider = trimmed.slice(0, slashIndex);
  const id = trimmed.slice(slashIndex + 1);
  if (!provider || !id) return null;
  return { provider, id };
}

/** Format a provider/id reference string. */
export function formatModelRef(provider: string, id: string): string {
  return `${provider}/${id}`;
}

/** Whether a model declares image input support. */
export function isVisionModel(
  model: { input?: ("text" | "image")[] } | undefined | null,
): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/** Shape of a model entry from pi's model registry. */
export interface RegistryModelEntry {
  provider: string;
  id: string;
  name: string;
  input?: ("text" | "image")[];
  reasoning?: boolean;
}

// ---------------------------------------------------------------------------
// Config IO
// ---------------------------------------------------------------------------

export function normalizeConfig(raw: unknown): PiDocparserConfig {
  const base: PiDocparserConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.visionModel === "string") {
    base.visionModel = parseModelRef(obj.visionModel) ? obj.visionModel.trim() : null;
  } else if (obj.visionModel === null) {
    base.visionModel = null;
  }
  if (typeof obj.autoSelectVisionModel === "boolean") base.autoSelectVisionModel = obj.autoSelectVisionModel;

  if (typeof obj.visualDpi === "number" && Number.isFinite(obj.visualDpi)) {
    const dpi = Math.floor(obj.visualDpi);
    if (dpi >= 72 && dpi <= 600) base.visualDpi = dpi;
  }
  if (typeof obj.allowCloud === "boolean") base.allowCloud = obj.allowCloud;

  if (typeof obj.maxCandidatePages === "number" && Number.isFinite(obj.maxCandidatePages)) {
    const n = Math.floor(obj.maxCandidatePages);
    if (n >= 1 && n <= 32) base.maxCandidatePages = n;
  }
  if (typeof obj.visualCandidateThreshold === "number" && Number.isFinite(obj.visualCandidateThreshold)) {
    const t = obj.visualCandidateThreshold;
    if (t >= 0 && t <= 1) base.visualCandidateThreshold = t;
  }

  if (typeof obj.thinking === "boolean") base.thinking = obj.thinking;
  if (isThinkingLevel(obj.thinkingLevel)) base.thinkingLevel = obj.thinkingLevel;

  if (typeof obj.maxDescriptionTokens === "number" && Number.isFinite(obj.maxDescriptionTokens) && obj.maxDescriptionTokens > 0) {
    base.maxDescriptionTokens = Math.floor(obj.maxDescriptionTokens);
  }

  if (typeof obj.cacheMax === "number" && Number.isFinite(obj.cacheMax) && obj.cacheMax > 0) {
    base.cacheMax = Math.floor(obj.cacheMax);
  }

  return base;
}

export function readConfig(): PiDocparserConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(path, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: PiDocparserConfig): string {
  const path = getConfigPath();
  const dir = join(getAgentDir(), CONFIG_SUBDIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Find all vision-capable models from a model registry snapshot.
 * Vision-capable models (👁) are listed first, then text-only.
 */
export function findVisionModels(
  allModels: readonly RegistryModelEntry[],
): { vision: RegistryModelEntry[]; textOnly: RegistryModelEntry[] } {
  const vision: RegistryModelEntry[] = [];
  const textOnly: RegistryModelEntry[] = [];
  for (const m of allModels) {
    if (isVisionModel(m)) {
      vision.push(m);
    } else {
      textOnly.push(m);
    }
  }
  return { vision, textOnly };
}

/**
 * Resolve a "provider/id" ref to the specific model entry from the registry.
 */
export function resolveModelRef(
  allModels: readonly RegistryModelEntry[],
  ref: string,
): RegistryModelEntry | null {
  const parsed = parseModelRef(ref);
  if (!parsed) return null;
  return allModels.find((m) => m.provider === parsed.provider && m.id === parsed.id) ?? null;
}
