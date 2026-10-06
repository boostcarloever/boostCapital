/**
 * Anchors, patches, and deterministic meaning comparisons.
 *
 * Model output is untrusted: every anchor it proposes is re-derived from the
 * exact stored draft, and every patch must match the candidate's current text.
 */
import type { Anchor, Block, Id } from "./types";
import { AnikaError } from "./types";

/**
 * Resolve a quoted span inside a block of a specific version. Returns null
 * when the quote does not occur exactly; callers must reject such findings.
 * When the quote occurs more than once, `occurrence` (0-based) picks one.
 */
export function resolveAnchor(versionId: Id, blocks: Block[], blockId: Id, quote: string, occurrence = 0): Anchor | null {
  const block = blocks.find((b) => b.id === blockId);
  if (!block || !quote) return null;
  let at = -1;
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    at = block.text.indexOf(quote, from);
    if (at === -1) return null;
    from = at + 1;
  }
  return { draftVersionId: versionId, blockId, start: at, end: at + quote.length, quote };
}

/** Verify a stored anchor still matches the exact text it claims to quote. */
export function anchorIsValid(anchor: Anchor, versionId: Id, blocks: Block[]): boolean {
  if (anchor.draftVersionId !== versionId) return false;
  const block = blocks.find((b) => b.id === anchor.blockId);
  return Boolean(block && block.text.slice(anchor.start, anchor.end) === anchor.quote);
}

export interface Patch {
  blockId: Id;
  find: string;
  replace: string;
  /** Finding ids this patch addresses. */
  findingIds: Id[];
}

export interface PatchResult {
  blocks: Block[];
  applied: Patch[];
  rejected: { patch: Patch; reason: string }[];
}

/**
 * Apply bounded patches against a specific version. Locked blocks, unknown
 * blocks, and quotes that do not match exactly are rejected (never guessed).
 */
export function applyPatches(blocks: Block[], patches: Patch[]): PatchResult {
  const next = blocks.map((b) => ({ ...b }));
  const applied: Patch[] = [];
  const rejected: PatchResult["rejected"] = [];
  for (const patch of patches) {
    const block = next.find((b) => b.id === patch.blockId);
    if (!block) {
      rejected.push({ patch, reason: "unknown_block" });
      continue;
    }
    if (block.locked) {
      rejected.push({ patch, reason: "locked" });
      continue;
    }
    if (block.kind === "quote" || block.kind === "code") {
      rejected.push({ patch, reason: "quotation_or_code" });
      continue;
    }
    const at = block.text.indexOf(patch.find);
    if (!patch.find || at === -1) {
      rejected.push({ patch, reason: "stale_patch" });
      continue;
    }
    if (block.text.indexOf(patch.find, at + 1) !== -1) {
      rejected.push({ patch, reason: "ambiguous_match" });
      continue;
    }
    block.text = block.text.slice(0, at) + patch.replace + block.text.slice(at + patch.find.length);
    applied.push(patch);
  }
  return { blocks: next, applied, rejected };
}

/** Throws STALE_PATCH when a client applies a patch made for another version. */
export function assertPatchBase(expectedVersionId: Id, actualHeadId: Id | null): void {
  if (expectedVersionId !== actualHeadId) {
    throw new AnikaError("STALE_PATCH", "The draft changed since this suggestion was made. Re-run the check.");
  }
}

/* ------------------------------------------------- deterministic meaning */

const NUMBER_RE = /(?:[$€£¥]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|million|billion|thousand|k|m|bn)?/gi;
const NEGATIONS = ["not", "no", "never", "none", "cannot", "can't", "won't", "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "without"];
const QUALIFIERS = ["may", "might", "could", "perhaps", "likely", "probably", "possibly", "some", "often", "usually", "roughly", "about", "approximately", "almost", "arguably"];
const FIRST_PERSON = /\b(I|I'm|I've|I'd|me|my|we|we've|our)\b/;

function numbers(text: string): string[] {
  return (text.match(NUMBER_RE) ?? []).map((n) => n.replace(/\s+/g, "").toLowerCase()).sort();
}

function wordsIn(list: string[], text: string): string[] {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ")} `;
  return list.filter((w) => lower.includes(` ${w} `));
}

export interface MeaningSignal {
  blockId: Id;
  kind: "number_changed" | "negation_changed" | "qualifier_removed" | "first_person_added" | "block_removed";
  before: string;
  after: string;
  detail: string;
}

/**
 * Exact comparisons between an original and a candidate, block by block.
 * An identical number does not prove an identical assertion: these signals are
 * necessary checks, combined with the semantic meaning judge when available.
 */
export function deterministicMeaningSignals(before: Block[], after: Block[]): MeaningSignal[] {
  const signals: MeaningSignal[] = [];
  const afterById = new Map(after.map((b) => [b.id, b]));
  for (const b of before) {
    if (b.kind === "code") continue;
    const a = afterById.get(b.id);
    if (!a) {
      if (b.text.trim()) signals.push({ blockId: b.id, kind: "block_removed", before: b.text, after: "", detail: "A paragraph was removed." });
      continue;
    }
    if (a.text === b.text) continue;
    const nb = numbers(b.text).join("|");
    const na = numbers(a.text).join("|");
    if (nb !== na) {
      signals.push({ blockId: b.id, kind: "number_changed", before: b.text, after: a.text, detail: `Figures changed: ${nb || "none"} → ${na || "none"}.` });
    }
    const negB = wordsIn(NEGATIONS, b.text).length;
    const negA = wordsIn(NEGATIONS, a.text).length;
    if (negB !== negA) {
      signals.push({ blockId: b.id, kind: "negation_changed", before: b.text, after: a.text, detail: "A negation was added or removed." });
    }
    const lostQualifiers = wordsIn(QUALIFIERS, b.text).filter((q) => !wordsIn([q], a.text).length);
    if (lostQualifiers.length) {
      signals.push({ blockId: b.id, kind: "qualifier_removed", before: b.text, after: a.text, detail: `Qualification dropped: “${lostQualifiers.join("”, “")}”.` });
    }
    if (!FIRST_PERSON.test(b.text) && FIRST_PERSON.test(a.text)) {
      signals.push({ blockId: b.id, kind: "first_person_added", before: b.text, after: a.text, detail: "A first-person statement appeared that was not in the original." });
    }
  }
  return signals;
}
