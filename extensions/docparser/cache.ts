/**
 * Cache layer for parsed document results.
 *
 * Uses an LRU map keyed by a content hash (SHA-256 of file path + mtime)
 * so re-parsing the same file in a session returns the cached result.
 * The cache lives in memory for the duration of the pi session.
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

export interface CacheEntry<T = unknown> {
  hash: string;
  data: T;
  timestamp: number;
}

export class DocumentCache<T = unknown> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /** Compute a content hash for a file path + mtime. */
  static async hashFile(filePath: string): Promise<string> {
    try {
      const s = await stat(filePath);
      return createHash("sha256")
        .update(filePath)
        .update(String(s.mtimeMs))
        .update(String(s.size))
        .digest("hex")
        .slice(0, 16);
    } catch {
      // File doesn't exist or can't be stat'd — use path-only hash
      return createHash("sha256").update(filePath).digest("hex").slice(0, 16);
    }
  }

  get(hash: string): T | undefined {
    const entry = this.map.get(hash);
    if (!entry) return undefined;
    // LRU: move to end
    this.map.delete(hash);
    this.map.set(hash, entry);
    return entry.data;
  }

  set(hash: string, data: T): void {
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(hash, { hash, data, timestamp: Date.now() });
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
