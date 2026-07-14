/**
 * Minimal OpenAI-compatible chat completions client. Used to call vision
 * models (qwen, glm, minimax, etc.) over HTTP from a Pi extension without
 * pulling in any provider SDK. The protocol is the standard /v1/chat/
 * completions endpoint with base64 image_url parts.
 *
 * This client is intentionally scoped: it sends images, returns text, and
 * never logs the API key.
 */

import type { VisualFinding } from "./visual-types.ts";

export interface ChatMessagePart {
  type: "text" | "image_url";
  text?: string;
  imageUrl?: { url: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessagePart[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" | "text" };
  /** Extra headers, e.g. anthropic-version, openai organization, etc. */
  headers?: Record<string, string>;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAIHttpError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `OpenAI-compatible request failed: HTTP ${status}`);
    this.name = "OpenAIHttpError";
    this.status = status;
    this.body = body;
  }
}

export class OpenAIClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async chat(
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL("chat/completions", baseUrl).toString();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...request.headers,
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(toWireRequest(request)),
      signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new OpenAIHttpError(response.status, text);
    }

    try {
      return JSON.parse(text) as ChatCompletionResponse;
    } catch (error) {
      throw new OpenAIHttpError(
        response.status,
        text,
        `OpenAI-compatible response was not valid JSON: ${(error as Error).message}`,
      );
    }
  }
}

/**
 * Convert the ergonomic TypeScript request shape to the snake_case wire
 * format required by OpenAI-compatible chat-completions APIs.
 */
function toWireRequest(request: ChatCompletionRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              part.type === "text"
                ? { type: "text", text: part.text ?? "" }
                : { type: "image_url", image_url: { url: part.imageUrl?.url ?? "" } },
            ),
    })),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.responseFormat !== undefined ? { response_format: request.responseFormat } : {}),
  };
}

export const VISUAL_ANALYSIS_SYSTEM_PROMPT = [
  "You analyze a single page of a document image and return strict JSON only.",
  'Output schema: {"pageNumber": number, "diagramType": "chart|graph|diagram|flowchart|table|image|equation|mixed|unknown", "title"?: string, "description"?: string, "axes"?: {"x"?: string, "y"?: string, "legend"?: string[]}, "observations"?: string[], "nodes"?: [{"id": string, "label": string, "role"?: string}], "edges"?: [{"from": string, "to": string, "label"?: string}], "annotations"?: string[], "uncertainties"?: string[], "confidence"?: number}.',
  "Do NOT invent text you cannot read. If a region is illegible, list it under uncertainties. Do NOT output coordinates in absolute pixels; only describe relative positions in plain language.",
  "If the page is text-only or no chart/diagram is visible, set diagramType to 'unknown' and observations to a short note.",
].join("\n");

export function buildVisualAnalysisUserText(input: {
  focus: string;
  pageNumber: number;
  pageContext?: string;
}): string {
  return [
    `Focus: ${input.focus}.`,
    `Page number: ${input.pageNumber}.`,
    input.pageContext ? `Context text on this page: ${input.pageContext}` : "",
    "Return only the JSON object described above.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Build the chat-completions payload that asks the model for a structured
 * chart/diagram/table description. The prompt is deliberately strict about
 * JSON output so the parser can rely on a stable shape.
 */
export function buildVisualAnalysisMessages(input: {
  focus: string;
  pageNumber: number;
  imageBase64: string;
  mimeType: string;
  pageContext?: string;
}): ChatMessage[] {
  const system: ChatMessage = {
    role: "system",
    content: [{ type: "text", text: VISUAL_ANALYSIS_SYSTEM_PROMPT }],
  };

  const userText = buildVisualAnalysisUserText(input);

  const user: ChatMessage = {
    role: "user",
    content: [
      { type: "text", text: userText },
      {
        type: "image_url",
        imageUrl: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
      },
    ],
  };

  return [system, user];
}

/**
 * Parse a model response into a VisualFinding. Tolerant: we extract the
 * first {...} JSON object from the response, including from markdown fences.
 * Anything else is returned as a parse error.
 */
export function parseVisualFinding(
  raw: string,
  fallbackPageNumber: number,
): { finding: VisualFinding; parsed: true } | { parsed: false; error: string } {
  const text = raw.trim();
  if (!text) {
    return { parsed: false, error: "empty response" };
  }

  let candidate = text;
  // Strip ```json fences.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fence) candidate = fence[1].trim();

  // First balanced JSON object.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { parsed: false, error: "no JSON object found in response" };
  }
  const slice = candidate.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (error) {
    return { parsed: false, error: `JSON parse error: ${(error as Error).message}` };
  }

  if (!parsed || typeof parsed !== "object") {
    return { parsed: false, error: "response was not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const diagramTypeRaw = typeof obj.diagramType === "string" ? obj.diagramType : "unknown";
  const allowedTypes: VisualFinding["diagramType"][] = [
    "chart",
    "graph",
    "diagram",
    "flowchart",
    "table",
    "image",
    "equation",
    "mixed",
    "unknown",
  ];
  const diagramType: VisualFinding["diagramType"] = allowedTypes.includes(
    diagramTypeRaw as VisualFinding["diagramType"],
  )
    ? (diagramTypeRaw as VisualFinding["diagramType"])
    : "unknown";

  const finding: VisualFinding = {
    pageNumber: typeof obj.pageNumber === "number" ? obj.pageNumber : fallbackPageNumber,
    diagramType,
  };

  if (typeof obj.title === "string") finding.title = obj.title;
  if (typeof obj.description === "string") finding.description = obj.description;
  if (typeof obj.confidence === "number") {
    finding.confidence = Math.max(0, Math.min(1, obj.confidence));
  }

  if (Array.isArray(obj.observations)) {
    finding.observations = obj.observations.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(obj.annotations)) {
    finding.annotations = obj.annotations.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(obj.uncertainties)) {
    finding.uncertainties = obj.uncertainties.filter((s): s is string => typeof s === "string");
  }

  if (obj.axes && typeof obj.axes === "object") {
    const axes: { x?: string; y?: string; legend?: string[] } = {};
    const a = obj.axes as Record<string, unknown>;
    if (typeof a.x === "string") axes.x = a.x;
    if (typeof a.y === "string") axes.y = a.y;
    if (Array.isArray(a.legend)) {
      axes.legend = (a.legend as unknown[]).filter((v): v is string => typeof v === "string");
    }
    finding.axes = axes;
  }

  if (Array.isArray(obj.nodes)) {
    finding.nodes = (obj.nodes as unknown[])
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
      .map((n) => ({
        id: typeof n.id === "string" ? n.id : "?",
        label: typeof n.label === "string" ? n.label : "",
        ...(typeof n.role === "string" ? { role: n.role } : {}),
      }));
  }

  if (Array.isArray(obj.edges)) {
    finding.edges = (obj.edges as unknown[])
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        from: typeof e.from === "string" ? e.from : "?",
        to: typeof e.to === "string" ? e.to : "?",
        ...(typeof e.label === "string" ? { label: e.label } : {}),
      }));
  }

  return { finding, parsed: true };
}
