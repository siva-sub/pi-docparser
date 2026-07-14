import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { extname, isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * Validates a remote HTTP(S) URL and returns a normalized absolute URL string.
 * Rejects any non-HTTP(S) scheme. Throws on user input. Designed to be safe to
 * include in error messages without leaking secrets.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.endsWith(".localhost")
  );
}

export function normalizeRemoteUrl(
  input: string,
  options: { allowLoopback?: boolean } = {},
): string {
  if (typeof input !== "string") {
    throw new Error("Remote URL must be a string");
  }
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Remote URL must not be empty");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid remote URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Remote URL protocol must be http or https, got: ${parsed.protocol}`);
  }

  if (!options.allowLoopback) {
    const host = parsed.hostname.toLowerCase();
    if (isLoopbackHost(host)) {
      throw new Error(
        `Remote URL host ${host} is loopback. Loopback URLs are not remote and must not be passed with allowCloud.`,
      );
    }
  }

  // Drop any embedded credentials before sending to the network.
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }

  return parsed.toString();
}

/**
 * Mask a secret string for logging. The first 4 chars are kept if available
 * and the rest is replaced with ellipsis so anyone scanning logs can still
 * distinguish keys without exposing the secret.
 */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "<empty>";
  if (secret.length <= 4) return "***";
  return `${secret.slice(0, 4)}***`;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeDocumentPathInput(input: string): string {
  return input.trim().replace(/^@/, "").replace(UNICODE_SPACES, " ");
}

function expandHomeDirectory(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return `${homedir()}${filePath.slice(1)}`;
  return filePath;
}

export function tryMacOsAmPmVariant(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

export function tryNfdVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

export function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExistingPath(filePath: string, cwd: string): Promise<string> {
  const expanded = expandHomeDirectory(filePath);
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  const nfdVariant = tryNfdVariant(resolved);

  for (const candidate of new Set([
    resolved,
    tryMacOsAmPmVariant(resolved),
    nfdVariant,
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(nfdVariant),
  ])) {
    if (await pathExists(candidate)) return candidate;
  }

  return resolved;
}

export function isPdfExtension(extension: string): boolean {
  return extension === ".pdf";
}

export function getImageExtension(extension: string): boolean {
  const e = extension.toLowerCase();
  return (
    e === ".png" ||
    e === ".jpg" ||
    e === ".jpeg" ||
    e === ".webp" ||
    e === ".gif" ||
    e === ".bmp" ||
    e === ".tif" ||
    e === ".tiff"
  );
}

export function safeMkdtemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function ensureDir(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
  void normalizeDocumentPathInput; // reserved for future normalization helpers
}

export { extname, resolvePath, tmpdir };
