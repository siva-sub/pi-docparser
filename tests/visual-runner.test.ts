import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runVisualAnalysis } from "../extensions/docparser/visual-runner.ts";
import type { OpenAIClient } from "../extensions/docparser/visual-client.ts";

const ENV_KEYS = [
  "PI_DOCPARSER_ALLOW_CLOUD",
  "PI_DOCPARSER_VISUAL_BASE_URL",
  "PI_DOCPARSER_VISUAL_MODEL",
  "PI_DOCPARSER_VISUAL_API_KEY",
  "PI_DOCPARSER_VISUAL_DPI",
] as const;

describe("runVisualAnalysis", () => {
  let saved: Record<string, string | undefined>;
  let tempDir: string;
  let fakePdf: string;

  beforeEach(async () => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = await mkdtemp(join(tmpdir(), "pi-docparser-test-"));
    fakePdf = join(tempDir, "test.pdf");
    // Minimal valid PDF magic header — we only need parser.screenshot/isComplex
    // to read this. Real PDF parsing may still fail at higher layers, so tests
    // use a stubbed client to avoid network calls.
    await writeFile(fakePdf, "%PDF-1.4\n%%EOF");
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function fakeClientFactory(): {
    factory: (baseUrl: string, apiKey: string | undefined) => OpenAIClient;
    calls: { prompt: string; model: string }[];
  } {
    const calls: { prompt: string; model: string }[] = [];
    const factory: (baseUrl: string, apiKey: string | undefined) => OpenAIClient = () => {
      // The minimal viable stub: never called because we mock the renderer.
      return {
        chat: async () => {
          calls.push({ prompt: "unused", model: "stub" });
          return { id: "x", model: "stub", choices: [] };
        },
      } as unknown as OpenAIClient;
    };
    return { factory, calls };
  }

  it("refuses to start when no baseUrl or model is configured", async () => {
    await expect(
      runVisualAnalysis({
        resolvedPath: fakePdf,
        inspection: { extension: ".pdf" },
        pages: [1],
        focus: "chart",
        config: { allowCloud: false, dpi: 220 },
      }),
    ).rejects.toThrow(/requires both baseUrl and model/);
  });

  it("refuses to start when the configured base URL is remote and allowCloud is false", async () => {
    await expect(
      runVisualAnalysis({
        resolvedPath: fakePdf,
        inspection: { extension: ".pdf" },
        pages: [1],
        focus: "chart",
        config: {
          allowCloud: false,
          baseUrl: "https://api.example.com/v1",
          model: "vision-x",
          apiKey: "k",
          dpi: 220,
        },
      }),
    ).rejects.toThrow(/allowCloud/);
  });

  it("accepts a loopback base URL without allowCloud", async () => {
    const { factory } = fakeClientFactory();
    // We use a path that does not exist so screenshot/isComplex calls fail,
    // but the config validation should pass.
    await expect(
      runVisualAnalysis({
        resolvedPath: "/tmp/nonexistent-for-test.pdf",
        inspection: { extension: ".pdf" },
        pages: [1],
        focus: "chart",
        config: {
          allowCloud: false,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3.5:397b",
          apiKey: undefined,
          dpi: 220,
        },
        clientFactory: factory,
      }),
    ).rejects.toThrow(); // parser will fail because the file is missing
  });

  it("refuses a cloud-routed model even through a loopback base URL", async () => {
    await expect(
      runVisualAnalysis({
        resolvedPath: fakePdf,
        inspection: { extension: ".pdf" },
        pages: [1],
        focus: "chart",
        config: {
          allowCloud: false,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen3.5:397b-cloud",
          dpi: 220,
        },
      }),
    ).rejects.toThrow(/allowCloud/);
  });
});
