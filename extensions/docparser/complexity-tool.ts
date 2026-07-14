import { type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_MAX_PAGES } from "./constants.ts";
import { appendDoctorHint, getMissingHostDependencyMessage } from "./deps.ts";
import { resolveDocumentTarget } from "./input.ts";
import { getProvidedRemovedV1Options, getRemovedV1OptionsMessage } from "./liteparse-config.ts";
import { loadLiteParseModule } from "./liteparse-module.ts";
import { DocumentComplexitySchema } from "./visual-schema.ts";
import { selectCandidatePageNumbers, toComplexityPage } from "./complexity.ts";
import type { ComplexityPage } from "./complexity.ts";
import type { DocumentComplexityDetails } from "./visual-tool-types.ts";

type DocumentComplexityParams = Static<typeof DocumentComplexitySchema>;

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
  return `Document complexity inspection failed: ${message}`;
}

function serializeComplexityPages(pages: ComplexityPage[]): string {
  const lines: string[] = [];
  for (const page of pages) {
    const flag = page.visualCandidate ? "★" : "·";
    const reasons = page.reasons.length > 0 ? ` reasons=[${page.reasons.join(",")}]` : "";
    const images = page.imageBlockCount > 0 ? ` images=${page.imageBlockCount}` : "";
    const vector =
      typeof page.uncoveredVectorArea === "number"
        ? ` vectorArea=${page.uncoveredVectorArea.toFixed(0)}`
        : "";
    const full = page.fullPageImage ? " fullPage" : "";
    const garbled = page.isGarbled ? " garbled" : "";
    lines.push(
      `${flag} p${page.pageNumber} score=${page.visualCandidateScore.toFixed(2)}${images}${vector}${full}${garbled}${reasons}`,
    );
  }
  return lines.join("\n");
}

export function registerDocumentComplexityTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_complexity",
    label: "Document Complexity",
    description:
      "Inspect a local document with LiteParse v2 and return per-page complexity signals. Use this to decide which pages need OCR, which pages are visual candidates (charts, diagrams, figures) for vision analysis, and which pages are simple text. This tool does NOT identify diagram type — it only flags visual candidacy from image and vector signals.",
    promptSnippet:
      "Get per-page complexity and visual-candidate classifications for a local document.",
    promptGuidelines: [
      "Use this before document_visual_analyze to find candidate pages automatically.",
      "Visual candidacy is heuristic. A high score means the page carries significant non-textual content; it does not mean a chart is present.",
      "Pair with document_search to confirm text content before assuming the page is image-only.",
    ],
    parameters: DocumentComplexitySchema,

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            {
              type: "text",
              text: "Document complexity inspection was cancelled before it started.",
            },
          ],
          details: {},
        };
      }

      const removedOptions = getProvidedRemovedV1Options(rawParams);
      if (removedOptions.length > 0) {
        throw new Error(getRemovedV1OptionsMessage(removedOptions));
      }

      const params = rawParams as DocumentComplexityParams;
      const emit = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });

      try {
        const input = await resolveDocumentTarget(params.path, ctx.cwd);
        const missingHostDependencyMessage = await getMissingHostDependencyMessage(
          input.inspection,
        );
        if (missingHostDependencyMessage) {
          throw new Error(missingHostDependencyMessage);
        }

        emit("Loading LiteParse...");
        const { LiteParse } = await loadLiteParseModule();
        const parser = new LiteParse({
          ocrEnabled: false,
          maxPages: params.maxPages ?? DEFAULT_MAX_PAGES,
          password: normalizeOptionalString(params.password),
          quiet: true,
        });

        emit("Scanning page complexity...");
        const stats = await parser.isComplex(input.resolvedPath);
        const threshold = params.visualCandidateThreshold ?? 0.4;
        const pages: ComplexityPage[] = stats.map((s) => toComplexityPage(s, { threshold }));

        const candidates = selectCandidatePageNumbers(pages, { threshold, maxPages: 32 });
        const summary = serializeComplexityPages(pages);
        const focusList = candidates.length > 0 ? candidates.join(", ") : "none";

        const lines: string[] = [
          `Inspected document: ${input.sourcePath}`,
          `Resolved path: ${input.resolvedPath}`,
          `Pages: ${pages.length}`,
          `Visual candidate pages (threshold ${threshold}): ${focusList}`,
          "",
          "Per-page summary:",
          summary,
          "",
          "Notes:",
          "- ★ marks pages that meet the visual-candidate threshold.",
          "- visualCandidateScore is a heuristic over image and vector signals. A high score does not mean a chart is present, only that the page carries significant non-textual content.",
          "- Run document_visual_analyze on the candidate pages to attempt structured chart/diagram analysis.",
        ];

        const details: DocumentComplexityDetails = {
          sourcePath: input.sourcePath,
          resolvedPath: input.resolvedPath,
          threshold,
          pages,
          candidatePageNumbers: candidates,
        };

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details,
        };
      } catch (error) {
        throw new Error(buildFriendlyErrorMessage(error));
      }
    },
  });
}
