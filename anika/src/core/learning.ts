/**
 * Feedback capture and memory promotion (spec sections 9 and 21).
 *
 * A model may propose; only a trusted UI action tied to the exact proposal
 * hash (or a bounded, previously enabled explicit-correction policy) commits.
 */
import { digest } from "./hash";
import type { Id, PersonaMeta, PersonaRevision, Proposal, ReasonLabel, Rule, RuleChange } from "./types";
import { AnikaError } from "./types";

/** Hash over the proposal's substance; approval must quote it exactly. */
export function proposalHash(p: Pick<Proposal, "personaId" | "baseRevision" | "changes" | "rawFeedback" | "classification">): string {
  return digest({ personaId: p.personaId, baseRevision: p.baseRevision, changes: p.changes, rawFeedback: p.rawFeedback ?? null, classification: p.classification });
}

/** Hash over a revision snapshot (everything except the hash itself). */
export function revisionHash(r: Omit<PersonaRevision, "hash">): string {
  return digest(r);
}

/** Apply rule changes to a rule list, producing new rule objects. */
export function applyChanges(rules: Rule[], changes: RuleChange[], at: string): Rule[] {
  let next = rules.map((r) => ({ ...r }));
  for (const change of changes) {
    if (change.op === "add") {
      if (next.some((r) => r.id === change.rule.id)) throw new AnikaError("PROFILE_CONFLICT", `Rule ${change.rule.id} already exists.`);
      next.push({ ...change.rule, status: "active", updatedAt: at });
    } else {
      const target = next.find((r) => r.id === change.ruleId);
      if (!target) throw new AnikaError("NOT_FOUND", `Rule ${change.ruleId} does not exist in this revision.`);
      if (change.op === "retire") {
        next = next.map((r) => (r.id === change.ruleId ? { ...r, status: "retired", updatedAt: at } : r));
      } else {
        next = next.map((r) => (r.id === change.ruleId ? { ...r, ...change.patch, updatedAt: at } : r));
      }
    }
  }
  return next;
}

/** Build the next immutable revision from a parent. */
export function nextRevision(
  parent: PersonaRevision,
  update: { rules?: Rule[]; persona?: PersonaMeta; modes?: PersonaRevision["modes"] },
  operation: string,
  actor: PersonaRevision["actor"],
  at: string,
): PersonaRevision {
  const number = parent.number + 1;
  const base: Omit<PersonaRevision, "hash"> = {
    id: `rev_${String(number).padStart(3, "0")}`,
    number,
    parent: parent.id,
    persona: update.persona ?? parent.persona,
    modes: update.modes ?? parent.modes,
    rules: update.rules ?? parent.rules,
    operation,
    actor,
    createdAt: at,
  };
  return { ...base, hash: revisionHash(base) };
}

export function firstRevision(persona: PersonaMeta, modes: PersonaRevision["modes"], at: string): PersonaRevision {
  const base: Omit<PersonaRevision, "hash"> = {
    id: "rev_001",
    number: 1,
    parent: null,
    persona,
    modes,
    rules: [],
    operation: "Created persona",
    actor: "user",
    createdAt: at,
  };
  return { ...base, hash: revisionHash(base) };
}

/**
 * Validate a commit request. Approval must name the exact proposal hash and
 * the revision the writer saw; anything else is a VERSION_CONFLICT.
 */
export function validateCommit(proposal: Proposal, approvalHash: string, expectedRevision: Id, headRevision: Id): void {
  if (proposal.status !== "pending") throw new AnikaError("PROFILE_CONFLICT", "This proposal was already resolved.");
  if (approvalHash !== proposal.hash || proposalHash(proposal) !== proposal.hash) {
    throw new AnikaError("PROFILE_CONFLICT", "Approval does not match this proposal. Reopen it and approve again.");
  }
  if (expectedRevision !== headRevision || proposal.baseRevision !== headRevision) {
    throw new AnikaError("VERSION_CONFLICT", `Memory changed since this proposal (base ${proposal.baseRevision}, now ${headRevision}). Review it again.`);
  }
}

/** Undo creates a new visible revision restoring an earlier snapshot's content. */
export function restoreRevision(head: PersonaRevision, target: PersonaRevision, at: string): PersonaRevision {
  return nextRevision(head, { rules: target.rules, persona: target.persona, modes: target.modes }, `Restored content of ${target.id}`, "user", at);
}

/* ------------------------------------------------------- classification */

const FACT_HINTS = /\b(date|year|wrong|incorrect|typo|actually|should be|misspell|fact|number|figure|name is)\b/i;
const STYLE_HINTS = /\b(tone|voice|sound|paragraph|sentence|dash|word|phrase|cliche|cliché|theatrical|formal|casual|short|long|punchy|rhythm|flow|connected|develop|argument|structure)\b/i;
const TASK_ONLY_HINTS = /^\s*(make (this|it) (shorter|longer)|shorten|cut this|expand this)\b/i;

/**
 * Local heuristic classifier used when no model classifier is available. It
 * is conservative: unknown stays unknown, and "make this shorter" stays a task
 * instruction rather than becoming an enduring rule.
 */
export function classifyFeedback(text: string): { labels: ReasonLabel[]; enduring: boolean } {
  const labels: ReasonLabel[] = [];
  if (FACT_HINTS.test(text)) labels.push("factual_correction");
  if (STYLE_HINTS.test(text)) labels.push("style");
  if (/\b(argument|claim|point|thesis)\b/i.test(text)) labels.push("substantive_argument");
  if (/\b(audience|reader|client|investor|board)\b/i.test(text)) labels.push("audience_context");
  if (/\b(heading|bullet|list|bold|italic|format)\b/i.test(text)) labels.push("formatting");
  if (!labels.length) labels.push("unknown");
  const enduring = !TASK_ONLY_HINTS.test(text) && !(labels.length === 1 && labels[0] === "factual_correction");
  return { labels, enduring };
}

/**
 * Whether the optional "Remember explicit corrections" policy may commit
 * immediately: only a direct style instruction, scoped to one mode, never core.
 */
export function policyMayAutoCommit(policy: PersonaMeta["learningPolicy"], labels: ReasonLabel[], scope: "task" | "mode" | "core"): boolean {
  return policy === "remember_explicit" && scope === "mode" && labels.includes("style") && !labels.includes("unknown") && !labels.includes("factual_correction");
}
