import { completeSimple, type Static, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_MAX_PAGES } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget, resolveScreenshotSelection } from "./input.ts";
import { getProvidedRemovedV1Options, getRemovedV1OptionsMessage } from "./liteparse-config.ts";
import { loadLiteParseModule } from "./liteparse-module.ts";
import {
  loadVisualAnalysisConfig,
  loadMergedConfig,
  isLocalBaseUrl,
  isRemoteVisualTarget,
  validateVisualAnalysisConfig,
} from "./visual-config.ts";
import { selectCandidatePageNumbers, toComplexityPage } from "./complexity.ts";
import { DocumentVisualAnalyzeSchema } from "./visual-schema.ts";
import { runVisualAnalysis, describeFinding, summarizeConfig } from "./visual-runner.ts";
import type { DocumentVisualAnalyzeDetails } from "./visual-tool-types.ts";
import { maskSecret, normalizeRemoteUrl } from "./util.ts";
import { VISUAL_ANALYSIS_SYSTEM_PROMPT, buildVisualAnalysisUserText } from "./visual-client.ts";
import { VisionModelSelectorComponent, type VisionModelSelectorResult } from "./vision-model-selector.ts";
import { DocparserSettingsComponent, type DocparserSettingsResult } from "./settings-component.ts";
import {
  type PiDocparserConfig,
  readConfig,
  writeConfig,
  findVisionModels,
  resolveModelRef,
  isVisionModel,
  isThinkingLevel,
  formatModelRef,
} from "./config.ts";

type DocumentVisualAnalyzeParams = Static<typeof DocumentVisualAnalyzeSchema>;

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildFriendlyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("LibreOffice is not installed") ||
    message.includes("ImageMagick is not installed")
  ) {
    return appendDoctorHint(message);
  }
  return `Document visual analysis failed: ${message}`;
}

/**
 * Resolve a vision-capable model in priority order:
 *   1. Per-call params (baseUrl + model)
 *   2. Environment variables (PI_DOCPARSER_VISUAL_*)
 *   3. Persisted config (visionModel ref → registry lookup)
 *   4. Auto-select first vision model from registry
 *   5. Active pi session model (if image-capable)
 *
 * Explicit endpoint (tiers 1-2) uses an OpenAI-compatible client.
 * Registry-resolved models (tiers 3-5) use Pi's provider-agnostic SDK.
 */
type ResolvedVisualModel =
  | {
      kind: "openai-compatible";
      baseUrl: string;
      model: string;
      apiKey: string | undefined;
      source: string;
    }
  | {
      kind: "pi";
      baseUrl: string;
      model: string;
      apiKey: string | undefined;
      headers: Record<string, string> | undefined;
      piModel: Model<Api>;
      source: string;
    };

async function resolveVisualModel(
  ctx: ExtensionContext,
  params: DocumentVisualAnalyzeParams,
  envConfig: ReturnType<typeof loadVisualAnalysisConfig>,
  persistedConfig: PiDocparserConfig,
): Promise<ResolvedVisualModel | null> {
  // Tier 1: Per-call params
  const hasCallOverride = params.baseUrl !== undefined || params.model !== undefined;
  if (hasCallOverride) {
    if (!params.baseUrl || !params.model) {
      throw new Error("Per-call visual configuration requires both baseUrl and model.");
    }
    return {
      kind: "openai-compatible",
      baseUrl: params.baseUrl,
      model: params.model,
      apiKey: params.apiKey,
      source: "per-call params",
    };
  }

  // Tier 2: Environment variables
  const hasEnvOverride = envConfig.baseUrl !== undefined || envConfig.model !== undefined;
  if (hasEnvOverride) {
    if (!envConfig.baseUrl || !envConfig.model) {
      throw new Error(
        "PI_DOCPARSER_VISUAL_BASE_URL and PI_DOCPARSER_VISUAL_MODEL must be configured together.",
      );
    }
    return {
      kind: "openai-compatible",
      baseUrl: envConfig.baseUrl,
      model: envConfig.model,
      apiKey: envConfig.apiKey,
      source: "PI_DOCPARSER_VISUAL_* env vars",
    };
  }

  // Tier 3: Persisted config visionModel ref → registry lookup
  if (persistedConfig.visionModel) {
    const ref = persistedConfig.visionModel;
    const registryModel = ctx.modelRegistry.find(
      ...(ref.split("/") as [string, string]),
    ) as Model<Api> | undefined;
    if (registryModel && isVisionModel(registryModel)) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
      if (auth.ok) {
        return {
          kind: "pi",
          baseUrl: registryModel.baseUrl,
          model: registryModel.id,
          apiKey: auth.apiKey,
          headers: auth.headers,
          piModel: registryModel,
          source: `persisted config (${ref})`,
        };
      }
      throw new Error(
        `Persisted vision model ${ref} authentication failed: ${auth.error}`,
      );
    }
    // Model not found or not vision-capable — fall through to auto-select.
  }

  // Tier 4: Auto-select first vision model from registry
  if (persistedConfig.autoSelectVisionModel) {
    const allModels = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll()) as Model<Api>[];
    const firstVisionModel = allModels.find((m) => isVisionModel(m));
    if (firstVisionModel) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(firstVisionModel);
      if (auth.ok) {
        return {
          kind: "pi",
          baseUrl: firstVisionModel.baseUrl,
          model: firstVisionModel.id,
          apiKey: auth.apiKey,
          headers: auth.headers,
          piModel: firstVisionModel,
          source: `auto-selected from registry (${firstVisionModel.provider}/${firstVisionModel.id})`,
        };
      }
    }
  }

  // Tier 5: Active pi model
  const activeModel = ctx.model as Model<Api> | undefined;
  if (activeModel && isVisionModel(activeModel)) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(activeModel);
    if (!auth.ok) throw new Error(`Active Pi model authentication is unavailable: ${auth.error}`);
    return {
      kind: "pi",
      baseUrl: activeModel.baseUrl,
      model: activeModel.id,
      apiKey: auth.apiKey,
      headers: auth.headers,
      piModel: activeModel,
      source: `active Pi model (${activeModel.provider}/${activeModel.id})`,
    };
  }

  return null;
}

function serializeFindings(result: Awaited<ReturnType<typeof runVisualAnalysis>>): string {
  const lines: string[] = [];
  lines.push(
    `Focus: ${result.focus}`,
    `Model: ${result.modelUsed.model} @ ${result.modelUsed.baseUrl}`,
    `Render: ${result.timing.renderMs}ms · Analyze: ${result.timing.analyzeMs}ms · Total: ${result.timing.totalMs}ms`,
    `Provenance: all box/title/axis/legend values below are model-inferred. They are NOT search-ready coordinates. Use document_search on the underlying text for citations.`,
    "",
  );

  for (const page of result.pages) {
    lines.push(`## Page ${page.pageNumber}`);
    lines.push(`- Screenshot: ${page.screenshotPath}`);
    if (page.parsed && page.finding) {
      const f = page.finding;
      const title = f.title ? ` "${f.title}"` : "";
      lines.push(`- Diagram: ${f.diagramType}${title}`);
      if (f.description) lines.push(`- Description: ${f.description}`);
      if (f.axes) {
        const axes = [
          f.axes.x ? `x=${f.axes.x}` : "",
          f.axes.y ? `y=${f.axes.y}` : "",
          f.axes.legend && f.axes.legend.length > 0 ? `legend=[${f.axes.legend.join(", ")}]` : "",
        ]
          .filter((s) => s.length > 0)
          .join(" ");
        if (axes) lines.push(`- Axes: ${axes}`);
      }
      if (f.observations && f.observations.length > 0) {
        lines.push("- Observations:");
        for (const observation of f.observations) lines.push(`  - ${observation}`);
      }
      if (f.nodes && f.nodes.length > 0) {
        lines.push("- Nodes:");
        for (const node of f.nodes) {
          const role = node.role ? ` (${node.role})` : "";
          lines.push(`  - ${node.id} ${node.label}${role}`);
        }
      }
      if (f.edges && f.edges.length > 0) {
        lines.push("- Edges:");
        for (const edge of f.edges) {
          const label = edge.label ? ` label="${edge.label}"` : "";
          lines.push(`  - ${edge.from} -> ${edge.to}${label}`);
        }
      }
      if (f.annotations && f.annotations.length > 0) {
        lines.push("- Annotations:");
        for (const a of f.annotations) lines.push(`  - ${a}`);
      }
      if (f.uncertainties && f.uncertainties.length > 0) {
        lines.push("- Uncertainties:");
        for (const u of f.uncertainties) lines.push(`  - ${u}`);
      }
      if (typeof f.confidence === "number") {
        lines.push(`- Confidence: ${f.confidence.toFixed(2)}`);
      }
    } else {
      lines.push(`- (parse error: ${page.parseError ?? "unknown"})`);
    }
    lines.push("");
  }

  if (result.skipped.length > 0) {
    lines.push("Skipped:");
    for (const skipped of result.skipped) {
      lines.push(`  - p${skipped.pageNumber}: ${skipped.reason}`);
    }
  }

  return lines.join("\n");
}

export function registerDocumentVisualAnalyzeTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_visual_analyze",
    label: "Document Visual Analyze",
    description:
      "Render candidate document pages and analyze charts, diagrams, and tables. When the active Pi model supports images, it is used automatically (change via /model). Otherwise, use PI_DOCPARSER_VISUAL_BASE_URL/MODEL env vars or per-call baseUrl/model. Requires allowCloud=true for remote endpoints. Findings are descriptive and model-inferred — NOT citation geometry.",
    promptSnippet:
      "Use a vision model to interpret charts, diagrams, and tables on candidate document pages.",
    promptGuidelines: [
      "Call document_complexity first to find candidate pages, then call this tool with explicit pages or with a small maxCandidatePages limit.",
      "The visual model follows the active Pi model selection (/model, --model) through Pi's provider-agnostic model SDK. Only image-capable models are used.",
      "Without an image-capable model configured, the tool fails with guidance to select one; it never silently uploads screenshots to a text-only model.",
      "Findings are model-inferred descriptions, not search boxes. Do not present them as citations of text on the page; pair with document_search when you need text-level citations.",
      "When the model is uncertain, surface the uncertainties list to the user rather than the inferred values.",
    ],
    parameters: DocumentVisualAnalyzeSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text", text: "Document visual analysis was cancelled before it started." },
          ],
          details: {},
        };
      }

      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) {
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      }

      const params = rawParams as DocumentVisualAnalyzeParams;
      const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) {
          throw new Error(missingHostDependencyMessage);
        }

        const envConfig = loadVisualAnalysisConfig();
        const persistedConfig = readConfig();
        const merged = loadMergedConfig();

        const allowCloud =
          params.allowCloud !== undefined ? params.allowCloud : merged.allowCloud;
        const dpi = params.dpi ?? merged.visualDpi;
        const focus = params.focus ?? "chart or diagram";

        // Determine which pages to analyze.
        let pages: number[];
        if (params.pages) {
          const selection = resolveScreenshotSelection(params.pages);
          if (!selection.pageNumbers) {
            throw new Error(
              "document_visual_analyze requires explicit page numbers when 'pages' is provided. 'all' / '*' is not supported.",
            );
          }
          pages = selection.pageNumbers;
          emit(`Pages specified: ${pages.join(", ")} (${pages.length} page(s))`);
        } else {
          emit("📋 Stage 1/3: Scanning for visual candidates...");
          const { LiteParse } = await loadLiteParseModule();
          const parser = new LiteParse({
            ocrEnabled: false,
            maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
            password: normalizeOptionalString(params.password),
            quiet: true,
          });
          const stats = await parser.isComplex(input.resolvedPath);
          const complexity = stats.map((s) => toComplexityPage(s, { threshold: 0.4 }));
          pages = selectCandidatePageNumbers(complexity, {
            threshold: 0.4,
            maxPages: params.maxCandidatePages ?? merged.maxCandidatePages,
          });
          if (pages.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: [
                    `No visual-candidate pages found in ${input.sourcePath}.`,
                    `Try a lower threshold or supply explicit pages.`,
                  ].join("\n"),
                },
              ],
              details: {
                sourcePath: input.sourcePath,
                resolvedPath: input.resolvedPath,
                focus,
                effectiveConfig: { baseUrl: "", model: "", dpi, allowCloud },
                result: {
                  focus,
                  modelUsed: { baseUrl: "", model: "" },
                  pages: [],
                  skipped: [],
                  timing: { renderMs: 0, analyzeMs: 0, totalMs: 0 },
                  provenance: [],
                },
              } as DocumentVisualAnalyzeDetails,
            };
          }
          emit(`Selected ${pages.length} candidate page(s): ${pages.join(", ")}`);
        }

        const resolved = await resolveVisualModel(ctx, params, envConfig, persistedConfig);
        if (!resolved) {
          const allModels = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll()) as Model<Api>[];
          const visionModels = allModels.filter((m) => isVisionModel(m));
          const visionRefs = visionModels
            .map((m) => `${m.provider}/${m.id}`)
            .join(", ");
          const activeModel = ctx.model as Model<Api> | undefined;
          const activeLabel = activeModel
            ? `${activeModel.provider}/${activeModel.id}`
            : "(none)";
          const visionHint = visionRefs
            ? `Available vision models: ${visionRefs}. Pick one: /docparser-model`
            : "No vision-capable models found. Add one with /model.";
          throw new Error(
            `No image-capable model is available for visual analysis. Active model ${activeLabel} does not accept images. ${visionHint}`,
          );
        }

        // Explicit/env models use the local OpenAI-compatible client. The active
        // Pi model uses completeSimple so Pi routes Responses, Anthropic,
        // Google, and other APIs correctly.
        // We have a resolved model — proceed with analysis.
        let baseUrl = resolved.baseUrl;
        const model = resolved.model;
        const apiKey = resolved.apiKey;
        const isLoopback = isLocalBaseUrl(baseUrl);
        try {
          baseUrl = normalizeRemoteUrl(baseUrl, { allowLoopback: isLoopback });
        } catch (error) {
          throw new Error(
            `Invalid baseUrl: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (
          isRemoteVisualTarget({
            baseUrl,
            model,
            provider: resolved.kind === "pi" ? resolved.piModel.provider : undefined,
          }) &&
          !allowCloud
        ) {
          throw new Error(
            `Refusing to send screenshots to remote or cloud-routed model ${resolved.kind === "pi" ? `${resolved.piModel.provider}/${model}` : model} without allowCloud=true.`,
          );
        }

        const effectiveConfig = {
          allowCloud,
          baseUrl,
          model,
          apiKey,
          dpi,
        };
        const validationErrors = validateVisualAnalysisConfig(effectiveConfig);
        if (validationErrors.length > 0) {
          throw new Error(`Invalid visual analysis configuration: ${validationErrors.join("; ")}`);
        }

        emit(
          `🔍 Using model: ${summarizeConfig({ baseUrl, model, apiKey })} (source: ${resolved.source})`,
        );
        emit("🎨 Stage 2/3: Rendering screenshots...");

        const analyzePage =
          resolved.kind === "pi"
            ? async (page: {
                pageNumber: number;
                imageBase64: string;
                mimeType: string;
                pageContext?: string;
              }): Promise<string> => {
                const response = await completeSimple(
                  resolved.piModel,
                  {
                    systemPrompt: VISUAL_ANALYSIS_SYSTEM_PROMPT,
                    messages: [
                      {
                        role: "user",
                        content: [
                          {
                            type: "text",
                            text: buildVisualAnalysisUserText({
                              focus,
                              pageNumber: page.pageNumber,
                              pageContext: page.pageContext,
                            }),
                          },
                          {
                            type: "image",
                            data: page.imageBase64,
                            mimeType: page.mimeType,
                          },
                        ],
                        timestamp: Date.now(),
                      },
                    ],
                    tools: [],
                  },
                  {
                    apiKey: resolved.apiKey,
                    headers: resolved.headers,
                    signal,
                  },
                );
                if (response.stopReason === "aborted") {
                  throw new Error(response.errorMessage ?? "Pi vision analysis was aborted.");
                }
                if (response.stopReason === "error") {
                  throw new Error(response.errorMessage ?? "Pi vision analysis failed.");
                }
                return response.content
                  .filter((part): part is { type: "text"; text: string } => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
                  .trim();
              }
            : undefined;

        emit("🤖 Stage 3/3: Analyzing with vision model...");

        const result = await runVisualAnalysis({
          resolvedPath: input.resolvedPath,
          password: normalizeOptionalString(params.password),
          inspection: input.inspection,
          pages,
          focus,
          config: effectiveConfig,
          analyzePage,
          signal,
        });

        const summary = serializeFindings(result);
        emit("Done.");

        const details: DocumentVisualAnalyzeDetails = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          focus,
          effectiveConfig: {
            baseUrl,
            model,
            dpi,
            allowCloud,
          },
          result,
        };

        // Do not return screenshots as tool-result image blocks. They were
        // already sent to the selected provider, and returning them would send
        // the same document pages to the active Pi model a second time.
        return { content: [{ type: "text", text: summary }], details };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}

export const __testing = {
  describeFinding,
  maskSecret,
  normalizeRemoteUrl,
  resolveVisualModel: null as unknown,
};

// ---------------------------------------------------------------------------
// /docparser-model command
// ---------------------------------------------------------------------------

const MODEL_COMMAND = "docparser-model";
const MODEL_COMMAND_DESCRIPTION =
  "Configure the vision model for document_visual_analyze — pick from all models or set directly";

function showModelStatus(ctx: ExtensionCommandContext): void {
  const cfg = readConfig();
  const lines: string[] = [];
  lines.push("📄 Parsing: " +
    `dpi=${cfg.defaultDpi} ocr=${cfg.ocrEnabled ? "on" : "off"}(${cfg.defaultOcrLanguage}) maxPages=${cfg.defaultMaxPages}`);
  lines.push(`   format=${cfg.defaultOutputFormat} images=${cfg.imageMode} links=${cfg.extractLinks ? "on" : "off"} smallText=${cfg.preserveSmallText ? "on" : "off"}`);
  lines.push(`🔍 Search: caseSensitive=${cfg.caseSensitive} maxResults=${cfg.maxSearchResults}`);
  lines.push(`📸 Screenshots: uses visual DPI (${cfg.visualDpi})`);
  lines.push(`👁 Vision: model=${cfg.visionModel ?? "auto"} cloud=${cfg.allowCloud ? "yes" : "no"}`);
  lines.push(`   dpi=${cfg.visualDpi} candidates=${cfg.maxCandidatePages} threshold=${cfg.visualCandidateThreshold}`);
  lines.push(`   thinking=${cfg.thinking ? `on (${cfg.thinkingLevel})` : "off"} maxTokens=${cfg.maxDescriptionTokens ?? "unlimited"}`);
  lines.push(`💾 Cache: ${cfg.cacheMax} entries`);
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showModelPickerCmd(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "/docparser-model requires interactive mode. Set directly with /docparser-model <provider/id>.",
      "error",
    );
    return;
  }

  const cfg = readConfig();
  const allModels = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll())
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name, input: m.input, reasoning: m.reasoning }));

  // Non-TUI fallback
  if ((ctx as any).mode !== "tui") {
    const { vision } = findVisionModels(allModels);
    if (vision.length === 0) {
      ctx.ui.notify("No vision-capable models found. Add one with /model.", "error");
      return;
    }
    const labels = ["⟳ Auto"];
    const refs: (string | null)[] = [null];
    for (const m of vision) {
      const ref = formatModelRef(m.provider, m.id);
      labels.push(`${m.name || m.id} [${ref}]${cfg.visionModel === ref ? " ✓" : ""}`);
      refs.push(ref);
    }
    const picked = await ctx.ui.select("Vision model for docparser", labels);
    if (picked === undefined) return;
    const idx = labels.indexOf(picked);
    if (idx < 0) return;
    const updated = { ...cfg, visionModel: refs[idx] };
    const path = writeConfig(updated);
    ctx.ui.notify(
      refs[idx]
        ? `Docparser vision model set to ${refs[idx]}. Config: ${path}`
        : "Docparser vision model cleared. Will auto-select from registry.",
      "info",
    );
    return;
  }

  // TUI: VisionModelSelectorComponent
  const result = await ctx.ui.custom<VisionModelSelectorResult>((tui, theme, _kb, done) => {
    const selector = new VisionModelSelectorComponent(
      theme,
      allModels,
      cfg.visionModel,
      (r) => done(r),
    );
    return {
      render(width: number) { return selector.render(width); },
      invalidate() { selector.invalidate(); },
      handleInput(data: string) { selector.handleInput(data); tui.requestRender(); },
    };
  });

  if (!result || result.cancelled) {
    ctx.ui.notify("Docparser model picker cancelled.", "info");
    return;
  }

  const updated = { ...cfg, visionModel: result.ref };
  const path = writeConfig(updated);
  ctx.ui.notify(
    result.ref
      ? `Docparser vision model set to ${result.ref}. Config: ${path}`
      : "Docparser vision model cleared. Will auto-select from registry.",
    "info",
  );
}
async function openConfigPanel(ctx: ExtensionCommandContext, focusSection?: string): Promise<void> {
  const cfg = readConfig();
  const allModels = (ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll())
    .map((m) => ({ provider: m.provider, id: m.id, name: m.name, input: m.input, reasoning: m.reasoning }));

  if (!ctx.hasUI || (ctx as any).mode !== "tui") {
    showModelStatus(ctx);
    return;
  }

  const result = await ctx.ui.custom<DocparserSettingsResult>((tui, theme, _kb, done) => {
    const editor = new DocparserSettingsComponent(theme, cfg, allModels, (r) => done(r), focusSection);
    return {
      render(width: number) { return editor.render(width); },
      invalidate() { editor.invalidate(); },
      handleInput(data: string) { editor.handleInput(data); tui.requestRender(); },
    };
  });

  if (!result || result.cancelled) {
    ctx.ui.notify("Docparser settings unchanged.", "info");
    return;
  }

  const path = writeConfig(result.config);
  ctx.ui.notify(`Docparser settings saved. Config: ${path}`, "info");
}

export function registerModelCommand(pi: ExtensionAPI): void {
  pi.registerCommand(MODEL_COMMAND, {
    description: MODEL_COMMAND_DESCRIPTION,
    getArgumentCompletions(prefix: string) {
      const subcommands = ["status", "auto", "clear", "thinking"];
      const matches = subcommands.filter((s) => s.startsWith(prefix));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0]?.toLowerCase() ?? "";
      const rest = parts.slice(1).join(" ");

      // Quick-set: /docparser-model <provider/id>
      if (subcommand.includes("/")) {
        const cfg = readConfig();
        const updated = { ...cfg, visionModel: subcommand };
        const path = writeConfig(updated);
        ctx.ui.notify(`Docparser vision model set to ${subcommand}. Config: ${path}`, "info");
        return;
      }

      if (subcommand === "help") {
        ctx.ui.notify(
          [
            "/docparser-model                  Open settings panel (focus: Vision)",
            "/docparser-model <provider/id>    Quick-set vision model",
            "/docparser-model status           Show current config",
            "/docparser-model auto             Clear preference, auto-select",
            "/docparser-model thinking <off|minimal|low|medium|high|xhigh|max>",
            "",
            "Tip: /docparser-config for the full settings editor.",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "status") {
        showModelStatus(ctx);
        return;
      }

      if (subcommand === "auto" || subcommand === "clear") {
        const cfg = readConfig();
        const updated = { ...cfg, visionModel: null, autoSelectVisionModel: true };
        const path = writeConfig(updated);
        ctx.ui.notify(`Docparser vision model cleared. Will auto-select from registry. Config: ${path}`, "info");
        return;
      }

      if (subcommand === "thinking") {
        const level = rest.toLowerCase();
        const cfg = readConfig();
        if (level === "off") {
          const updated = { ...cfg, thinking: false };
          const path = writeConfig(updated);
          ctx.ui.notify(`Thinking disabled. Config: ${path}`, "info");
        } else if (isThinkingLevel(level)) {
          const updated = { ...cfg, thinking: true, thinkingLevel: level };
          const path = writeConfig(updated);
          ctx.ui.notify(`Thinking enabled (${level}). Config: ${path}`, "info");
        } else {
          ctx.ui.notify(`Invalid thinking level "${level}". Use: off, minimal, low, medium, high, xhigh, max`, "warning");
        }
        return;
      }

      // No args or unknown subcommand → open settings panel focused on Vision
      await openConfigPanel(ctx, "Vision");
    },
  });
}

// ---------------------------------------------------------------------------
// /docparser-config command — full interactive settings
// ---------------------------------------------------------------------------

const CONFIG_COMMAND = "docparser-config";
const CONFIG_COMMAND_DESCRIPTION =
  "Open interactive settings panel for all docparser configuration";

export function registerConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand(CONFIG_COMMAND, {
    description: CONFIG_COMMAND_DESCRIPTION,
    getArgumentCompletions(prefix: string) {
      const subcommands = ["status"];
      const matches = subcommands.filter((s) => s.startsWith(prefix));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "status") {
        showModelStatus(ctx);
        return;
      }

      await openConfigPanel(ctx);
    },
  });
}
