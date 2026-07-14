import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isLocalBaseUrl,
  isRemoteVisualTarget,
  loadVisualAnalysisConfig,
  validateVisualAnalysisConfig,
  type VisualAnalysisConfig,
} from "../extensions/docparser/visual-config.ts";
import { maskSecret, normalizeRemoteUrl } from "../extensions/docparser/util.ts";

const ENV_KEYS = [
  "PI_DOCPARSER_ALLOW_CLOUD",
  "PI_DOCPARSER_VISUAL_BASE_URL",
  "PI_DOCPARSER_VISUAL_MODEL",
  "PI_DOCPARSER_VISUAL_API_KEY",
  "PI_DOCPARSER_VISUAL_DPI",
] as const;

describe("visual-config", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns safe defaults when nothing is configured", () => {
    const config = loadVisualAnalysisConfig();
    expect(config.allowCloud).toBe(false);
    expect(config.baseUrl).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.dpi).toBe(220);
  });

  it("parses boolean env vars strictly", () => {
    process.env.PI_DOCPARSER_ALLOW_CLOUD = "1";
    process.env.PI_DOCPARSER_VISUAL_DPI = "300";
    const config = loadVisualAnalysisConfig();
    expect(config.allowCloud).toBe(true);
    expect(config.dpi).toBe(300);
  });

  it("ignores invalid DPI values and falls back to default", () => {
    process.env.PI_DOCPARSER_VISUAL_DPI = "9999";
    expect(loadVisualAnalysisConfig().dpi).toBe(220);
    process.env.PI_DOCPARSER_VISUAL_DPI = "50";
    expect(loadVisualAnalysisConfig().dpi).toBe(220);
  });

  it("treats a loopback base URL as local, except for cloud-routed models", () => {
    process.env.PI_DOCPARSER_VISUAL_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.PI_DOCPARSER_VISUAL_MODEL = "qwen3.5:397b";
    const config = loadVisualAnalysisConfig();
    expect(isLocalBaseUrl(config.baseUrl)).toBe(true);
    expect(isRemoteVisualTarget(config)).toBe(false);
    expect(validateVisualAnalysisConfig(config)).toEqual([]);

    process.env.PI_DOCPARSER_VISUAL_MODEL = "qwen3.5:397b-cloud";
    const cloudConfig = loadVisualAnalysisConfig();
    expect(isRemoteVisualTarget(cloudConfig)).toBe(true);
    expect(validateVisualAnalysisConfig(cloudConfig).some((e) => e.includes("allowCloud"))).toBe(
      true,
    );
  });

  it("requires allowCloud=true for a remote base URL", () => {
    const config: VisualAnalysisConfig = {
      allowCloud: false,
      baseUrl: "https://api.example.com/v1",
      model: "qwen-vision",
      apiKey: "secret",
      dpi: 220,
    };
    const errors = validateVisualAnalysisConfig(config);
    expect(errors.some((e) => e.includes("allowCloud"))).toBe(true);
  });

  it("requires both baseUrl and model together", () => {
    const errors = validateVisualAnalysisConfig({
      allowCloud: true,
      baseUrl: "https://api.example.com/v1",
      model: undefined,
      dpi: 220,
    });
    expect(errors.some((e) => e.includes("model is required"))).toBe(true);
  });
});

describe("util", () => {
  it("normalizeRemoteUrl strips credentials and rejects non-http schemes", () => {
    const result = normalizeRemoteUrl("https://user:pass@api.example.com/v1");
    expect(result).toBe("https://api.example.com/v1");

    expect(() => normalizeRemoteUrl("ftp://api.example.com")).toThrow(/protocol/);
    expect(() => normalizeRemoteUrl("not a url")).toThrow();
  });

  it("normalizes loopback hosts consistently, including IPv6 and localhost subdomains", () => {
    expect(() => normalizeRemoteUrl("http://localhost:11434/v1")).toThrow(/loopback/);
    expect(() => normalizeRemoteUrl("http://127.0.0.1:11434/v1")).toThrow(/loopback/);
    expect(() => normalizeRemoteUrl("http://[::1]:11434/v1")).toThrow(/loopback/);
    expect(() => normalizeRemoteUrl("http://worker.localhost:11434/v1")).toThrow(/loopback/);
    expect(normalizeRemoteUrl("http://[::1]:11434/v1", { allowLoopback: true })).toBe(
      "http://[::1]:11434/v1",
    );
    expect(isLocalBaseUrl("http://[::1]:11434/v1")).toBe(true);
    expect(isLocalBaseUrl("http://worker.localhost:11434/v1")).toBe(true);
  });

  it("maskSecret keeps first 4 chars and ellipsis", () => {
    expect(maskSecret(undefined)).toBe("<empty>");
    expect(maskSecret("")).toBe("<empty>");
    expect(maskSecret("abcd")).toBe("***");
    expect(maskSecret("abcdef123")).toBe("abcd***");
  });
});
