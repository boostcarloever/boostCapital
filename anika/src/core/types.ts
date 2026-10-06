/**
 * Domain model for Anika Intelligence (spec section 17).
 *
 * Everything here is plain data so it can be serialized to the human-readable
 * workspace folder and validated at the server boundary.
 */

export type Id = string;
export type IsoTime = string;

/* ---------------------------------------------------------------- documents */

export type BlockKind = "paragraph" | "heading" | "quote" | "code";

/** One addressable block of a draft. `text` is the exact analysis text. */
export interface Block {
  id: Id;
  kind: BlockKind;
  level?: number;
  text: string;
  locked?: boolean;
}

export interface DraftVersion {
  id: Id;
  projectId: Id;
  parent: Id | null;
  /** Tiptap/ProseMirror JSON. Authoritative for rich structure. */
  editorJson: unknown;
  /** Derived analysis blocks (exact text, stable block ids). */
  blocks: Block[];
  hash: string;
  origin: "user" | "revision" | "import" | "restore" | "conflict";
  /** For revision candidates: the run that produced it. */
  runId?: Id;
  createdAt: IsoTime;
}

/* ------------------------------------------------------------------ persona */

export type RuleScope =
  | { kind: "core" }
  | { kind: "mode"; modeIds: Id[] };

export type RuleStatus = "proposed" | "active" | "retired" | "quarantined";
export type RuleStrength = "hard" | "preference";
export type EvidenceLevel = "explicit" | "repeated_approved" | "tentative" | "insufficient";
export type RuleOrigin = "explicit_feedback" | "inferred_from_examples" | "user_written";

/** Text regions a mechanical checker examines. */
export type CheckRegion = "author_prose" | "all";

export type Checker =
  | { kind: "forbidden_chars"; chars: string[]; regions: CheckRegion }
  | { kind: "forbidden_phrases"; phrases: string[]; caseSensitive: boolean; regions: CheckRegion }
  | { kind: "length_words"; min?: number; max?: number }
  | { kind: "required_heading"; text: string }
  | { kind: "llm_rubric"; criterion: string };

export interface EvidenceRef {
  /** Example, decision, or feedback id. */
  id: Id;
  kind: "example" | "decision" | "user_statement";
  /** Short excerpt shown in the UI. Removed when the source is deleted. */
  excerpt?: string;
}

export interface Rule {
  id: Id;
  statement: string;
  dimension: string;
  scope: RuleScope;
  strength: RuleStrength;
  status: RuleStatus;
  origin: RuleOrigin;
  evidenceLevel: EvidenceLevel;
  evidence: EvidenceRef[];
  exceptions: string[];
  checker: Checker;
  /** Verbatim human feedback that produced this rule, when there was any. */
  rawFeedback?: string;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface Mode {
  id: Id;
  name: string;
  description: string;
}

export type LearningPolicy = "review" | "remember_explicit";

export interface PersonaMeta {
  id: Id;
  name: string;
  learningPolicy: LearningPolicy;
  languages: string[];
}

/** An immutable, committed snapshot of persona memory. */
export interface PersonaRevision {
  id: Id;
  number: number;
  parent: Id | null;
  persona: PersonaMeta;
  modes: Mode[];
  rules: Rule[];
  operation: string;
  actor: "user" | "policy";
  createdAt: IsoTime;
  /** sha256 over the canonical snapshot (excluding this field). */
  hash: string;
}

/* ----------------------------------------------------------------- examples */

export type Provenance = "i_wrote" | "ai_assisted" | "client_authorized" | "inspiration";
export type Split = "profile" | "calibration" | "heldout";

export interface Highlight {
  blockId: Id;
  start: number;
  end: number;
}

export interface Example {
  id: Id;
  personaId: Id;
  title: string;
  blocks: Block[];
  provenance: Provenance;
  modeId: Id | null;
  language: string;
  status: "pending" | "approved";
  excludedBlockIds: Id[];
  highlights: Highlight[];
  familyId: Id;
  split: Split;
  textHash: string;
  sourceFormat: "paste" | "markdown" | "text" | "docx";
  createdAt: IsoTime;
}

/* ----------------------------------------------------------------- projects */

export interface TaskException {
  id: Id;
  ruleId: Id;
  note: string;
  /** Hard rules need explicit writer approval to be suspended. */
  approvedByWriter: boolean;
  createdAt: IsoTime;
}

export interface Project {
  id: Id;
  personaId: Id;
  modeId: Id;
  title: string;
  brief: string;
  exceptions: TaskException[];
  head: Id | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

export interface Decision {
  id: Id;
  personaId: Id;
  projectId: Id;
  modeId: Id;
  draftVersionId: Id;
  blockId: Id;
  before: string;
  after: string | null;
  rawFeedback: string;
  reasonLabels: ReasonLabel[];
  approvedScope: "task" | "mode" | "core" | null;
  resultingRuleIds: Id[];
  kind: "correction" | "evaluator_feedback";
  createdAt: IsoTime;
}

export type ReasonLabel =
  | "style"
  | "factual_correction"
  | "substantive_argument"
  | "audience_context"
  | "formatting"
  | "unknown";

/* ---------------------------------------------------------------- learning */

export type RuleChange =
  | { op: "add"; rule: Rule }
  | { op: "update"; ruleId: Id; patch: Partial<Pick<Rule, "statement" | "scope" | "exceptions" | "strength" | "status">> }
  | { op: "retire"; ruleId: Id };

export interface Proposal {
  id: Id;
  personaId: Id;
  title: string;
  baseRevision: Id;
  changes: RuleChange[];
  rawFeedback?: string;
  classification: ReasonLabel[];
  decisionId?: Id;
  origin: "correction" | "profile" | "evaluator_feedback" | "user_edit";
  status: "pending" | "approved" | "rejected";
  hash: string;
  createdAt: IsoTime;
  resolvedAt?: IsoTime;
}

/* ------------------------------------------------------------- compilation */

export interface ExcludedItem {
  id: Id;
  reason: string;
}

/** Spec 18: the compiled-context manifest. */
export interface ContextManifest {
  schema_version: "1.0";
  persona_id: Id;
  persona_revision: Id;
  mode_id: Id;
  project_revision: string;
  active_rule_ids: Id[];
  exception_ids: Id[];
  example_ids: Id[];
  decision_ids: Id[];
  excluded: ExcludedItem[];
  compiler_version: string;
  processor_policy_revision: string;
  estimated_tokens: number;
  context_hash: string;
}

export interface ContextPackage {
  manifest: ContextManifest;
  rules: Rule[];
  examples: { id: Id; title: string; excerpt: string }[];
  decisions: { id: Id; before: string; after: string | null; feedback: string }[];
  brief: string;
  mode: Mode;
}

/* ------------------------------------------------------------------- runs */

export type RunState =
  | "CREATED"
  | "PREFLIGHT"
  | "CONTEXT_READY"
  | "MECHANICAL_CHECK"
  | "VOICE_AND_MEANING_CHECKS"
  | "NEEDS_REVIEW"
  | "REPAIR"
  | "RECHECK"
  | "READY_FOR_REVIEW"
  | "CHECKS_INCOMPLETE"
  | "CANCELED"
  | "FAILED";

/** The five user-facing run states (spec section 10). */
export type RunLabel = "Working" | "Needs review" | "Ready for your review" | "Checks incomplete" | "Stopped";

export type Criterion = "explicit_rules" | "voice" | "meaning" | "evidence";

export interface Anchor {
  draftVersionId: Id;
  blockId: Id;
  start: number;
  end: number;
  quote: string;
}

export type FindingResolution =
  | "open"
  | "accepted"
  | "dismissed_for_draft"
  | "evaluator_disputed"
  | "exception_added";

export interface Finding {
  id: Id;
  criterion: Criterion;
  dimension: string;
  severity: "blocker" | "review" | "hint";
  ruleIds: Id[];
  anchor: Anchor | null;
  evidenceIds: Id[];
  explanation: string;
  proposedAction?: string;
  replacement?: string;
  source: "mechanical" | "voice_judge" | "meaning_judge";
  resolution: FindingResolution;
}

export interface SectionOutcome {
  status: "complete" | "unavailable" | "not_applicable" | "not_run";
  note: string;
}

export interface DimensionOutcome {
  dimension: string;
  result: "pass" | "issue" | "insufficient_evidence" | "not_applicable";
  reason: string;
}

export interface Usage {
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  models: string[];
}

export interface Run {
  id: Id;
  projectId: Id;
  task: "review" | "revise";
  state: RunState;
  history: { state: RunState; at: IsoTime; note?: string }[];
  baseVersionId: Id;
  /** The version the final report describes (a candidate after revision). */
  evaluatedVersionId: Id;
  candidateVersionIds: Id[];
  personaRevision: Id;
  manifest: ContextManifest | null;
  sections: Record<Criterion, SectionOutcome>;
  dimensions: DimensionOutcome[];
  findings: Finding[];
  rejectedFindings: number;
  repairPasses: number;
  usage: Usage;
  error?: { code: ErrorCode; message: string };
  startedAt: IsoTime;
  finishedAt: IsoTime | null;
}

/* ----------------------------------------------------------------- errors */

export type ErrorCode =
  | "PROFILE_MISSING"
  | "PROFILE_CONFLICT"
  | "PROFILE_TOO_LARGE"
  | "VERSION_CONFLICT"
  | "STALE_PATCH"
  | "SOURCE_DELETED"
  | "PROCESSOR_NOT_ALLOWED"
  | "UNSUPPORTED_LANGUAGE"
  | "UNSUPPORTED_IMPORT"
  | "CHECKS_UNAVAILABLE"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "NETWORK_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "NOT_FOUND"
  | "INVALID_INPUT";

export class AnikaError extends Error {
  readonly code: ErrorCode;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
