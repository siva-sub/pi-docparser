import { describe, expect, it } from "vitest";

import {
  buildVisualAnalysisMessages,
  parseVisualFinding,
  OpenAIHttpError,
  OpenAIClient,
} from "../extensions/docparser/visual-client.ts";

describe("parseVisualFinding", () => {
  it("parses a clean chart JSON response", () => {
    const raw = JSON.stringify({
      pageNumber: 7,
      diagramType: "chart",
      title: "Settlement volume",
      description: "Monthly volumes for 2026.",
      axes: { x: "Month", y: "Volume", legend: ["2025", "2026"] },
      observations: ["Volume grew 12% MoM", "Q1 spike"],
      uncertainties: ["Legend position ambiguous"],
      confidence: 0.8,
    });

    const result = parseVisualFinding(raw, 7);
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.finding.diagramType).toBe("chart");
    expect(result.finding.title).toBe("Settlement volume");
    expect(result.finding.axes?.x).toBe("Month");
    expect(result.finding.observations).toEqual(["Volume grew 12% MoM", "Q1 spike"]);
    expect(result.finding.confidence).toBeCloseTo(0.8);
  });

  it("tolerates markdown fences and surrounding text", () => {
    const raw =
      "Here is the analysis:\n```json\n" +
      JSON.stringify({ pageNumber: 2, diagramType: "graph", title: "Network" }) +
      "\n```\nDone.";

    const result = parseVisualFinding(raw, 1);
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.finding.diagramType).toBe("graph");
    expect(result.finding.pageNumber).toBe(2);
  });

  it("falls back to unknown for unsupported diagramType", () => {
    const raw = JSON.stringify({ pageNumber: 1, diagramType: "bogus" });
    const result = parseVisualFinding(raw, 1);
    expect(result.parsed).toBe(true);
    if (!result.parsed) return;
    expect(result.finding.diagramType).toBe("unknown");
  });

  it("returns a parse error for non-JSON responses", () => {
    const result = parseVisualFinding("not json", 1);
    expect(result.parsed).toBe(false);
    if (result.parsed) return;
    expect(result.error).toMatch(/no JSON object found/);
  });

  it("clamps confidence to 0..1", () => {
    const raw = JSON.stringify({ pageNumber: 1, diagramType: "table", confidence: 5 });
    const result = parseVisualFinding(raw, 1);
    if (!result.parsed) throw new Error("expected parsed");
    expect(result.finding.confidence).toBe(1);
  });
});

describe("buildVisualAnalysisMessages", () => {
  it("includes a system prompt and a user message with image part", () => {
    const messages = buildVisualAnalysisMessages({
      focus: "graph",
      pageNumber: 4,
      imageBase64: "AAAA",
      mimeType: "image/png",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    const user = messages[1]!;
    if (typeof user.content === "string") throw new Error("expected structured content");
    expect(user.content.length).toBe(2);
    const imagePart = user.content[1]!;
    expect(imagePart.type).toBe("image_url");
    expect(imagePart.imageUrl?.url).toMatch(/^data:image\/png;base64,AAAA$/);
  });
});

describe("OpenAIClient", () => {
  it("sends Authorization header when apiKey is provided", async () => {
    const seen: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.url = String(url);
      seen.headers = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      seen.body = init?.body;
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OpenAIClient("https://api.example.com/v1/", "secret-1234", fetchImpl);
    await client.chat({
      model: "vision-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen.url).toBe("https://api.example.com/v1/chat/completions");
    expect(seen.headers?.authorization).toBe("Bearer secret-1234");
  });

  it("serializes image and option fields using OpenAI wire names", async () => {
    let body = "";
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    };
    const client = new OpenAIClient("https://api.example.com/v1", undefined, fetchImpl);
    await client.chat({
      model: "vision-x",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            { type: "image_url", imageUrl: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
      maxTokens: 1500,
      responseFormat: { type: "json_object" },
    });
    const payload = JSON.parse(body) as Record<string, any>;
    expect(payload.max_tokens).toBe(1500);
    expect(payload.response_format).toEqual({ type: "json_object" });
    expect(payload.maxTokens).toBeUndefined();
    expect(payload.messages[0].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
    expect(payload.messages[0].content[1].imageUrl).toBeUndefined();
  });

  it("preserves the version path when baseUrl has no trailing slash", async () => {
    let url = "";
    const fetchImpl: typeof fetch = async (requestUrl) => {
      url = String(requestUrl);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    };
    const client = new OpenAIClient("https://api.example.com/v1", undefined, fetchImpl);
    await client.chat({ model: "vision-x", messages: [{ role: "user", content: "hi" }] });
    expect(url).toBe("https://api.example.com/v1/chat/completions");
  });

  it("omits Authorization header when apiKey is undefined", async () => {
    const seen: { headers?: Record<string, string> } = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.headers = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new OpenAIClient("https://api.example.com/v1/", undefined, fetchImpl);
    await client.chat({
      model: "vision-x",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen.headers?.authorization).toBeUndefined();
  });

  it("raises OpenAIHttpError on non-2xx responses", async () => {
    const fetchImpl: typeof fetch = async () => new Response("upstream timeout", { status: 504 });
    const client = new OpenAIClient("https://api.example.com/v1", "k", fetchImpl);
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(OpenAIHttpError);
  });
});
