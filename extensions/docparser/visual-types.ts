/**
 * Structured types for visual analysis responses. The vision model returns
 * free-form JSON; we tolerate that with permissive parsing and always
 * surface the raw response for debugging.
 */

export interface VisualFinding {
  pageNumber: number;
  /** Coarse type label. Always "unknown" when the model is unsure. */
  diagramType:
    | "chart"
    | "graph"
    | "diagram"
    | "flowchart"
    | "table"
    | "image"
    | "equation"
    | "mixed"
    | "unknown";
  title?: string;
  description?: string;
  axes?: { x?: string; y?: string; legend?: string[] };
  observations?: string[];
  nodes?: { id: string; label: string; role?: string }[];
  edges?: { from: string; to: string; label?: string }[];
  annotations?: string[];
  uncertainties?: string[];
  /** 0..1 self-reported or implicitly inferred confidence. */
  confidence?: number;
}

export interface VisualAnalysisResult {
  pageNumber: number;
  screenshotPath: string;
  modelUsed: { baseUrl: string; model: string };
  /** The raw model response, for debugging or replay. */
  rawResponse?: string;
  /** Whether the parser was able to extract a VisualFinding for this page. */
  parsed: boolean;
  /** Parser-extracted finding when available. */
  finding?: VisualFinding;
  /** Parser error when extraction failed. */
  parseError?: string;
}

export interface VisualAnalysisRunResult {
  focus: string;
  modelUsed: { baseUrl: string; model: string };
  pages: VisualAnalysisResult[];
  /** Pages that could not be screenshotted. */
  skipped: { pageNumber: number; reason: string }[];
  /** Aggregate timing for the run. */
  timing: { renderMs: number; analyzeMs: number; totalMs: number };
  /** Provenance for downstream citation. */
  provenance: {
    pageNumber: number;
    screenshotPath: string;
    model: string;
    modelInferred: boolean;
  }[];
}
