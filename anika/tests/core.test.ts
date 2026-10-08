import { describe, expect, it } from "vitest";
import { applyPatches, deterministicMeaningSignals, resolveAnchor } from "../src/core/anchors";
import { compileContext } from "../src/core/compiler";
import { blocksFromEditorJson, editorJsonFromBlocks, markdownToBlocks } from "../src/core/document";
import { classifyFeedback, policyMayAutoCommit, proposalHash, validateCommit } from "../src/core/learning";
import { lockViolations, runMechanicalChecks } from "../src/core/mechanical";
import type { Proposal } from "../src/core/types";
import { CONNECTED_RULE, EM_DASH_RULE, example, p, persona, project, rule } from "./fixtures";

describe("context compiler", () => {
  it("AT-02: article-only guidance does not enter email context", () => {
    const rev = persona([EM_DASH_RULE, CONNECTED_RULE]);
    const essay = compileContext({ revision: rev, project: project(), examples: [], decisions: [] });
    const email = compileContext({ revision: rev, project: project({ modeId: "mode_email" }), examples: [], decisions: [] });
    expect(essay.manifest.active_rule_ids).toEqual(["rule_connected_argument", "rule_no_em_dash"]);
    expect(email.manifest.active_rule_ids).toEqual(["rule_no_em_dash"]);
    expect(email.manifest.excluded).toContainEqual({ id: "rule_connected_argument", reason: "other_mode" });
  });

  it("AT-03: an explicit task exception suspends a rule only for that project", () => {
    const rev = persona([EM_DASH_RULE, CONNECTED_RULE]);
    const withException = project({ exceptions: [{ id: "exc_1", ruleId: "rule_connected_argument", note: "Listicle", approvedByWriter: false, createdAt: "x" }] });
    const ctx = compileContext({ revision: rev, project: withException, examples: [], decisions: [] });
    expect(ctx.manifest.active_rule_ids).toEqual(["rule_no_em_dash"]);
    expect(ctx.manifest.exception_ids).toEqual(["exc_1"]);
    const other = compileContext({ revision: rev, project: project({ id: "project_two" }), examples: [], decisions: [] });
    expect(other.manifest.active_rule_ids).toContain("rule_connected_argument");
  });

  it("hard rules need writer approval before a task exception applies", () => {
    const rev = persona([EM_DASH_RULE]);
    const unapproved = project({ exceptions: [{ id: "exc_1", ruleId: "rule_no_em_dash", note: "", approvedByWriter: false, createdAt: "x" }] });
    expect(compileContext({ revision: rev, project: unapproved, examples: [], decisions: [] }).manifest.active_rule_ids).toEqual(["rule_no_em_dash"]);
  });

  it("AT-07/AT-19: excludes held-out, inspiration, other-persona, and evaluation-target examples with reasons", () => {
    const rev = persona([]);
    const examples = [
      example({ id: "example_ok" }),
      example({ id: "example_held", split: "heldout" }),
      example({ id: "example_insp", provenance: "inspiration" }),
      example({ id: "example_other", personaId: "persona_someone" }),
      example({ id: "example_pending", status: "pending" }),
      example({ id: "example_target" }),
    ];
    const ctx = compileContext({ revision: rev, project: project(), examples, decisions: [], excludeIds: ["example_target"] });
    expect(ctx.manifest.example_ids).toEqual(["example_ok"]);
    const reasons = Object.fromEntries(ctx.manifest.excluded.map((e) => [e.id, e.reason]));
    expect(reasons).toMatchObject({
      example_held: "held_out_family",
      example_insp: "inspiration_only",
      example_other: "other_persona",
      example_pending: "not_approved",
      example_target: "evaluation_target",
    });
  });

  it("keeps at most one example per document family and at most four", () => {
    const examples = ["a", "b", "c", "d", "e"].map((x) => example({ id: `example_${x}` }));
    examples.push(example({ id: "example_sibling", familyId: "family_example_a" }));
    const ctx = compileContext({ revision: persona([]), project: project(), examples, decisions: [] });
    expect(ctx.manifest.example_ids).toHaveLength(4);
    expect(new Set(ctx.manifest.example_ids).size).toBe(4);
  });

  it("is deterministic for identical inputs and changes hash when memory changes", () => {
    const rev = persona([EM_DASH_RULE]);
    const a = compileContext({ revision: rev, project: project(), examples: [example({ id: "example_a" })], decisions: [] });
    const b = compileContext({ revision: rev, project: project(), examples: [example({ id: "example_a" })], decisions: [] });
    expect(a.manifest.context_hash).toBe(b.manifest.context_hash);
    expect(a.manifest.context_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const c = compileContext({ revision: persona([EM_DASH_RULE, rule({ id: "rule_x", statement: "Be brief." })]), project: project(), examples: [], decisions: [] });
    expect(c.manifest.context_hash).not.toBe(a.manifest.context_hash);
  });

  it("refuses with PROFILE_TOO_LARGE instead of summarizing core rules away", () => {
    const big = Array.from({ length: 30 }, (_, i) => rule({ id: `rule_${i}`, statement: "x".repeat(400) }));
    expect(() => compileContext({ revision: persona(big), project: project(), examples: [], decisions: [] }, { tokenBudget: 1000, maxExamples: 4, maxDecisions: 6, excerptChars: 1000, processorPolicyRevision: "p" })).toThrowError(/exceed/);
  });
});

describe("mechanical checks", () => {
  it("AT-08: finds seeded em dashes in prose but not in quotations or block quotes", () => {
    const blocks = [
      p("b1", "The argument holds—mostly."),
      p("b2", "She wrote “the end—or not” and left."),
      { id: "b3", kind: "quote" as const, text: "A quoted—dash." },
    ];
    const findings = runMechanicalChecks("v1", blocks, [EM_DASH_RULE]);
    expect(findings).toHaveLength(1);
    expect(findings[0].anchor).toMatchObject({ blockId: "b1", start: 18, end: 19, quote: "—" });
    expect(findings[0].severity).toBe("blocker");
  });

  it("matches forbidden phrases on word boundaries, case-insensitively", () => {
    const r = rule({ id: "rule_p", statement: "Avoid filler.", checker: { kind: "forbidden_phrases", phrases: ["delve"], caseSensitive: false, regions: "author_prose" } });
    const findings = runMechanicalChecks("v1", [p("b1", "Let us Delve in. Delved? delves.")], [r]);
    expect(findings.map((f) => f.anchor?.quote)).toEqual(["Delve"]);
  });

  it("does not pass rubric-only rules mechanically", () => {
    expect(runMechanicalChecks("v1", [p("b1", "x")], [CONNECTED_RULE])).toEqual([]);
  });

  it("checks length bounds and required headings", () => {
    const len = rule({ id: "rule_len", statement: "Short.", checker: { kind: "length_words", max: 3 } });
    const head = rule({ id: "rule_h", statement: "Has summary.", checker: { kind: "required_heading", text: "Summary" } });
    const f = runMechanicalChecks("v1", [p("b1", "one two three four")], [len, head]);
    expect(f.map((x) => x.ruleIds[0])).toEqual(["rule_len", "rule_h"]);
  });
});

describe("anchors, patches, and meaning", () => {
  it("rejects anchors whose quote does not match the stored draft", () => {
    const blocks = [p("b1", "Exact text here.")];
    expect(resolveAnchor("v1", blocks, "b1", "text here")).toMatchObject({ start: 6, end: 15 });
    expect(resolveAnchor("v1", blocks, "b1", "invented")).toBeNull();
    expect(resolveAnchor("v1", blocks, "b9", "Exact")).toBeNull();
  });

  it("AT-11: locked text stays byte-identical; stale and ambiguous patches are rejected", () => {
    const blocks = [p("b1", "Keep this exactly.", { locked: true }), p("b2", "fix this, fix this."), p("b3", "Change me.")];
    const result = applyPatches(blocks, [
      { blockId: "b1", find: "Keep", replace: "Alter", findingIds: [] },
      { blockId: "b2", find: "fix this", replace: "x", findingIds: [] },
      { blockId: "b3", find: "not present", replace: "x", findingIds: [] },
      { blockId: "b3", find: "Change me", replace: "Changed", findingIds: [] },
    ]);
    expect(result.blocks[0].text).toBe("Keep this exactly.");
    expect(result.rejected.map((r) => r.reason)).toEqual(["locked", "ambiguous_match", "stale_patch"]);
    expect(result.blocks[2].text).toBe("Changed.");
    expect(lockViolations(blocks, result.blocks)).toEqual([]);
    expect(lockViolations(blocks, [p("b1", "Keep this exactly!")])).toEqual(["b1"]);
  });

  it("AT-10: flags altered numbers, dropped qualifications, and invented first-person experience", () => {
    const before = [p("b1", "Revenue may grow 12% next year."), p("b2", "The market shifted."), p("b3", "Nothing changes.")];
    const after = [p("b1", "Revenue will grow 15% next year."), p("b2", "When I ran the company, the market shifted."), p("b3", "Nothing changes.")];
    const kinds = deterministicMeaningSignals(before, after).map((s) => `${s.blockId}:${s.kind}`);
    expect(kinds).toEqual(["b1:number_changed", "b1:qualifier_removed", "b2:first_person_added"]);
  });
});

describe("documents", () => {
  it("round-trips blocks through editor JSON, keeping ids, locks, and quotes", () => {
    const blocks = [
      { id: "h1", kind: "heading" as const, level: 2, text: "Title" },
      p("b1", "Line one\nline two", { locked: true }),
      { id: "q1", kind: "quote" as const, text: "Quoted." },
    ];
    expect(blocksFromEditorJson(editorJsonFromBlocks(blocks))).toEqual(blocks);
  });

  it("AT-04: imports Markdown preserving paragraphs, headings, and quotations", () => {
    let n = 0;
    const blocks = markdownToBlocks("# Head\n\nPara one\ncontinues.\n\n> A quote\n\nPara two.", () => `blk_${n++}`);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([
      ["heading", "Head"],
      ["paragraph", "Para one continues."],
      ["quote", "A quote"],
      ["paragraph", "Para two."],
    ]);
  });
});

describe("learning policy", () => {
  const base = { personaId: "persona_carlo", baseRevision: "rev_002", changes: [], rawFeedback: "x", classification: ["style" as const] };
  const proposal: Proposal = { ...base, id: "prop_1", title: "t", origin: "correction", status: "pending", createdAt: "x", hash: proposalHash(base) };

  it("AT-13: approval must quote the exact proposal hash and current revision", () => {
    expect(() => validateCommit(proposal, "sha256:wrong", "rev_002", "rev_002")).toThrowError(/does not match/);
    expect(() => validateCommit(proposal, proposal.hash, "rev_002", "rev_003")).toThrowError(/changed/);
    expect(() => validateCommit(proposal, proposal.hash, "rev_002", "rev_002")).not.toThrow();
  });

  it("keeps task instructions and factual corrections out of voice memory", () => {
    expect(classifyFeedback("Make this shorter").enduring).toBe(false);
    expect(classifyFeedback("The date is wrong, it should be 2019").enduring).toBe(false);
    expect(classifyFeedback("Too many disconnected one-line paragraphs. Develop the argument.")).toMatchObject({ enduring: true });
  });

  it("standing policy never auto-commits core-scoped or ambiguous corrections", () => {
    expect(policyMayAutoCommit("remember_explicit", ["style"], "mode")).toBe(true);
    expect(policyMayAutoCommit("remember_explicit", ["style"], "core")).toBe(false);
    expect(policyMayAutoCommit("remember_explicit", ["unknown"], "mode")).toBe(false);
    expect(policyMayAutoCommit("review", ["style"], "mode")).toBe(false);
  });
});
