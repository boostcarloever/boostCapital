/**
 * Draft lifecycle and bounded orchestration (spec section 19).
 *
 * A run is a state machine, not an open-ended agent conversation. Models are
 * reached only through the `Judges` interface; they cannot commit memory,
 * touch files, or grant permissions. Limits are ceilings, not targets.
 */
import { anchorIsValid, applyPatches, deterministicMeaningSignals, resolveAnchor, type Patch } from "./anchors";
import { isMechanical, lockViolations, runMechanicalChecks } from "./mechanical";
import type {
  Block,
  ContextPackage,
  Criterion,
  DimensionOutcome,
  ErrorCode,
  Finding,
  Id,
  Run,
  RunLabel,
  RunState,
  SectionOutcome,
} from "./types";
import { AnikaError } from "./types";

/* ------------------------------------------------------------ judge contract */

export interface JudgeUsage {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RawVoiceFinding {
  dimension: string;
  rule_ids: string[];
  evidence_ids: string[];
  block_id: string;
  quote: string;
  explanation: string;
  proposed_action: string;
  replacement: string | null;
}

export interface VoiceVerdict {
  dimensions: DimensionOutcome[];
  findings: RawVoiceFinding[];
  usage: JudgeUsage;
}

export interface RawMeaningFinding {
  block_id: string;
  quote: string;
  kind: string;
  explanation: string;
  consequential: boolean;
}

export interface MeaningVerdict {
  findings: RawMeaningFinding[];
  usage: JudgeUsage;
}

export interface RevisionProposal {
  patches: Patch[];
  usage: JudgeUsage;
}

export interface Judges {
  /** False when no approved processor is configured; model stages are then unavailable. */
  available(): boolean;
  voice(blocks: Block[], context: ContextPackage, signal: AbortSignal): Promise<VoiceVerdict>;
  meaning(original: Block[], candidate: Block[], context: ContextPackage, signal: AbortSignal): Promise<MeaningVerdict>;
  revise(blocks: Block[], findings: Finding[], context: ContextPackage, signal: AbortSignal): Promise<RevisionProposal>;
}

/* ----------------------------------------------------------------- policy */

export interface RunLimits {
  maxRepairPasses: number;
  maxRequests: number;
  wallClockMs: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxRepairPasses: 2, maxRequests: 12, wallClockMs: 180_000 };

const TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ["PREFLIGHT", "CANCELED", "FAILED"],
  PREFLIGHT: ["CONTEXT_READY", "FAILED", "CANCELED"],
  CONTEXT_READY: ["MECHANICAL_CHECK", "CANCELED", "FAILED"],
  MECHANICAL_CHECK: ["VOICE_AND_MEANING_CHECKS", "CANCELED", "FAILED"],
  VOICE_AND_MEANING_CHECKS: ["READY_FOR_REVIEW", "NEEDS_REVIEW", "CHECKS_INCOMPLETE", "REPAIR", "CANCELED", "FAILED"],
  NEEDS_REVIEW: ["REPAIR"],
  REPAIR: ["RECHECK", "NEEDS_REVIEW", "CHECKS_INCOMPLETE", "CANCELED", "FAILED"],
  RECHECK: ["MECHANICAL_CHECK", "CANCELED", "FAILED"],
  READY_FOR_REVIEW: [],
  CHECKS_INCOMPLETE: [],
  CANCELED: [],
  FAILED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: RunState): boolean {
  return TRANSITIONS[state].length === 0 || state === "NEEDS_REVIEW";
}

/** The five user-facing states. */
export function runLabel(state: RunState): RunLabel {
  switch (state) {
    case "READY_FOR_REVIEW":
      return "Ready for your review";
    case "NEEDS_REVIEW":
      return "Needs review";
    case "CHECKS_INCOMPLETE":
    case "FAILED":
      return "Checks incomplete";
    case "CANCELED":
      return "Stopped";
    default:
      return "Working";
  }
}

export function emptySections(): Record<Criterion, SectionOutcome> {
  return {
    explicit_rules: { status: "not_run", note: "" },
    voice: { status: "not_run", note: "" },
    meaning: { status: "not_run", note: "" },
    evidence: { status: "not_run", note: "" },
  };
}

/* -------------------------------------------------------------- execution */

export interface RunDeps {
  judges: Judges;
  context: ContextPackage;
  baseBlocks: Block[];
  /** Persist a candidate version; returns its id. */
  saveCandidate: (blocks: Block[], parentId: Id) => Promise<Id>;
  /** Persist the run after each transition. */
  emit: (run: Run) => Promise<void>;
  signal: AbortSignal;
  limits?: RunLimits;
  clock?: () => number;
}

class Halt extends Error {
  constructor(readonly state: "CANCELED" | "CHECKS_INCOMPLETE", readonly code?: ErrorCode, message?: string) {
    super(message ?? state);
  }
}

let seq = 0;
const findingId = () => `fnd_${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Execute a run to a terminal state. Never throws; failures are recorded on the run. */
export async function executeRun(run: Run, deps: RunDeps): Promise<Run> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const { judges, context, signal } = deps;

  const move = async (to: RunState, note?: string) => {
    if (!canTransition(run.state, to)) throw new Error(`Illegal run transition ${run.state} → ${to}`);
    run.state = to;
    run.history.push({ state: to, at: new Date(clock()).toISOString(), note });
    await deps.emit(run);
  };
  const checkpoint = () => {
    if (signal.aborted) throw new Halt("CANCELED", undefined, "Stopped by the writer.");
    if (clock() - started > limits.wallClockMs) throw new Halt("CHECKS_INCOMPLETE", "BUDGET_EXCEEDED", "Time limit reached; partial results kept.");
  };
  const spend = (usage: JudgeUsage) => {
    run.usage.requests += 1;
    if (!run.usage.models.includes(usage.model)) run.usage.models.push(usage.model);
    run.usage.inputTokens = usage.inputTokens === null || run.usage.inputTokens === null ? null : run.usage.inputTokens + usage.inputTokens;
    run.usage.outputTokens = usage.outputTokens === null || run.usage.outputTokens === null ? null : run.usage.outputTokens + usage.outputTokens;
  };
  const reserve = () => {
    if (run.usage.requests >= limits.maxRequests) throw new Halt("CHECKS_INCOMPLETE", "BUDGET_EXCEEDED", "Request limit for this run reached.");
  };

  try {
    await move("PREFLIGHT");
    checkpoint();
    run.manifest = context.manifest;
    await move("CONTEXT_READY", `Context ${context.manifest.context_hash.slice(0, 19)}…`);

    let currentId = run.baseVersionId;
    let current = deps.baseBlocks;

    for (;;) {
      checkpoint();
      await move("MECHANICAL_CHECK");
      const mechanical = runMechanicalChecks(currentId, current, context.rules);
      const unchecked = context.rules.filter((r) => !isMechanical(r));
      run.sections.explicit_rules = {
        status: "complete",
        note: `${context.rules.length - unchecked.length} rule${context.rules.length - unchecked.length === 1 ? "" : "s"} checked mechanically` +
          (unchecked.length ? `; ${unchecked.length} judged in voice review.` : "."),
      };

      checkpoint();
      await move("VOICE_AND_MEANING_CHECKS");
      const modelFindings = await modelChecks(run, deps, currentId, current, reserve, spend);
      run.findings = [...mechanical, ...modelFindings];
      run.evaluatedVersionId = currentId;
      await deps.emit(run);

      const blocking = run.findings.filter((f) => f.severity === "blocker" && f.resolution === "open");
      const repairable = run.findings.filter((f) => f.anchor && f.resolution === "open" && f.criterion !== "meaning");
      const incomplete = (["explicit_rules", "voice", "meaning", "evidence"] as Criterion[]).some((c) => run.sections[c].status === "unavailable");

      const wantsRepair = run.task === "revise" && repairable.length > 0 && run.repairPasses < limits.maxRepairPasses;
      if (wantsRepair && judges.available()) {
        await move("REPAIR", `Pass ${run.repairPasses + 1} of ${limits.maxRepairPasses}`);
        checkpoint();
        reserve();
        const proposal = await judges.revise(current, repairable, context, signal);
        spend(proposal.usage);
        const result = applyPatches(current, proposal.patches);
        run.repairPasses += 1;
        if (!result.applied.length || lockViolations(current, result.blocks).length) {
          await move("NEEDS_REVIEW", "No applicable patch; the remaining findings need your judgement.");
          break;
        }
        currentId = await deps.saveCandidate(result.blocks, currentId);
        current = result.blocks;
        run.candidateVersionIds.push(currentId);
        await move("RECHECK", `${result.applied.length} patch${result.applied.length === 1 ? "" : "es"} applied, ${result.rejected.length} rejected.`);
        continue;
      }

      if (incomplete) await move("CHECKS_INCOMPLETE", "One or more required checks did not run.");
      else if (blocking.length) await move("NEEDS_REVIEW", `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}.`);
      else await move("READY_FOR_REVIEW");
      break;
    }
  } catch (err) {
    if (err instanceof Halt) {
      if (err.code) run.error = { code: err.code, message: err.message };
      forceState(run, err.state, err.message, clock);
    } else if (signal.aborted) {
      forceState(run, "CANCELED", "Stopped by the writer.", clock);
    } else {
      const code: ErrorCode = err instanceof AnikaError ? err.code : "CHECKS_UNAVAILABLE";
      run.error = { code, message: err instanceof Error ? err.message : String(err) };
      forceState(run, "CHECKS_INCOMPLETE", run.error.message, clock);
    }
  }
  run.finishedAt = new Date(clock()).toISOString();
  await deps.emit(run);
  return run;
}

function forceState(run: Run, state: RunState, note: string, clock: () => number) {
  run.state = state;
  run.history.push({ state, at: new Date(clock()).toISOString(), note });
  for (const key of Object.keys(run.sections) as Criterion[]) {
    if (run.sections[key].status === "not_run") run.sections[key] = { status: "unavailable", note: "Did not run before the run stopped." };
  }
}

/** Voice and meaning checks run in parallel after mechanical validation. */
async function modelChecks(
  run: Run,
  deps: RunDeps,
  versionId: Id,
  blocks: Block[],
  reserve: () => void,
  spend: (u: JudgeUsage) => void,
): Promise<Finding[]> {
  const { judges, context, signal } = deps;
  const findings: Finding[] = [];
  const changed = versionId !== run.baseVersionId;

  /* Deterministic meaning signals always run when there is an original to compare. */
  const signals = changed ? deterministicMeaningSignals(deps.baseBlocks, blocks) : [];
  for (const s of signals) {
    const block = blocks.find((b) => b.id === s.blockId);
    findings.push({
      id: findingId(),
      criterion: "meaning",
      dimension: s.kind,
      severity: s.kind === "number_changed" || s.kind === "negation_changed" || s.kind === "first_person_added" ? "blocker" : "review",
      ruleIds: [],
      anchor: block ? { draftVersionId: versionId, blockId: block.id, start: 0, end: block.text.length, quote: block.text } : null,
      evidenceIds: [],
      explanation: `Meaning may have changed. ${s.detail}`,
      proposedAction: "Compare with the original and decide which wording is true.",
      source: "meaning_judge",
      resolution: "open",
    });
  }

  if (!judges.available()) {
    run.sections.voice = { status: "unavailable", note: "Voice review unavailable: no model processor is configured." };
    run.sections.evidence = { status: "unavailable", note: "Evidence coverage needs voice review." };
    run.sections.meaning = changed
      ? { status: "unavailable", note: `Exact checks found ${signals.length} signal${signals.length === 1 ? "" : "s"}; the semantic meaning check is unavailable.` }
      : { status: "not_applicable", note: "Nothing to compare: this is your own text, unchanged. Anika does not fact-check the world." };
    return findings;
  }

  const voiceTask = (async () => {
    reserve();
    const verdict = await judges.voice(blocks, context, signal);
    spend(verdict.usage);
    return verdict;
  })();
  const meaningTask = changed
    ? (async () => {
        reserve();
        const verdict = await judges.meaning(deps.baseBlocks, blocks, context, signal);
        spend(verdict.usage);
        return verdict;
      })()
    : Promise.resolve(null);

  const [voice, meaning] = await Promise.allSettled([voiceTask, meaningTask]);
  if (signal.aborted) throw new Halt("CANCELED");

  const ruleIds = new Set(context.rules.map((r) => r.id));
  const evidenceIds = new Set([
    ...context.examples.map((e) => e.id),
    ...context.decisions.map((d) => d.id),
    ...context.rules.flatMap((r) => r.evidence.map((e) => e.id)),
  ]);

  if (voice.status === "fulfilled") {
    run.dimensions = voice.value.dimensions;
    let rejected = 0;
    for (const raw of voice.value.findings) {
      const anchor = resolveAnchor(versionId, blocks, raw.block_id, raw.quote);
      const validRules = raw.rule_ids.every((id) => ruleIds.has(id));
      const validEvidence = raw.evidence_ids.every((id) => evidenceIds.has(id));
      const block = blocks.find((b) => b.id === raw.block_id);
      if (!anchor || !anchorIsValid(anchor, versionId, blocks) || !validRules || !validEvidence || block?.locked) {
        rejected++;
        continue;
      }
      findings.push({
        id: findingId(),
        criterion: "voice",
        dimension: raw.dimension,
        severity: "review",
        ruleIds: raw.rule_ids,
        anchor,
        evidenceIds: raw.evidence_ids,
        explanation: raw.explanation,
        proposedAction: raw.proposed_action,
        replacement: raw.replacement ?? undefined,
        source: "voice_judge",
        resolution: "open",
      });
    }
    run.rejectedFindings += rejected;
    run.sections.voice = {
      status: "complete",
      note: `${voice.value.findings.length - rejected} finding${voice.value.findings.length - rejected === 1 ? "" : "s"} with evidence` +
        (rejected ? `; ${rejected} discarded because their quote, rule, or evidence did not resolve.` : "."),
    };
    const insufficient = voice.value.dimensions.filter((d) => d.result === "insufficient_evidence").length;
    const withEvidence = context.rules.filter((r) => r.evidence.length > 0).length;
    run.sections.evidence = {
      status: "complete",
      note:
        `${context.examples.length} example${context.examples.length === 1 ? "" : "s"}, ${context.decisions.length} decision${context.decisions.length === 1 ? "" : "s"}; ` +
        `${withEvidence} of ${context.rules.length} rules carry evidence` +
        (insufficient ? `; ${insufficient} dimension${insufficient === 1 ? "" : "s"} had insufficient evidence.` : "."),
    };
  } else {
    run.sections.voice = { status: "unavailable", note: `Voice review unavailable: ${reason(voice.reason)}` };
    run.sections.evidence = { status: "unavailable", note: "Evidence coverage needs voice review." };
  }

  if (!changed) {
    run.sections.meaning = { status: "not_applicable", note: "Nothing to compare: this is your own text, unchanged. Anika does not fact-check the world." };
  } else if (meaning.status === "fulfilled" && meaning.value) {
    for (const raw of meaning.value.findings) {
      const anchor = resolveAnchor(versionId, blocks, raw.block_id, raw.quote);
      if (!anchor) {
        run.rejectedFindings++;
        continue;
      }
      findings.push({
        id: findingId(),
        criterion: "meaning",
        dimension: raw.kind,
        severity: raw.consequential ? "blocker" : "review",
        ruleIds: [],
        anchor,
        evidenceIds: [],
        explanation: `Meaning may have changed. ${raw.explanation}`,
        proposedAction: "Decide which wording is true; a better style score never cancels a changed claim.",
        source: "meaning_judge",
        resolution: "open",
      });
    }
    run.sections.meaning = { status: "complete", note: `Compared against the original: ${signals.length} exact signal${signals.length === 1 ? "" : "s"}, ${meaning.value.findings.length} semantic.` };
  } else if (meaning.status === "rejected") {
    run.sections.meaning = { status: "unavailable", note: `Semantic meaning check unavailable: ${reason(meaning.reason)}` };
  }
  return findings;
}

function reason(err: unknown): string {
  if (err instanceof Halt) throw err;
  if (err instanceof AnikaError) return err.message;
  return err instanceof Error ? err.message : "unknown error";
}

/** Fresh run record in the CREATED state. */
export function newRun(fields: Pick<Run, "id" | "projectId" | "task" | "baseVersionId" | "personaRevision">, at: string): Run {
  return {
    ...fields,
    state: "CREATED",
    history: [{ state: "CREATED", at }],
    evaluatedVersionId: fields.baseVersionId,
    candidateVersionIds: [],
    manifest: null,
    sections: emptySections(),
    dimensions: [],
    findings: [],
    rejectedFindings: 0,
    repairPasses: 0,
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, models: [] },
    startedAt: at,
    finishedAt: null,
  };
}
