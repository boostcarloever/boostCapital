/**
 * Context compiler (spec section 18). A mandatory native step that turns
 * pinned persona memory into a bounded, immutable context package plus a
 * manifest of what was included, excluded, or superseded.
 *
 * Deterministic: identical inputs and configuration give an identical hash.
 */
import { digest } from "./hash";
import type {
  ContextPackage,
  Decision,
  Example,
  ExcludedItem,
  Id,
  PersonaRevision,
  Project,
  Rule,
} from "./types";
import { AnikaError } from "./types";

export const COMPILER_VERSION = "compiler_002";

export interface CompilerConfig {
  /** Total context budget in estimated tokens. */
  tokenBudget: number;
  maxExamples: number;
  maxDecisions: number;
  /** Characters per example excerpt. */
  excerptChars: number;
  processorPolicyRevision: string;
}

export const DEFAULT_COMPILER_CONFIG: CompilerConfig = {
  tokenBudget: 24_000,
  maxExamples: 4,
  maxDecisions: 6,
  excerptChars: 1_400,
  processorPolicyRevision: "policy_001",
};

export interface CompileInput {
  revision: PersonaRevision;
  project: Project;
  examples: Example[];
  decisions: Decision[];
  /** Ids that must never enter context (current evaluation target, deleted sources). */
  excludeIds?: Id[];
}

/** Rough token estimate with a 15% safety margin; real limits come from the provider. */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.15);
}

/** Whether an active rule applies in the selected mode. */
export function ruleApplies(rule: Rule, modeId: Id): boolean {
  if (rule.status !== "active") return false;
  return rule.scope.kind === "core" || rule.scope.modeIds.includes(modeId);
}

export function compileContext(input: CompileInput, config: CompilerConfig = DEFAULT_COMPILER_CONFIG): ContextPackage {
  const { revision, project, examples, decisions } = input;
  const excludeIds = new Set(input.excludeIds ?? []);
  const excluded: ExcludedItem[] = [];

  if (project.personaId !== revision.persona.id) {
    throw new AnikaError("PROFILE_CONFLICT", "Project belongs to a different persona than the pinned revision.");
  }
  const mode = revision.modes.find((m) => m.id === project.modeId);
  if (!mode) throw new AnikaError("PROFILE_MISSING", `Mode ${project.modeId} does not exist in ${revision.id}.`);

  /* Rules: filter, then reconcile task exceptions. */
  const exceptionByRule = new Map(project.exceptions.map((e) => [e.ruleId, e]));
  const rules: Rule[] = [];
  const exceptionIds: Id[] = [];
  for (const rule of revision.rules) {
    if (rule.status !== "active") continue;
    if (!ruleApplies(rule, mode.id)) {
      excluded.push({ id: rule.id, reason: "other_mode" });
      continue;
    }
    const exception = exceptionByRule.get(rule.id);
    if (exception && (rule.strength !== "hard" || exception.approvedByWriter)) {
      exceptionIds.push(exception.id);
      excluded.push({ id: rule.id, reason: "task_exception" });
      continue;
    }
    rules.push(rule);
  }
  rules.sort((a, b) => a.id.localeCompare(b.id));

  const coreText = rules.map((r) => r.statement + r.exceptions.join(" ")).join("\n");
  const fixedTokens = estimateTokens(coreText) + estimateTokens(project.brief) + estimateTokens(mode.description);
  if (fixedTokens > config.tokenBudget) {
    throw new AnikaError(
      "PROFILE_TOO_LARGE",
      "Active rules alone exceed the context budget. Consolidate rules rather than letting Anika summarize prohibitions away.",
      { fixedTokens, budget: config.tokenBudget },
    );
  }
  let remaining = config.tokenBudget - fixedTokens;

  /* Examples: filter before ranking. */
  const eligible: Example[] = [];
  for (const ex of examples) {
    const reason = exampleExclusion(ex, revision.persona.id, mode.id, excludeIds);
    if (reason) excluded.push({ id: ex.id, reason });
    else eligible.push(ex);
  }
  eligible.sort(
    (a, b) =>
      Number(b.highlights.length > 0) - Number(a.highlights.length > 0) ||
      Number(b.modeId === mode.id) - Number(a.modeId === mode.id) ||
      b.createdAt.localeCompare(a.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const seenFamilies = new Set<string>();
  const chosenExamples: ContextPackage["examples"] = [];
  for (const ex of eligible) {
    if (seenFamilies.has(ex.familyId)) {
      excluded.push({ id: ex.id, reason: "same_family_as_selected" });
      continue;
    }
    if (chosenExamples.length >= config.maxExamples) {
      excluded.push({ id: ex.id, reason: "example_limit" });
      continue;
    }
    const excerpt = exampleExcerpt(ex, config.excerptChars);
    const cost = estimateTokens(excerpt);
    if (cost > remaining) {
      excluded.push({ id: ex.id, reason: "token_budget" });
      continue;
    }
    remaining -= cost;
    seenFamilies.add(ex.familyId);
    chosenExamples.push({ id: ex.id, title: ex.title, excerpt });
  }

  /* Decisions: same persona, applicable scope, most recent first. */
  const chosenDecisions: ContextPackage["decisions"] = [];
  const sortedDecisions = [...decisions].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const d of sortedDecisions) {
    if (d.personaId !== revision.persona.id) {
      excluded.push({ id: d.id, reason: "other_persona" });
      continue;
    }
    if (d.kind !== "correction" || excludeIds.has(d.id)) continue;
    const applicable = d.approvedScope === "core" || (d.approvedScope === "mode" && d.modeId === mode.id) || (d.approvedScope === "task" && d.projectId === project.id);
    if (!applicable) {
      excluded.push({ id: d.id, reason: d.approvedScope ? "other_scope" : "scope_not_approved" });
      continue;
    }
    if (chosenDecisions.length >= config.maxDecisions) {
      excluded.push({ id: d.id, reason: "decision_limit" });
      continue;
    }
    const cost = estimateTokens(d.before + (d.after ?? "") + d.rawFeedback);
    if (cost > remaining) {
      excluded.push({ id: d.id, reason: "token_budget" });
      continue;
    }
    remaining -= cost;
    chosenDecisions.push({ id: d.id, before: d.before, after: d.after, feedback: d.rawFeedback });
  }

  const body = {
    rules: rules.map((r) => ({ id: r.id, statement: r.statement, exceptions: r.exceptions, strength: r.strength, checker: r.checker })),
    examples: chosenExamples,
    decisions: chosenDecisions,
    brief: project.brief,
    mode,
  };
  const projectRevision = digest({ brief: project.brief, exceptions: project.exceptions }).slice(0, 19);
  const manifestBase = {
    schema_version: "1.0" as const,
    persona_id: revision.persona.id,
    persona_revision: revision.id,
    mode_id: mode.id,
    project_revision: projectRevision,
    active_rule_ids: rules.map((r) => r.id),
    exception_ids: exceptionIds.sort(),
    example_ids: chosenExamples.map((e) => e.id),
    decision_ids: chosenDecisions.map((d) => d.id),
    excluded: excluded.sort((a, b) => a.id.localeCompare(b.id) || a.reason.localeCompare(b.reason)),
    compiler_version: COMPILER_VERSION,
    processor_policy_revision: config.processorPolicyRevision,
    estimated_tokens: config.tokenBudget - remaining,
  };
  const context_hash = digest({ manifest: manifestBase, body });

  return {
    manifest: { ...manifestBase, context_hash },
    rules,
    examples: chosenExamples,
    decisions: chosenDecisions,
    brief: project.brief,
    mode,
  };
}

function exampleExclusion(ex: Example, personaId: Id, modeId: Id, excludeIds: Set<Id>): string | null {
  if (ex.personaId !== personaId) return "other_persona";
  if (excludeIds.has(ex.id)) return "evaluation_target";
  if (ex.status !== "approved") return "not_approved";
  if (ex.provenance === "inspiration") return "inspiration_only";
  if (ex.split === "heldout") return "held_out_family";
  if (ex.modeId && ex.modeId !== modeId) return "other_mode";
  return null;
}

/** Highlighted passages first ("this is very me"), else the opening author prose. */
export function exampleExcerpt(ex: Example, maxChars: number): string {
  const excluded = new Set(ex.excludedBlockIds);
  const byId = new Map(ex.blocks.map((b) => [b.id, b]));
  const highlighted = ex.highlights
    .map((h) => byId.get(h.blockId)?.text.slice(h.start, h.end))
    .filter((t): t is string => Boolean(t));
  const source = highlighted.length
    ? highlighted
    : ex.blocks.filter((b) => !excluded.has(b.id) && b.kind === "paragraph").map((b) => b.text);
  let out = "";
  for (const part of source) {
    if (out.length + part.length + 2 > maxChars) {
      if (!out) out = part.slice(0, maxChars);
      break;
    }
    out += (out ? "\n\n" : "") + part;
  }
  return out;
}
