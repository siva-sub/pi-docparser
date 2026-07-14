import { describe, expect, it } from "vitest";

import {
  computeVisualCandidateScore,
  selectCandidatePageNumbers,
  toComplexityPage,
} from "../extensions/docparser/complexity.ts";
import type { PageComplexityStats } from "@llamaindex/liteparse";

function stats(overrides: Partial<PageComplexityStats>): PageComplexityStats {
  return {
    pageNumber: 1,
    textLength: 0,
    textCoverage: 0.5,
    hasSubstantialImages: false,
    imageBlockCount: 0,
    imageCoverage: 0,
    largestImageCoverage: 0,
    fullPageImage: false,
    isGarbled: false,
    pageArea: 612 * 792,
    needsOcr: false,
    reasons: [],
    ...overrides,
  };
}

describe("complexity classifier", () => {
  it("flags substantial images with vector area as a visual candidate", () => {
    const s = stats({
      hasSubstantialImages: true,
      imageBlockCount: 4,
      imageCoverage: 0.6,
      uncoveredVectorArea: 30_000,
      textCoverage: 0.2,
    });
    const { score, signals } = computeVisualCandidateScore(s);
    expect(score).toBeGreaterThanOrEqual(0.4);
    expect(signals.some((signal) => signal.kind === "visual")).toBe(true);
  });

  it("does not flag a plain text page as visual", () => {
    const s = stats({ textCoverage: 0.9 });
    const page = toComplexityPage(s, { threshold: 0.4 });
    expect(page.visualCandidate).toBe(false);
    expect(page.visualCandidateScore).toBeLessThan(0.3);
  });

  it("respects an explicit threshold", () => {
    const s = stats({ hasSubstantialImages: true, imageCoverage: 0.2 });
    expect(toComplexityPage(s, { threshold: 0.5 }).visualCandidate).toBe(false);
    expect(toComplexityPage(s, { threshold: 0.1 }).visualCandidate).toBe(true);
  });

  it("selects up to maxPages candidate pages and sorts by score", () => {
    const pages = [
      toComplexityPage(stats({ pageNumber: 1, hasSubstantialImages: true, imageCoverage: 0.2 }), {
        threshold: 0.1,
      }),
      toComplexityPage(stats({ pageNumber: 2, hasSubstantialImages: false, textCoverage: 0.9 }), {
        threshold: 0.1,
      }),
      toComplexityPage(
        stats({
          pageNumber: 3,
          hasSubstantialImages: true,
          imageCoverage: 0.8,
          imageBlockCount: 5,
          fullPageImage: true,
        }),
        { threshold: 0.1 },
      ),
    ];
    const result = selectCandidatePageNumbers(pages, { maxPages: 1, threshold: 0.1 });
    expect(result).toEqual([3]);
  });

  it("returns an empty list when no page meets the threshold", () => {
    const pages = [
      toComplexityPage(stats({ pageNumber: 1, textCoverage: 0.9 }), { threshold: 0.5 }),
      toComplexityPage(stats({ pageNumber: 2, textCoverage: 0.8 }), { threshold: 0.5 }),
    ];
    expect(selectCandidatePageNumbers(pages, { maxPages: 5, threshold: 0.5 })).toEqual([]);
  });
});
