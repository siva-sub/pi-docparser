import type { ComplexityPage } from "./complexity.ts";
import type { VisualAnalysisRunResult } from "./visual-types.ts";

export interface DocumentComplexityDetails {
  sourcePath: string;
  resolvedPath: string;
  threshold: number;
  pages: ComplexityPage[];
  candidatePageNumbers: number[];
}

export interface DocumentVisualAnalyzeDetails {
  sourcePath: string;
  resolvedPath: string;
  focus: string;
  effectiveConfig: {
    baseUrl: string;
    model: string;
    dpi: number;
    allowCloud: boolean;
  };
  result: VisualAnalysisRunResult;
}
