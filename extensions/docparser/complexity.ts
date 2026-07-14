/**
 * Per-page complexity result enriched with a heuristic visual-candidate
 * classification. LiteParse provides the raw signals; this module adds the
 * candidate score and reason strings for downstream consumption.
 */

import type { PageComplexityStats } from "@llamaindex/liteparse";

/** Severity for a single complexity reason. */
export type ComplexitySignalKind = "ocr" | "visual" | "layout" | "render";

export interface ComplexitySignal {
  /** Signal kind. `visual` indicates a chart/diagram/figure candidate. */
  kind: ComplexitySignalKind;
  /** Short human-readable reason (e.g. "scanned", "substantial-images"). */
  reason: string;
  /** Numeric weight that contributed to the candidate score (0..1). */
  weight: number;
}

export interface ComplexityPage {
  pageNumber: number;
  needsOcr: boolean;
  reasons: string[];
  textCoverage: number;
  imageBlockCount: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  isGarbled: boolean;
  /** `undefined` when the page did not need the vector-area walk. */
  uncoveredVectorArea: number | undefined;
  /**
   * Heuristic score in [0, 1]. A page is a visual candidate if its score
   * meets the configured threshold. The score never exceeds 1.
   */
  visualCandidateScore: number;
  /** Whether this page is a visual candidate under the current threshold. */
  visualCandidate: boolean;
  signals: ComplexitySignal[];
  /** Note for downstream consumers. */
  note: string;
}

const VECTOR_AREA_PAGE_FRACTION = 0.35;

const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/**
 * Heuristic score combining the strongest visual signals. None of these mean
 * "we know this is a chart" — they mean "the page carries significant
 * non-textual content that a vision model should look at".
 */
export function computeVisualCandidateScore(stats: PageComplexityStats): {
  score: number;
  signals: ComplexitySignal[];
} {
  const signals: ComplexitySignal[] = [];
  let weighted = 0;
  let total = 0;

  const record = (kind: ComplexitySignalKind, reason: string, weight: number): void => {
    signals.push({ kind, reason, weight: clamp01(weight) });
    weighted += clamp01(weight);
    total += 1;
  };

  if (stats.hasSubstantialImages) {
    record("visual", "substantial-images", 0.4);
  }

  if (stats.imageBlockCount >= 1) {
    const imageWeight = clamp01(stats.imageCoverage) * 0.3;
    if (imageWeight > 0) {
      record("visual", `image-blocks:${stats.imageBlockCount}`, imageWeight);
    }
  }

  if (stats.fullPageImage) {
    record("visual", "full-page-image", 0.25);
  }

  if (typeof stats.uncoveredVectorArea === "number" && stats.uncoveredVectorArea > 0) {
    const pageArea = stats.pageArea > 0 ? stats.pageArea : 1;
    const vectorFraction = clamp01(
      stats.uncoveredVectorArea / (pageArea * VECTOR_AREA_PAGE_FRACTION),
    );
    if (vectorFraction > 0.05) {
      record(
        "layout",
        `uncovered-vector:${stats.uncoveredVectorArea.toFixed(0)}`,
        vectorFraction * 0.3,
      );
    }
  }

  if (stats.textCoverage < 0.4 && stats.imageBlockCount === 0) {
    // Vector-only / diagram-like page (no text, no images, but still content).
    if (stats.isGarbled) {
      record("layout", "garbled", 0.1);
    } else if (typeof stats.uncoveredVectorArea === "number") {
      record("layout", "sparse-text+vector", 0.15);
    }
  }

  if (stats.isGarbled) {
    record("ocr", "garbled-text", 0.1);
  }

  // Score uses a noisy-OR (probability union) combination so that any single
  // strong visual signal (substantial images, full-page image) is enough to
  // flag the page, while pages with multiple corroborating signals score
  // higher than pages with just one. This prevents ties between a page with
  // one image and a page with many images.
  if (signals.length === 0) {
    return { score: 0, signals };
  }
  const score = clamp01(1 - signals.reduce((acc, signal) => acc * (1 - signal.weight), 1));
  return { score, signals };
}

export interface VisualCandidateOptions {
  /**
   * Threshold in [0, 1]. Default 0.4. Lower = more candidates. The score is a
   * heuristic, so prefer the default unless you have a specific reason.
   */
  threshold?: number;
}

export function isVisualCandidate(
  page: ComplexityPage,
  options: VisualCandidateOptions = {},
): boolean {
  const threshold = options.threshold ?? 0.4;
  return page.visualCandidateScore >= threshold;
}

export function toComplexityPage(
  stats: PageComplexityStats,
  options: VisualCandidateOptions = {},
): ComplexityPage {
  const { score, signals } = computeVisualCandidateScore(stats);
  const candidate = score >= (options.threshold ?? 0.4);
  const note = candidate
    ? "Visual candidate — render and analyze with a vision model. LiteParse does not identify diagram type."
    : "Not a strong visual candidate; prefer text parsing first.";

  return {
    pageNumber: stats.pageNumber,
    needsOcr: stats.needsOcr,
    reasons: stats.reasons,
    textCoverage: stats.textCoverage,
    imageBlockCount: stats.imageBlockCount,
    imageCoverage: stats.imageCoverage,
    largestImageCoverage: stats.largestImageCoverage,
    fullPageImage: stats.fullPageImage,
    isGarbled: stats.isGarbled,
    uncoveredVectorArea: stats.uncoveredVectorArea,
    visualCandidateScore: score,
    visualCandidate: candidate,
    signals,
    note,
  };
}

export function selectCandidatePageNumbers(
  pages: ComplexityPage[],
  options: { maxPages?: number; threshold?: number } = {},
): number[] {
  const threshold = options.threshold ?? 0.4;
  const maxPages = options.maxPages ?? 6;
  return pages
    .filter((page) => page.visualCandidateScore >= threshold)
    .sort((a, b) => {
      if (b.visualCandidateScore !== a.visualCandidateScore) {
        return b.visualCandidateScore - a.visualCandidateScore;
      }
      return a.pageNumber - b.pageNumber;
    })
    .slice(0, Math.max(1, maxPages))
    .map((page) => page.pageNumber)
    .sort((a, b) => a - b);
}
