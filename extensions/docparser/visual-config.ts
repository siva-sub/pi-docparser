/**
 * Settings helpers for the visual analysis feature.
 *
 * Pi extensions do not expose a first-class settings API for registering custom
 * persistent config. We use the existing pattern of reading environment
 * variables (PI_DOCPARSER_*) which the user can put in `~/.bashrc` or process
 * manager. Defaults are safe: no cloud calls, no model override, no remote URL.
 */

import { normalizeRemoteUrl } from "./util.ts";

export interface VisualAnalysisConfig {
  /** Whether remote model calls are allowed. Default false. */
  allowCloud: boolean;
  /**
   * Optional OpenAI-compatible base URL for a remote vision model. The
   * `/v1/chat/completions` endpoint is used. Examples:
   *   - "http://127.0.0.1:11434/v1" (Ollama, not remote; allowed)
   *   - "https://api.z.ai/v1"
   *   - "https://api.deepseek.com/v1"
   * Loopback URLs are accepted without allowCloud since they are local.
   */
  baseUrl?: string;
  /** Model id forwarded to the remote provider. */
  model?: string;
  /** API key forwarded as Authorization: Bearer. */
  apiKey?: string;
  /** Default DPI for screenshots. */
  dpi: number;
}

export const VISUAL_CONFIG_DEFAULTS: VisualAnalysisConfig = {
  allowCloud: false,
  dpi: 220,
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  return fallback;
}

/**
 * Resolve the active visual analysis configuration from process.env.
 * Honors PI_DOCPARSER_ALLOW_CLOUD, PI_DOCPARSER_VISUAL_BASE_URL,
 * PI_DOCPARSER_VISUAL_MODEL, PI_DOCPARSER_VISUAL_API_KEY, and
 * PI_DOCPARSER_VISUAL_DPI. Loopback base URLs are always allowed.
 */
export function loadVisualAnalysisConfig(): VisualAnalysisConfig {
  const allowCloud = parseBoolean(readEnv("PI_DOCPARSER_ALLOW_CLOUD"), false);
  const dpiValue = Number.parseInt(readEnv("PI_DOCPARSER_VISUAL_DPI") ?? "", 10);
  const dpi = Number.isInteger(dpiValue) && dpiValue >= 72 && dpiValue <= 600 ? dpiValue : 220;

  const baseUrlRaw = readEnv("PI_DOCPARSER_VISUAL_BASE_URL");
  const modelRaw = readEnv("PI_DOCPARSER_VISUAL_MODEL");
  const apiKeyRaw = readEnv("PI_DOCPARSER_VISUAL_API_KEY");

  let baseUrl: string | undefined;
  if (baseUrlRaw) {
    const isLoopback = /^(https?:\/\/)?(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)/i.test(baseUrlRaw);
    try {
      baseUrl = normalizeRemoteUrl(baseUrlRaw, { allowLoopback: isLoopback });
    } catch {
      // Drop invalid config silently; tool execution will surface the error
      // only if the user actually requests visual analysis.
      baseUrl = undefined;
    }
  }

  return {
    allowCloud,
    baseUrl,
    model: modelRaw,
    apiKey: apiKeyRaw,
    dpi,
  };
}

/**
 * Validate a user-supplied VisualAnalysisConfig. Used by the tool execute
 * function. Returns a list of human-readable errors; empty list means ok.
 */
export function isCloudModelId(model: string | undefined): boolean {
  if (!model) return false;
  return /(?:^|[.:_/-])cloud(?:$|[.:_/-])/i.test(model);
}

/**
 * Remote means anything that is not positively loopback-local, plus explicit
 * cloud provider/model markers that may proxy through a local Ollama endpoint.
 */
export function isRemoteVisualTarget(input: {
  baseUrl?: string;
  model?: string;
  provider?: string;
}): boolean {
  if (isCloudModelId(input.model) || /cloud/i.test(input.provider ?? "")) return true;
  return !isLocalBaseUrl(input.baseUrl);
}

export function validateVisualAnalysisConfig(config: VisualAnalysisConfig): string[] {
  const errors: string[] = [];

  if (config.dpi < 72 || config.dpi > 600) {
    errors.push(`dpi must be between 72 and 600, got ${config.dpi}`);
  }

  if (config.baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      errors.push(`baseUrl is not a valid URL: ${config.baseUrl}`);
      return errors;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push(`baseUrl protocol must be http or https, got ${parsed.protocol}`);
    }
    const host = parsed.hostname.toLowerCase();
    if (
      isRemoteVisualTarget({ baseUrl: config.baseUrl, model: config.model }) &&
      !config.allowCloud
    ) {
      errors.push(
        `visual target ${host} is remote or cloud-routed but allowCloud is false. Set PI_DOCPARSER_ALLOW_CLOUD=1 or pass allowCloud=true in the tool call.`,
      );
    }
  }

  if (config.baseUrl && !config.model) {
    errors.push(
      "model is required when baseUrl is provided (e.g. model='qwen3.5:397b' or 'gpt-5.4-mini').",
    );
  }

  return errors;
}

/**
 * Decide whether a candidate baseUrl is a local/loopback address. Used to
 * short-circuit the allowCloud gate for fully local OpenAI-compatible servers
 * (Ollama, vLLM, LM Studio). These still use the network stack but never
 * leave the machine.
 */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}
