/**
 * Batch document processing tools.
 *
 * document_batch_parse — concurrent multi-document parsing with progress
 * document_batch_complexity — quick complexity scan across multiple documents
 *
 * Modeled after pi-scraper's web_batch pattern: concurrent processing,
 * per-item progress updates, aggregation with individual error handling.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_MAX_PAGES, DEFAULT_DPI } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import { loadLiteParseModule } from "./liteparse-module.ts";
import {
  buildDocumentParsePlan,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "./liteparse-config.ts";
import { DocumentParseSchema } from "./schema.ts";
import { selectCandidatePageNumbers, toComplexityPage } from "./complexity.ts";
import { DocumentCache } from "./cache.ts";
import type { DocumentParseParams, DocumentOutputFormat } from "./types.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const BatchParseSchema = Type.Object({
  paths: Type.Array(Type.String(), {
    minItems: 1,
    description: "Array of document paths to parse (PDF, DOCX, PPTX, XLSX, CSV, images)",
  }),
  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description: "Max concurrent parses (default: 3)",
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("json")] as const, {
      description: "Output format (default: text)",
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: 72,
      description: "Rendering DPI for OCR and screenshots (default: 150)",
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum pages per document (default: 1000)",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted documents (applied to all)",
    }),
  ),
});

export const BatchComplexitySchema = Type.Object({
  paths: Type.Array(Type.String(), {
    minItems: 1,
    description: "Array of document paths to scan for complexity",
  }),
  concurrency: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 8,
      description: "Max concurrent scans (default: 3)",
    }),
  ),
  threshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Visual-candidate threshold (default: 0.4)",
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum pages per document (default: 1000)",
    }),
  ),
});

type BatchParseParams = Static<typeof BatchParseSchema>;
type BatchComplexityParams = Static<typeof BatchComplexitySchema>;

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

interface BatchProgressView {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  items: { path: string; status: "queued" | "processing" | "done" | "error"; error?: string }[];
}

function formatProgress(p: BatchProgressView): string {
  const statusBar =
    p.total > 0
      ? `[${"#".repeat(p.succeeded)}${"!".repeat(p.failed)}${".".repeat(p.total - p.completed)}]`
      : "";
  return `Batch progress: ${p.completed}/${p.total} ${statusBar} (${p.succeeded} ok, ${p.failed} failed)`;
}

// ---------------------------------------------------------------------------
// Concurrency limiter
// ---------------------------------------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<{ index: number; result?: R; error?: string }[]> {
  const results: { index: number; result?: R; error?: string }[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        const result = await fn(items[idx], idx);
        results.push({ index: idx, result });
      } catch (error) {
        results.push({
          index: idx,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  // Sort by index to preserve input order
  results.sort((a, b) => a.index - b.index);
  return results;
}

// ---------------------------------------------------------------------------
// document_batch_parse
// ---------------------------------------------------------------------------

type ProgressEmitter = (text: string) => void;

interface BatchParseItemResult {
  path: string;
  sourcePath: string;
  outputPath?: string;
  outputFormat: DocumentOutputFormat;
  pageCount?: number;
  preview?: string;
  truncated?: boolean;
  error?: string;
}

export function registerBatchParseTool(pi: ExtensionAPI) {
  // Session-level cache for parsed results
  const cache = new DocumentCache<BatchParseItemResult>(50);

  pi.registerTool({
    name: "document_batch_parse",
    label: "Batch Document Parse",
    description:
      "Parse multiple documents concurrently. Returns per-document results with progress. Good for processing a folder of PDFs, comparing reports, or bulk extraction.",
    promptSnippet:
      "Parse multiple documents at once with concurrent processing. Ideal for batch extraction, comparing reports, or bulk OCR.",
    promptGuidelines: [
      "Use this when you have 2+ documents to parse — faster than calling document_parse N times sequentially.",
      "Each document gets independent error handling; one failure doesn't stop the batch.",
      "Results include per-file output paths — use read on individual outputs for full content.",
      "For single documents, prefer document_parse (simpler, faster single-file path).",
    ],
    parameters: BatchParseSchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Batch parse cancelled before start." }],
          details: {},
        };
      }

      const emit: ProgressEmitter = (text) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: {},
        });

      const params = rawParams as BatchParseParams;
      const concurrency = params.concurrency ?? 3;
      const format = (params.format ?? "text") as DocumentOutputFormat;

      const batchProgress: BatchProgressView = {
        total: params.paths.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
        items: params.paths.map((path) => ({ path, status: "queued" })),
      };

      emit(`Starting batch parse of ${params.paths.length} document(s) with concurrency ${concurrency}...`);

      const startTime = Date.now();

      const results = await runWithConcurrency(
        params.paths,
        concurrency,
        async (path, index): Promise<BatchParseItemResult> => {
          if (signal?.aborted) {
            return { path, sourcePath: path, outputFormat: format, error: "aborted" };
          }

          batchProgress.items[index].status = "processing";
          emit(formatProgress(batchProgress));

          try {
            // Check cache first
            const hash = await DocumentCache.hashFile(path);
            const cached = cache.get(hash);
            if (cached) {
              batchProgress.items[index].status = "done";
              batchProgress.completed++;
              batchProgress.succeeded++;
              emit(formatProgress(batchProgress));
              return { ...cached, path };
            }

            const input = await resolveDocumentTarget(path, ctx.cwd as string);

            // Quick dependency check on first file only (same host)
            if (index === 0) {
              const missingHostDep = await getMissingHostDependencyMessage(input.inspection);
              if (missingHostDep) {
                throw new Error(missingHostDep);
              }
            }

            const { LiteParse } = await loadLiteParseModule();
            const parser = new LiteParse({
              outputFormat: format,
              dpi: params.dpi ?? DEFAULT_DPI,
              maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
              password: params.password,
              quiet: true,
            });

            const parseResult = await parser.parse(input.resolvedPath);
            const outputText =
              format === "json" ? JSON.stringify(parseResult, null, 2) : parseResult.text;
            const outputDir = await mkdtemp(join(tmpdir(), "pi-batch-parse-"));
            const outputPath = join(
              outputDir,
              format === "json" ? "parsed.json" : "parsed.txt",
            );
            await writeFile(outputPath, outputText, "utf8");

            const preview =
              outputText.length > 2000
                ? outputText.slice(0, 2000) + "\n... (truncated)"
                : outputText;

            const itemResult: BatchParseItemResult = {
              path,
              sourcePath: input.sourcePath,
              outputPath,
              outputFormat: format,
              pageCount: parseResult.pages.length,
              preview,
              truncated: outputText.length > 2000,
            };

            // Cache the result
            cache.set(hash, itemResult);

            batchProgress.items[index].status = "done";
            batchProgress.completed++;
            batchProgress.succeeded++;
            emit(formatProgress(batchProgress));

            return itemResult;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            batchProgress.items[index].status = "error";
            batchProgress.items[index].error = errorMsg;
            batchProgress.completed++;
            batchProgress.failed++;
            emit(formatProgress(batchProgress));

            return { path, sourcePath: path, outputFormat: format, error: errorMsg };
          }
        },
      );

      const totalMs = Date.now() - startTime;
      const succeeded = results.filter((r) => !r.result?.error).length;
      const failed = results.filter((r) => r.result?.error).length;

      // Build summary
      const lines: string[] = [];
      lines.push(`Batch parse complete: ${succeeded} succeeded, ${failed} failed in ${totalMs}ms`);
      lines.push("");

      for (const r of results) {
        const item = r.result!;
        const status = item.error ? "✗" : "✓";
        lines.push(`${status} ${item.sourcePath}`);
        if (item.error) {
          lines.push(`  Error: ${item.error}`);
        } else {
          lines.push(`  Pages: ${item.pageCount} · Output: ${item.outputPath}`);
          if (item.preview) {
            const previewLines = item.preview.split("\n").slice(0, 5);
            for (const pl of previewLines) {
              lines.push(`  > ${pl}`);
            }
            if (item.truncated) lines.push(`  ... (use read for full content)`);
          }
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          total: params.paths.length,
          succeeded,
          failed,
          totalMs,
          concurrency,
          items: results.map((r) => ({
            path: r.result!.path,
            sourcePath: r.result!.sourcePath,
            outputPath: r.result!.outputPath,
            pageCount: r.result!.pageCount,
            error: r.result!.error,
          })),
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// document_batch_complexity
// ---------------------------------------------------------------------------

interface BatchComplexityItemResult {
  path: string;
  sourcePath: string;
  totalPages: number;
  visualCandidatePages: number[];
  visualCandidatePageNumbers: number[];
  maxScore: number;
  error?: string;
}

export function registerBatchComplexityTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_batch_complexity",
    label: "Batch Document Complexity",
    description:
      "Quick complexity scan across multiple documents. Finds which documents have visual candidates (charts, diagrams) worth analyzing further. Good for triaging a folder of PDFs before running expensive visual analysis.",
    promptSnippet:
      "Scan multiple documents to find which ones have visual content worth analyzing. Use before document_visual_analyze to prioritize which documents to examine.",
    promptGuidelines: [
      "Use this to triage N documents — find which have charts/diagrams before running visual analysis.",
      "Returns per-document visual candidate pages sorted by score.",
      "Visual candidacy is heuristic — a high score means the page has significant non-textual content, not necessarily a chart.",
      "Pair with document_visual_analyze on the top candidates for detailed analysis.",
    ],
    parameters: BatchComplexitySchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Batch complexity scan cancelled before start." }],
          details: {},
        };
      }

      const emit: ProgressEmitter = (text) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: {},
        });

      const params = rawParams as BatchComplexityParams;
      const concurrency = params.concurrency ?? 3;
      const threshold = params.threshold ?? 0.4;

      emit(
        `Scanning ${params.paths.length} document(s) for visual candidates (threshold: ${threshold})...`,
      );

      const startTime = Date.now();

      const results = await runWithConcurrency(
        params.paths,
        concurrency,
        async (path, _index): Promise<BatchComplexityItemResult> => {
          if (signal?.aborted) {
            return {
              path,
              sourcePath: path,
              totalPages: 0,
              visualCandidatePages: [],
              visualCandidatePageNumbers: [],
              maxScore: 0,
              error: "aborted",
            };
          }

          try {
            const input = await resolveDocumentTarget(path, ctx.cwd as string);
            const { LiteParse } = await loadLiteParseModule();
            const parser = new LiteParse({
              ocrEnabled: false,
              maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
              quiet: true,
            });
            const stats = await parser.isComplex(input.resolvedPath);
            const complexity = stats.map((s) => toComplexityPage(s, { threshold }));
            const candidates = selectCandidatePageNumbers(complexity, {
              threshold,
              maxPages: 32,
            });

            return {
              path,
              sourcePath: input.sourcePath,
              totalPages: stats.length,
              visualCandidatePages: candidates,
              visualCandidatePageNumbers: candidates,
              maxScore: complexity.reduce((max, c) => Math.max(max, c.visualCandidateScore), 0),
            };
          } catch (error) {
            return {
              path,
              sourcePath: path,
              totalPages: 0,
              visualCandidatePages: [],
              visualCandidatePageNumbers: [],
              maxScore: 0,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );

      const totalMs = Date.now() - startTime;
      const succeeded = results.filter((r) => !r.result?.error).length;
      const failed = results.filter((r) => r.result?.error).length;

      // Sort: visual candidates first (by maxScore desc), then non-visual, then errors
      const sorted = results
        .map((r) => r.result!)
        .sort((a, b) => {
          if (a.error && !b.error) return 1;
          if (!a.error && b.error) return -1;
          return b.maxScore - a.maxScore;
        });

      const lines: string[] = [];
      lines.push(
        `Batch complexity: ${succeeded} scanned, ${failed} failed in ${totalMs}ms`,
      );
      lines.push("");

      for (const item of sorted) {
        if (item.error) {
          lines.push(`✗ ${item.sourcePath} — ${item.error}`);
        } else if (item.visualCandidatePages.length > 0) {
          const star = item.maxScore > 0.7 ? "★★★" : item.maxScore > 0.5 ? "★★" : "★";
          lines.push(
            `${star} ${item.sourcePath} — ${item.visualCandidatePages.length} visual candidate page(s): ${item.visualCandidatePages.join(", ")}`,
          );
        } else {
          lines.push(`· ${item.sourcePath} — no visual candidates (${item.totalPages} pages)`);
        }
      }

      lines.push("");
      lines.push("Legend: ★★★ strong visual content · ★★ moderate · ★ likely visual");
      lines.push("Tip: run document_visual_analyze on ★ marked documents for detailed analysis.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          total: params.paths.length,
          succeeded,
          failed,
          totalMs,
          threshold,
          items: sorted.map((item) => ({
            path: item.path,
            sourcePath: item.sourcePath,
            totalPages: item.totalPages,
            visualCandidatePages: item.visualCandidatePages,
            maxScore: item.maxScore,
            error: item.error,
          })),
        },
      };
    },
  });
}
