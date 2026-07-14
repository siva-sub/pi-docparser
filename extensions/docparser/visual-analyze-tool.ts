import { completeSimple, type Static, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_MAX_PAGES } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget, resolveScreenshotSelection } from "./input.ts";
import { getProvidedRemovedV1Options, getRemovedV1OptionsMessage } from "./liteparse-config.ts";
import { loadLiteParseModule } from "./liteparse-module.ts";
import {
  loadVisualAnalysisConfig,
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
 * Resolve a vision-capable model in explicit per-call, environment, then
 * active-Pi order. Active-Pi calls use Pi's provider-agnostic SDK so `/model`,
 * `--model`, settings, auth, and provider-specific APIs are respected.
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
): Promise<ResolvedVisualModel | null> {
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

  const activeModel = ctx.model as Model<Api> | undefined;
  if (!activeModel || !activeModel.input.includes("image")) return null;

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
        const allowCloud =
          params.allowCloud !== undefined ? params.allowCloud : envConfig.allowCloud;
        const dpi = params.dpi ?? envConfig.dpi;
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
        } else {
          emit("Auto-selecting visual candidate pages...");
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
            maxPages: params.maxCandidatePages ?? 6,
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

        const resolved = await resolveVisualModel(ctx, params, envConfig);
        if (!resolved) {
          const activeModel = ctx.model as Model<Api> | undefined;
          const activeLabel = activeModel ? `${activeModel.provider}/${activeModel.id}` : "(none)";
          throw new Error(
            `No image-capable model is available for visual analysis. Active model ${activeLabel} does not accept images. Select an image-capable model with /model or configure a local OpenAI-compatible endpoint with PI_DOCPARSER_VISUAL_BASE_URL and PI_DOCPARSER_VISUAL_MODEL. Inspect choices with pi --list-models.`,
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
          `Using model: ${summarizeConfig({ baseUrl, model, apiKey })} (source: ${resolved.source})`,
        );
        emit("Rendering screenshots and calling vision model...");

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
