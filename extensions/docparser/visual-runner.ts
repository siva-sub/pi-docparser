/**
 * Visual analysis orchestrator. Renders selected pages, calls a vision
 * model, and assembles a structured result. Pure functions, no Pi globals.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { VisualAnalysisConfig } from "./visual-config.ts";
import { isLocalBaseUrl, validateVisualAnalysisConfig } from "./visual-config.ts";
import { OpenAIClient, buildVisualAnalysisMessages, parseVisualFinding } from "./visual-client.ts";
import { isPdfExtension, maskSecret, safeMkdtemp, ensureDir } from "./util.ts";
import type {
  VisualAnalysisResult,
  VisualAnalysisRunResult,
  VisualFinding,
} from "./visual-types.ts";

export interface RenderedScreenshot {
  pageNumber: number;
  path: string;
  width: number;
  height: number;
}

export interface RunVisualAnalysisInput {
  resolvedPath: string;
  password?: string;
  inspection: { extension: string };
  pages: number[];
  focus: string;
  config: VisualAnalysisConfig;
  baseUrlOverride?: string;
  modelOverride?: string;
  apiKeyOverride?: string;
  dpiOverride?: number;
  allowCloudOverride?: boolean;
  /** Optional per-page text snippet to help the model interpret the page. */
  pageContextByPageNumber?: Map<number, string>;
  /** Optional sink used by tests to capture fetched URLs without monkey-patching. */
  clientFactory?: (baseUrl: string, apiKey: string | undefined) => OpenAIClient;
  /** Provider-agnostic Pi SDK analysis path for the active model. */
  analyzePage?: (input: {
    pageNumber: number;
    imageBase64: string;
    mimeType: string;
    pageContext?: string;
  }) => Promise<string>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Override clock for tests. */
  now?: () => number;
}

function resolveInputs(input: RunVisualAnalysisInput): {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  dpi: number;
  allowCloud: boolean;
} {
  const baseUrl = input.baseUrlOverride ?? input.config.baseUrl;
  const model = input.modelOverride ?? input.config.model;
  const apiKey = input.apiKeyOverride ?? input.config.apiKey;
  const dpi = input.dpiOverride ?? input.config.dpi;
  const allowCloud =
    input.allowCloudOverride !== undefined ? input.allowCloudOverride : input.config.allowCloud;

  if (!baseUrl || !model) {
    throw new Error(
      "Visual analysis requires both baseUrl and model. Configure PI_DOCPARSER_VISUAL_BASE_URL and PI_DOCPARSER_VISUAL_MODEL, or pass them per-call.",
    );
  }

  const merged: VisualAnalysisConfig = {
    ...input.config,
    baseUrl,
    model,
    apiKey,
    dpi,
    allowCloud,
  };
  const errors = validateVisualAnalysisConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Invalid visual analysis configuration: ${errors.join("; ")}`);
  }

  return { baseUrl, model, apiKey, dpi, allowCloud };
}

async function renderScreenshots(input: {
  resolvedPath: string;
  inspection: { extension: string };
  pages: number[];
  dpi: number;
  signal: AbortSignal | undefined;
  outputDir: string;
  parser: import("@llamaindex/liteparse").LiteParse;
  pageContextByPageNumber: Map<number, string> | undefined;
}): Promise<{ rendered: RenderedScreenshot[]; skipped: { pageNumber: number; reason: string }[] }> {
  if (
    !isPdfExtension(input.inspection.extension) &&
    !input.resolvedPath.toLowerCase().endsWith(".pdf")
  ) {
    // For images, the "page number" is always 1. We still allow it.
    if (input.pages.length > 1) {
      // Truncate to first page silently for image inputs.
      input.pages = [input.pages[0]!];
    }
  }

  const screenshotPages = [...input.pages];
  const dir = join(input.outputDir, "screenshots");
  await ensureDir(dir);
  const results = await input.parser.screenshot(input.resolvedPath, screenshotPages);
  const rendered: RenderedScreenshot[] = [];
  for (const result of results) {
    const safePage = result.pageNum;
    const filename = isPdfExtension(input.inspection.extension)
      ? `page_${safePage}.png`
      : `image.png`;
    const path = join(dir, filename);
    await writeFile(path, result.imageBuffer);
    rendered.push({
      pageNumber: safePage,
      path,
      width: result.width,
      height: result.height,
    });
  }

  const skipped: { pageNumber: number; reason: string }[] = [];
  const renderedSet = new Set(rendered.map((r) => r.pageNumber));
  for (const page of input.pages) {
    if (!renderedSet.has(page)) {
      skipped.push({ pageNumber: page, reason: "screenshot not produced" });
    }
  }

  // Suppress unused warning by referencing param.
  void input.pageContextByPageNumber;
  return { rendered, skipped };
}

async function readBase64(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return bytes.toString("base64");
}

function mimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

export async function runVisualAnalysis(
  input: RunVisualAnalysisInput,
): Promise<VisualAnalysisRunResult> {
  const { baseUrl, model, apiKey, dpi, allowCloud } = resolveInputs(input);
  void allowCloud; // already validated

  const start = input.now ? input.now() : Date.now();

  // Lazy-load the LiteParse module to keep OCR-free code paths cheap.
  const { LiteParse } = await import("@llamaindex/liteparse");
  const parser = new LiteParse({
    dpi,
    ocrEnabled: false,
    quiet: true,
    password: input.password,
  });

  const outputDir = await safeMkdtemp("pi-docparser-visual-");

  const renderStart = input.now ? input.now() : Date.now();
  const { rendered, skipped } = await renderScreenshots({
    resolvedPath: input.resolvedPath,
    inspection: input.inspection,
    pages: input.pages,
    dpi,
    signal: input.signal,
    outputDir,
    parser,
    pageContextByPageNumber: input.pageContextByPageNumber,
  });
  const renderMs = (input.now ? input.now() : Date.now()) - renderStart;

  if (rendered.length === 0) {
    return {
      focus: input.focus,
      modelUsed: { baseUrl, model },
      pages: [],
      skipped,
      timing: { renderMs, analyzeMs: 0, totalMs: (input.now ? input.now() : Date.now()) - start },
      provenance: [],
    };
  }

  const client = input.analyzePage
    ? undefined
    : (input.clientFactory?.(baseUrl, apiKey) ?? new OpenAIClient(baseUrl, apiKey));

  const analyzeStart = input.now ? input.now() : Date.now();
  const results: VisualAnalysisResult[] = [];
  for (const shot of rendered) {
    if (input.signal?.aborted) {
      skipped.push({ pageNumber: shot.pageNumber, reason: "aborted" });
      continue;
    }

    const base64 = await readBase64(shot.path);
    const messages = buildVisualAnalysisMessages({
      focus: input.focus,
      pageNumber: shot.pageNumber,
      imageBase64: base64,
      mimeType: mimeForPath(shot.path),
      pageContext: input.pageContextByPageNumber?.get(shot.pageNumber),
    });

    try {
      const raw = input.analyzePage
        ? await input.analyzePage({
            pageNumber: shot.pageNumber,
            imageBase64: base64,
            mimeType: mimeForPath(shot.path),
            pageContext: input.pageContextByPageNumber?.get(shot.pageNumber),
          })
        : ((
            await client!.chat(
              {
                model,
                messages,
                temperature: 0,
                maxTokens: 1500,
                responseFormat: { type: "json_object" },
              },
              input.signal,
            )
          ).choices?.[0]?.message?.content ?? "");
      const parsed = parseVisualFinding(raw, shot.pageNumber);
      const result: VisualAnalysisResult = {
        pageNumber: shot.pageNumber,
        screenshotPath: shot.path,
        modelUsed: { baseUrl, model },
        rawResponse: raw,
        parsed: parsed.parsed,
        finding: parsed.parsed ? parsed.finding : undefined,
        parseError: parsed.parsed ? undefined : parsed.error,
      };
      results.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        pageNumber: shot.pageNumber,
        screenshotPath: shot.path,
        modelUsed: { baseUrl, model },
        parsed: false,
        parseError: message,
      });
    }
  }

  const analyzeMs = (input.now ? input.now() : Date.now()) - analyzeStart;
  const totalMs = (input.now ? input.now() : Date.now()) - start;

  return {
    focus: input.focus,
    modelUsed: { baseUrl, model },
    pages: results,
    skipped,
    timing: { renderMs, analyzeMs, totalMs },
    provenance: results.map((result) => ({
      pageNumber: result.pageNumber,
      screenshotPath: result.screenshotPath,
      model,
      modelInferred: true,
    })),
  };
}

/** Helper for tests: render a tiny summary line for a finding. */
export function describeFinding(finding: VisualFinding | undefined): string {
  if (!finding) return "(no finding)";
  const title = finding.title ? `"${finding.title}"` : "untitled";
  const observations = finding.observations?.length ?? 0;
  return `${finding.diagramType} ${title} (${observations} observation${observations === 1 ? "" : "s"})`;
}

/**
 * Returns the effective base URL mask, used to print the configuration
 * summary line without exposing secrets. Local URLs (loopback) are never
 * masked because the host is not a secret.
 */
export function summarizeConfig(input: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): string {
  const baseUrl = input.baseUrl
    ? isLocalBaseUrl(input.baseUrl)
      ? input.baseUrl
      : `${new URL(input.baseUrl).hostname}(redacted)`
    : "<unset>";
  const model = input.model ?? "<unset>";
  const key = maskSecret(input.apiKey);
  return `baseUrl=${baseUrl} model=${model} apiKey=${key}`;
}
