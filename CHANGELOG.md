# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows semantic versioning.

## [3.2.0] - 2026-07-18

### Added

- **Persistent config file** (`~/.pi/agent/extensions/pi-docparser.json`) with settings for vision model, DPI, thinking, cache, and cloud safety
- **Multi-tier model resolution** for `document_visual_analyze`: per-call params > env vars > persisted config > registry auto-select > active model
- **Auto-select from pi model registry**: when no vision model is configured, the tool scans all configured models and picks the first image-capable one (like `pi-vision-handoff`'s pattern)
- **`/docparser-model` command**: interactive picker to choose a vision model, plus `status`, `auto`, `clear`, and `thinking` subcommands
- **`isVisionModel()` helper** — checks `model.input.includes("image")` following the same convention as `pi-vision-handoff`
- **Config helpers**: `readConfig()`, `writeConfig()`, `normalizeConfig()`, `findVisionModels()`, `resolveModelRef()`, `parseModelRef()`, `formatModelRef()`

### Changed

- `loadVisualAnalysisConfig()` now integrates with the persisted config via `loadMergedConfig()`
- Error messages now list available vision-capable models when resolution fails
- Thinking level list aligned with pi-ai's `ThinkingLevel` type (removed unsupported `"max"` level)

### Fixed

- `document_visual_analyze` no longer fails silently when the active model is text-only — it auto-selects a vision model from the registry

### Added

- upgraded `@llamaindex/liteparse` from `2.0.1` to `2.5.1`, gaining `isComplex()` API support
- added `document_complexity` tool: scans a document with LiteParse and returns per-page complexity signals (image coverage, vector area, garbled text, OCR needs) plus a conservative visual-candidate classification for charts, diagrams, and figures
- added `document_visual_analyze` tool: renders candidate pages as screenshots and sends them to a vision model for structured chart/diagram/table analysis
  - uses the active Pi model through `completeSimple()` when no explicit endpoint is configured, preserving `/model`, settings, auth, and provider-specific routing
  - explicit per-call/environment endpoints use the OpenAI-compatible client
  - defaults to local-only (no cloud calls); requires explicit `allowCloud=true` for remote or cloud-routed models
  - model and endpoint are configurable via environment variables (`PI_DOCPARSER_VISUAL_BASE_URL`, `PI_DOCPARSER_VISUAL_MODEL`, `PI_DOCPARSER_VISUAL_API_KEY`, `PI_DOCPARSER_ALLOW_CLOUD`) or per-call parameters
  - findings are model-inferred descriptions with provenance; they are separate from LiteParse text coordinates and must not be used as citation geometry
  - supports automatic candidate-page selection from complexity signals or explicit page ranges

### Changed

- updated the visual-candidate scoring formula to use a noisy-OR (probability union) combination, so pages with multiple corroborating signals rank higher than pages with a single signal
- updated README and SKILL.md to document the new tools and the recommended complexity-then-visual-analyze workflow

## [3.0.0] - 2026-05-28

### Breaking Changes

- upgraded `@llamaindex/liteparse` from `1.5.3` to `2.0.1` and migrated to the LiteParse v2 Node API
- removed unsupported LiteParse v1 options from the public tool schema:
  - `preciseBoundingBox`
  - `preserveLayoutAlignmentAcrossPages`
- changed default `maxPages` from `10000` to LiteParse v2's default `1000`
- changed JSON parse output to the LiteParse v2 result shape: `{ pages, text }`

### Added

- added `document_search` for phrase search with page numbers and bounding boxes
- added `document_screenshot` for direct page rendering as PNG image content blocks plus saved temp files
- added optional `password` support for encrypted/password-protected documents
- added optional `tessdataPath` support for offline/custom Tesseract OCR data
- added helpful guidance when removed LiteParse v1 options are supplied

### Changed

- updated `document_parse` screenshot handling for the LiteParse v2 async screenshot API
- relaxed screenshot documentation away from PDF-only behavior; LiteParse v2 can screenshot supported converted formats when host tools are installed
- simplified host dependency checks to LibreOffice and ImageMagick in line with LiteParse v2 docs
- updated README, skill guidance, and third-party notices for LiteParse v2 and the new tools

## [2.0.0] - 2026-05-13

### Breaking Changes

- migrated Pi package integration from `@mariozechner/*` to `@earendil-works/*`; consumers must use the new scope
- raised minimum supported Node.js version from `>=18` to `>=20.6.0`

### Changed

- upgraded `@llamaindex/liteparse` from `1.0.0` to `1.5.3`
- updated extension imports and type usage to `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`
- tightened peer dependency ranges for Pi packages to `^0.74.0`
- switched repository package management to pnpm:
  - added `pnpm-lock.yaml`
  - removed `bun.lock`
  - removed `package-lock.json`

### Security

- added pnpm dependency hardening settings in `pnpm-workspace.yaml`:
  - `ignoreScripts: true`
  - `minimumReleaseAge: 4320` (3 days)
  - `minimumReleaseAgeStrict: true`
  - `blockExoticSubdeps: true`

### Documentation

- updated README runtime requirement to Node.js `20.6+`

## [1.1.1] - 2026-03-20

### Fixed

- added explicit `extension` and `skill` npm keywords so the Pi package gallery can show the correct package type badges for `pi-docparser`

## [1.1.0] - 2026-03-20

### Changed

- renamed the dependency diagnostic command from `/docparser-doctor` to `/docparser:doctor`
- improved `/docparser:doctor` so missing dependencies are reported as normal diagnostics instead of error-style command failures
- added a dedicated in-progress loader while automatic dependency installation commands are running
- unified doctor install guidance and auto-install command generation, including correct Homebrew cask usage for LibreOffice on macOS

## [1.0.1] - 2026-03-20

### Changed

- added Pi package gallery preview image metadata
- added concrete `document_parse` usage examples to the README
- added GitHub repository metadata to improve the npm package listing

## [1.0.0] - 2026-03-20

Initial public release.

### Added

- `document_parse` pi extension powered by LiteParse for PDFs, Office documents, spreadsheets, CSV files, and common images
- OCR support, text or JSON output, page targeting, and optional PDF screenshot extraction
- `/docparser-doctor` command for host dependency checks and guided setup hints
- `parse-document` skill, package docs, third-party notices, and preview assets
- Bun-based validation scripts for formatting with `oxfmt`, linting with `oxlint`, and TypeScript type checks
