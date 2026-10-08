/**
 * Mechanical checks (spec section 20). Deterministic, versioned, and local.
 * A rule whose checker is not mechanical (llm_rubric) is never "passed" here;
 * it is left for the voice judge and reported as unchecked when that is unavailable.
 */
import { countWords } from "./document";
import type { Anchor, Block, CheckRegion, Finding, Rule } from "./types";

export const MECHANICAL_CHECKER_VERSION = "mechanical_003";

type Range = [number, number];

/** Inline quotation spans ("…", “…”) inside a block, as [start, end) UTF-16 offsets. */
export function quotationRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const pairs: [string, string][] = [
    ["“", "”"],
    ['"', '"'],
  ];
  for (const [open, close] of pairs) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(open, from);
      if (start === -1) break;
      const end = text.indexOf(close, start + 1);
      if (end === -1) break;
      ranges.push([start, end + 1]);
      from = end + 1;
    }
  }
  return ranges;
}

function inRanges(index: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => index >= s && index < e);
}

/** Blocks a checker examines for the given region policy. */
function examinedBlocks(blocks: Block[], regions: CheckRegion): Block[] {
  return regions === "all" ? blocks : blocks.filter((b) => b.kind === "paragraph" || b.kind === "heading");
}

/** Author prose of a block with inline quotations blanked out (offsets preserved). */
function authorText(block: Block, regions: CheckRegion): { text: string; skip: Range[] } {
  const skip = regions === "all" ? [] : quotationRanges(block.text);
  return { text: block.text, skip };
}

let counter = 0;
const fid = () => `fnd_m${Date.now().toString(36)}${(counter++).toString(36)}`;

function finding(rule: Rule, anchor: Anchor | null, explanation: string, proposedAction: string, replacement?: string): Finding {
  return {
    id: fid(),
    criterion: "explicit_rules",
    dimension: rule.dimension,
    severity: rule.strength === "hard" ? "blocker" : "review",
    ruleIds: [rule.id],
    anchor,
    evidenceIds: rule.evidence.map((e) => e.id),
    explanation,
    proposedAction,
    replacement,
    source: "mechanical",
    resolution: "open",
  };
}

/** Run every mechanical checker among `rules` against a draft. */
export function runMechanicalChecks(versionId: string, blocks: Block[], rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    const checker = rule.checker;
    switch (checker.kind) {
      case "forbidden_chars": {
        for (const block of examinedBlocks(blocks, checker.regions)) {
          const { text, skip } = authorText(block, checker.regions);
          for (let i = 0; i < text.length; i++) {
            if (!checker.chars.includes(text[i]) || inRanges(i, skip)) continue;
            const ch = text[i];
            findings.push(
              finding(
                rule,
                { draftVersionId: versionId, blockId: block.id, start: i, end: i + 1, quote: ch },
                `“${describeChar(ch)}” is not used in your prose.`,
                "Rewrite the sentence without it.",
              ),
            );
          }
        }
        break;
      }
      case "forbidden_phrases": {
        for (const block of examinedBlocks(blocks, checker.regions)) {
          const { text, skip } = authorText(block, checker.regions);
          const haystack = checker.caseSensitive ? text : text.toLowerCase();
          for (const phrase of checker.phrases) {
            const needle = checker.caseSensitive ? phrase : phrase.toLowerCase();
            if (!needle) continue;
            let from = 0;
            while (from <= haystack.length) {
              const at = haystack.indexOf(needle, from);
              if (at === -1) break;
              from = at + needle.length;
              if (inRanges(at, skip) || !wordBoundary(haystack, at, needle.length)) continue;
              findings.push(
                finding(
                  rule,
                  { draftVersionId: versionId, blockId: block.id, start: at, end: at + needle.length, quote: text.slice(at, at + needle.length) },
                  `“${text.slice(at, at + needle.length)}” is on your list of phrases to avoid.`,
                  "Say it plainly in your own words.",
                ),
              );
            }
          }
        }
        break;
      }
      case "length_words": {
        const words = blocks
          .filter((b) => b.kind === "paragraph" || b.kind === "heading")
          .reduce((n, b) => n + countWords(b.text), 0);
        if (checker.min !== undefined && words < checker.min) {
          findings.push(finding(rule, null, `The draft is ${words} words; this mode expects at least ${checker.min}.`, "Develop the argument further."));
        }
        if (checker.max !== undefined && words > checker.max) {
          findings.push(finding(rule, null, `The draft is ${words} words; this mode allows at most ${checker.max}.`, "Cut to the essential points."));
        }
        break;
      }
      case "required_heading": {
        const want = checker.text.trim().toLowerCase();
        const present = blocks.some((b) => b.kind === "heading" && b.text.trim().toLowerCase() === want);
        if (!present) findings.push(finding(rule, null, `This mode requires a “${checker.text}” heading.`, "Add the heading."));
        break;
      }
      case "llm_rubric":
        break;
    }
  }
  return findings;
}

function wordBoundary(text: string, at: number, len: number): boolean {
  const before = at === 0 ? "" : text[at - 1];
  const after = text[at + len] ?? "";
  const isWord = (c: string) => /[\p{L}\p{N}]/u.test(c);
  const firstIsWord = isWord(text[at]);
  const lastIsWord = isWord(text[at + len - 1]);
  return !(firstIsWord && before && isWord(before)) && !(lastIsWord && after && isWord(after));
}

function describeChar(ch: string): string {
  const names: Record<string, string> = { "—": "—  (em dash)", "–": "–  (en dash)", "!": "!" };
  return names[ch] ?? ch;
}

/** Whether a rule can be checked without a model. */
export function isMechanical(rule: Rule): boolean {
  return rule.checker.kind !== "llm_rubric";
}

/**
 * Locked passages must remain byte-identical (FR-10). Returns ids of locked
 * blocks in `before` that are missing or changed in `after`.
 */
export function lockViolations(before: Block[], after: Block[]): string[] {
  const afterById = new Map(after.map((b) => [b.id, b]));
  return before
    .filter((b) => b.locked)
    .filter((b) => {
      const next = afterById.get(b.id);
      return !next || next.text !== b.text || next.kind !== b.kind;
    })
    .map((b) => b.id);
}
