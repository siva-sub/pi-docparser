import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveExistingPath,
  tryCurlyQuoteVariant,
  tryMacOsAmPmVariant,
  tryNfdVariant,
} from "../extensions/docparser/util.ts";
import {
  buildLiteParseConfig,
  getProvidedRemovedV1Options,
  getRemovedV1OptionsMessage,
} from "../extensions/docparser/liteparse-config.ts";
import { DEFAULT_MAX_PAGES } from "../extensions/docparser/constants.ts";

describe("path resolution", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-docparser-path-"));
  });
  afterEach(async () => {
    // Best-effort cleanup; not strictly required for these tests.
    void tempDir;
  });

  it("preserves the path for files that exist", async () => {
    const file = join(tempDir, "exists.txt");
    await writeFile(file, "x");
    const cwd = "/";
    expect(await resolveExistingPath(file, cwd)).toBe(file);
  });

  it("returns the unresolved path when nothing exists", async () => {
    const missing = join(tempDir, "missing.txt");
    expect(await resolveExistingPath(missing, "/")).toBe(missing);
  });

  it("tryNfdVariant composes the NFD form", () => {
    expect(tryNfdVariant("a\u0301")).toBe("a\u0301".normalize("NFD"));
  });
  it("tryMacOsAmPmVariant replaces spaces before AM/PM", () => {
    expect(tryMacOsAmPmVariant("Doc 12 AM.pdf")).toBe(`Doc 12\u202FAM.pdf`);
  });
  it("tryCurlyQuoteVariant replaces straight apostrophes", () => {
    expect(tryCurlyQuoteVariant("O'Brien.pdf")).toBe("O\u2019Brien.pdf");
  });
});

describe("liteparse-config v1 options", () => {
  it("flags removed v1 options", () => {
    expect(getProvidedRemovedV1Options({ preciseBoundingBox: true })).toEqual([
      "preciseBoundingBox",
    ]);
    expect(getProvidedRemovedV1Options({ preserveLayoutAlignmentAcrossPages: true })).toEqual([
      "preserveLayoutAlignmentAcrossPages",
    ]);
    expect(getProvidedRemovedV1Options({})).toEqual([]);
  });

  it("returns a clear v1 deprecation message", () => {
    const message = getRemovedV1OptionsMessage(["preciseBoundingBox"]);
    expect(message).toMatch(/preciseBoundingBox/);
    expect(message).toMatch(/LiteParse v2/);
  });
});

describe("buildLiteParseConfig", () => {
  it("respects the new OutputFormat union including 'markdown'", () => {
    const warnings: string[] = [];
    const config = buildLiteParseConfig(
      {
        format: "text",
        ocr: "auto",
        ocrLanguage: "eng",
        ocrLanguages: [],
        ocrServerUrl: undefined,
        numWorkers: 1,
        maxPages: DEFAULT_MAX_PAGES,
        targetPages: "1-5",
        dpi: 150,
        preserveSmallText: false,
        password: undefined,
        tessdataPath: undefined,
      },
      warnings,
    );
    expect(config.outputFormat).toBe("text");
    expect(config.ocrEnabled).toBe(true);
  });
});
