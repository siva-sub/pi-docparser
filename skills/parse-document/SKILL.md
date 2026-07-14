---
name: parse-document
description: >-
  Use this skill when the user wants to parse, search, or visually inspect local documents such as PDFs,
  Word/DOCX files, PowerPoint/PPTX decks, Excel/XLSX/CSV spreadsheets, or images such as PNG, JPG,
  TIFF, and WebP. It helps the agent use the pi-docparser tools efficiently: document_parse for text/JSON
  extraction, document_search for phrase locations and bounding boxes, and document_screenshot for visual
  page inspection.
license: MIT
compatibility: >-
  Requires document_parse; optionally benefits from document_search and document_screenshot, such as the
  tools provided by the pi-docparser package.
metadata:
  author: Maximilian Schwarzmüller + pi
  primary-interface: document_parse, document_search, document_screenshot, document_complexity, document_visual_analyze tools
---

# Parse Document

Use the dedicated document tools as the default interface. Do not fall back to manual `lit` CLI commands unless the user explicitly asks for the raw command line workflow or the extension tools are unavailable.

## Tool routing

- Use `document_parse` to extract text or JSON from a local document.
- Use `document_search` to find a phrase and get page numbers plus bounding boxes for citations/source locations.
- Use `document_screenshot` to render pages as PNG image blocks when visual layout matters.
- Use `document_complexity` to inspect per-page signals (images, vector area, OCR needs) and identify visual-candidate pages.
- Use `document_visual_analyze` to send candidate pages to a vision model for structured chart/diagram/table interpretation.

Recommended workflow for known text: `document_search` first, then `document_screenshot` only for relevant pages.

Recommended workflow for visual content: `document_complexity` first to find candidate pages, then `document_visual_analyze` on those pages.

## Efficient parsing

### Choose the smallest useful output

- Use `format: "text"` when the user wants to read, summarize, quote, search, or review the document.
- Use `format: "json"` when the user needs structured page data, text positions, or bounding boxes.
- Avoid JSON unless coordinates or programmatic structure matter.

LiteParse v2 JSON output is shaped like:

```json
{ "pages": [{ "pageNum": 1, "text": "...", "textItems": [] }], "text": "..." }
```

### Limit scope early

If the task concerns only part of a document, pass `targetPages` instead of parsing everything.

Examples:

- a single chapter
- a cited appendix
- a page range from the user
- a specific page mentioned in an error report or screenshot request

Default `maxPages` is `1000`, matching LiteParse v2.

### Use OCR deliberately

- Use `ocr: "off"` for native-text PDFs when OCR is unnecessary.
- Leave OCR on automatic behavior for scanned PDFs or image-heavy documents.
- Use `ocrLanguage` for a single OCR language.
- Use `ocrLanguages` only when multilingual OCR is truly needed.
- Built-in Tesseract usually expects ISO 639-3 codes such as `eng`, `deu`, `fra`, or `jpn`.
- Many HTTP OCR servers instead expect ISO 639-1 codes such as `en`, `de`, `fr`, or `ja`.
- Increase `dpi` only when OCR quality or screenshot readability needs it.
- Use `ocrServerUrl` only when the user already has or wants an external OCR server.
- Use `tessdataPath` only for offline/air-gapped setups or custom Tesseract `.traineddata` files.

### Password-protected documents

If parsing fails because a document is encrypted/password-protected, ask the user for the password and retry with `password`.

## Search workflow

Use `document_search` when the user asks:

- where text appears
- for source/citation locations
- to find all mentions of a phrase
- to identify pages that should be inspected visually

Prefer `targetPages` when the relevant area is known. Use `maxResults` to cap broad searches.

## Screenshot workflow

Use `document_screenshot` when text is not enough, for example:

- charts or figures
- handwriting/signatures
- dense tables
- visual page layout
- forms where spatial relationships matter

Keep screenshot page ranges small, usually one to four pages, unless the user explicitly asks for more.

`document_parse` also supports `screenshotPages` when parsing and screenshotting should happen together, but prefer the dedicated `document_screenshot` tool for visual-only follow-up.

## Complexity and visual analysis workflow

### Find visual-candidate pages

Use `document_complexity` when the document may contain charts, diagrams, or figures that text extraction cannot capture:

- It returns per-page signals: image coverage, vector area, garbled text, and OCR needs.
- It adds a heuristic visual-candidate score (0-1) using a noisy-OR combination of image and vector signals.
- Pages at or above the threshold (default 0.4) are flagged as visual candidates.
- The score is heuristic: a high score means the page carries significant non-textual content, not that a specific chart type is present.

### Analyze charts and diagrams

Use `document_visual_analyze` when you need structured interpretation of charts, diagrams, or tables:

- Call it with explicit `pages` or let it auto-select from complexity signals.
- It renders screenshots and sends them to the active Pi image-capable model through Pi's provider-agnostic SDK when no explicit endpoint is configured. Explicit endpoints must be OpenAI-compatible.
- Default config is local-only; requires `allowCloud: true` for remote or cloud-routed models, even when a cloud model is reached through a loopback proxy.
- The model and endpoint are configurable via environment variables (`PI_DOCPARSER_VISUAL_*`) or per-call parameters.
- Findings are model-inferred descriptions with provenance. They are NOT citation geometry.
- Pair with `document_search` for text-level citations on the same pages.
- When the model is uncertain, surface the uncertainties list rather than the inferred values.

### Important: visual findings are not citations

Visual analysis findings (diagram type, title, axes, observations, nodes, edges) are model-inferred descriptions. They must not be presented as search-ready coordinates or citations. Always pair visual findings with `document_search` on the underlying text for verifiable citations.

## Follow-up workflow

`document_parse` writes parsed output to temporary files and returns their paths. `document_screenshot` writes PNGs to temporary files and also returns image blocks.

After calling tools:

1. inspect returned parsed output paths with `read` when full content is needed
2. inspect returned screenshot paths with `read` when file-level visual review is needed
3. only copy files into the project if the user wants persistent artifacts

Do not inline an entire large document into context. Let the tool save the full result, then inspect selectively.

## Removed LiteParse v1 options

Do not use these removed options:

- `preciseBoundingBox`
- `preserveLayoutAlignmentAcrossPages`

Alternatives:

- use `format: "json"` for LiteParse v2 `textItems` bounding boxes
- use `document_search` for phrase-level bounding boxes
- use `document_screenshot` for visual layout checks
- use `targetPages` to narrow extraction

## Important constraints and expectations

- Office documents and spreadsheets may require LibreOffice on the host machine.
- Image inputs may require ImageMagick on the host machine.
- The tools surface missing dependencies as friendly errors; do not misdiagnose them as generic parser failures.
- Parsed outputs and screenshots are temporary by default. If the user wants durable files in the repo or a chosen folder, copy returned temp files afterward.
- The tools accept pi-style paths such as `@relative/file.pdf` and `~/Documents/file.pdf`.

## Good default patterns

### Summarize or review a document

Use `document_parse` with:

- `format: "text"`
- `targetPages` if only part of the document matters
- `ocr: "off"` for clearly native-text PDFs

Then inspect the returned text file with `read` if needed.

### Extract positions or bounding boxes

Use `document_parse` with:

- `format: "json"`
- `targetPages` when possible

Then inspect the JSON file with `read`.

### Locate a phrase for citation

Use `document_search` with:

- `phrase`
- `targetPages` when possible
- `maxResults` for broad searches

Use returned page/bounding-box hits for citations or screenshot follow-up.

### Review a visually complex page

Use `document_screenshot` with:

- `pages` for the relevant page range
- higher `dpi` only if readability is a problem

### Find and analyze visual content

1. Use `document_complexity` with:
   - `visualCandidateThreshold` to adjust sensitivity (default 0.4)

2. Use `document_visual_analyze` on candidate pages with:
   - `pages` (explicit) or `maxCandidatePages` (auto-select)
   - `focus` to guide the model (e.g. "bar chart trends", "architecture diagram")
   - `baseUrl` and `model` pointing at a vision-capable endpoint
   - `allowCloud: true` only when the endpoint is remote

### Parse a scanned or image-based document

Use `document_parse` with:

- OCR enabled
- `ocrLanguage` or `ocrLanguages` when the document language is known
- optionally higher `dpi`
- JSON only if positional data matters

## Parameter reminders

High-value `document_parse` parameters:

- `path`
- `format`
- `targetPages`
- `screenshotPages`
- `ocr`
- `ocrLanguage`
- `ocrLanguages`
- `ocrServerUrl`
- `numWorkers`
- `maxPages`
- `dpi`
- `preserveSmallText`
- `password`
- `tessdataPath`

Prefer a minimal parameter set. Add advanced options only when the task clearly benefits from them.
