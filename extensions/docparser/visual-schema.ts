import { Type } from "@earendil-works/pi-ai";

/**
 * Schema for `document_complexity` tool. Returns per-page complexity signals
 * and visual-candidate classification. LiteParse provides the underlying
 * measurements; we do NOT claim semantic identification of diagram type
 * (chart vs flowchart vs architecture) — only heuristic visual candidacy.
 */
export const DocumentComplexitySchema = Type.Object({
  path: Type.String({
    description: "Path to the document file to inspect (PDF, image, etc.)",
  }),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted or password-protected documents",
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum number of pages to inspect (default: 1000)",
    }),
  ),
  visualCandidateThreshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        "Override the heuristic visual-candidate threshold (0..1). A page is a visual candidate if its composite score is at or above this value. Default is the package's tuned score.",
    }),
  ),
});

/**
 * Schema for `document_visual_analyze` tool. Selects candidate pages, renders
 * screenshots, and sends them to a configured OpenAI-compatible chat model
 * for structured chart/diagram analysis. Off by default; requires
 * allowCloud=true or a loopback base URL.
 */
export const DocumentVisualAnalyzeSchema = Type.Object({
  path: Type.String({
    description: "Path to the document file to analyze",
  }),
  pages: Type.Optional(
    Type.String({
      description:
        'Optional page selection, e.g. "1-3,8". If omitted, the tool auto-selects visual-candidate pages from document_complexity.',
    }),
  ),
  maxCandidatePages: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 32,
      description: "Maximum number of auto-selected candidate pages (default: 6)",
    }),
  ),
  focus: Type.Optional(
    Type.String({
      description:
        'Optional focus prompt. Examples: "graph", "architecture diagram", "bar chart", "flowchart". Default: "chart or diagram".',
    }),
  ),
  dpi: Type.Optional(
    Type.Integer({
      minimum: 72,
      maximum: 600,
      description:
        "Screenshot rendering DPI. Falls back to PI_DOCPARSER_VISUAL_DPI then the package default of 220.",
    }),
  ),
  allowCloud: Type.Optional(
    Type.Boolean({
      description:
        "Explicit consent to send page screenshots to a remote vision model. Required when the configured base URL is not loopback. Defaults to PI_DOCPARSER_ALLOW_CLOUD then false.",
    }),
  ),
  baseUrl: Type.Optional(
    Type.String({
      description:
        "Optional OpenAI-compatible base URL. Defaults to PI_DOCPARSER_VISUAL_BASE_URL then unset. Loopback URLs (Ollama, vLLM, LM Studio) are allowed without allowCloud.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        'Vision-capable model id for an explicit OpenAI-compatible endpoint. Defaults to PI_DOCPARSER_VISUAL_MODEL then unset. Examples: "qwen3.5:397b", "minimax-m3", "gpt-5.4-mini". Text-only models (e.g. glm-5.2, deepseek-v4-pro) will fail on image input. Without baseUrl/model overrides, the active Pi model is routed through Pi SDK.',
    }),
  ),
  apiKey: Type.Optional(
    Type.String({
      description:
        "Bearer token for the configured base URL. Defaults to PI_DOCPARSER_VISUAL_API_KEY. Never logged.",
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum number of pages to scan for visual candidates (default: 1000)",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description: "Optional password for encrypted or password-protected documents",
    }),
  ),
});
