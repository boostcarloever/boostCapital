import { createHash, randomBytes } from "node:crypto";

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Hashes are
 * computed over this form so they are stable across key-order differences.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256 digest of the canonical serialization, prefixed with the algorithm. */
export function digest(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/** Opaque, stable identifier with a readable type prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function now(): string {
  return new Date().toISOString();
}
