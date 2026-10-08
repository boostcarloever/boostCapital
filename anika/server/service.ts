/**
 * Application service: the named, typed operations of spec section 23.
 * Every state-changing operation runs under the workspace lock, checks the
 * expected version, and returns a typed result or a recoverable AnikaError.
 */
import mammoth from "mammoth";
import { compileContext, ruleApplies } from "../src/core/compiler";
import { blocksFromEditorJson, editorJsonFromBlocks, markdownToBlocks } from "../src/core/document";
import { digest, newId, now } from "../src/core/hash";
import {
  applyChanges,
  classifyFeedback,
  firstRevision,
  nextRevision,
  policyMayAutoCommit,
  proposalHash,
  restoreRevision,
  validateCommit,
} from "../src/core/learning";
import { executeRun, newRun } from "../src/core/runs";
import type {
  Block,
  Checker,
  Decision,
  DraftVersion,
  Example,
  Id,
  LearningPolicy,
  Mode,
  PersonaRevision,
  Project,
  Proposal,
  Provenance,
  ReasonLabel,
  Rule,
  RuleChange,
  RuleScope,
  Split,
} from "../src/core/types";
import { AnikaError } from "../src/core/types";
import { ClaudeJudges, PROCESSOR_DISCLOSURE } from "./llm";
import { Repo } from "./repo";

const MAX_IMPORT_BYTES = 2_000_000;
const MAX_DRAFT_WORDS = 6_000;

export class Service {
  private active = new Map<Id, AbortController>();

  constructor(
    readonly repo: Repo,
    readonly judges: ClaudeJudges,
  ) {}

  /* ------------------------------------------------------------ snapshot */

  state() {
    const r = this.repo;
    const personas = r.workspace.personaIds
      .filter((pid) => r.heads.has(pid))
      .map((pid) => ({ head: r.head(pid), revisionCount: r.revisions.get(pid)?.length ?? 0 }));
    return {
      workspace: { id: r.workspace.id, root: r.root, createdAt: r.workspace.createdAt },
      personas,
      quarantined: r.quarantined,
      projects: [...r.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      examples: [...r.examples.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      proposals: [...r.proposals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      decisions: [...r.decisions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      processor: { available: this.judges.available(), ...PROCESSOR_DISCLOSURE },
      usage: this.usageSummary(),
    };
  }

  private usageSummary() {
    let requests = 0;
    let input = 0;
    let output = 0;
    let unknown = false;
    for (const run of this.repo.runs.values()) {
      requests += run.usage.requests;
      if (run.usage.inputTokens === null || run.usage.outputTokens === null) unknown = true;
      else {
        input += run.usage.inputTokens;
        output += run.usage.outputTokens;
      }
    }
    return { requests, inputTokens: input, outputTokens: output, someUnknown: unknown };
  }

  /* ------------------------------------------------------------- personas */

  createPersona(input: { name: string; modeName: string; modeDescription: string; opId?: string }) {
    const name = requireText(input.name, "Persona name", 80);
    const modeName = requireText(input.modeName, "Mode name", 60);
    return this.repo.mutate(input.opId, async () => {
      const at = now();
      const mode: Mode = { id: newId("mode"), name: modeName, description: (input.modeDescription ?? "").slice(0, 400) };
      const rev = firstRevision({ id: newId("persona"), name, learningPolicy: "review", languages: ["en"] }, [mode], at);
      await this.repo.commitRevision(rev, null);
      return rev;
    });
  }

  addMode(personaId: Id, input: { expectedRevision: Id; name: string; description: string; opId?: string }) {
    return this.repo.mutate(input.opId, async () => {
      const head = this.repo.head(personaId);
      const mode: Mode = { id: newId("mode"), name: requireText(input.name, "Mode name", 60), description: (input.description ?? "").slice(0, 400) };
      const rev = nextRevision(head, { modes: [...head.modes, mode] }, `Added mode “${mode.name}”`, "user", now());
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  setLearningPolicy(personaId: Id, input: { expectedRevision: Id; learningPolicy: LearningPolicy }) {
    return this.repo.mutate(undefined, async () => {
      const head = this.repo.head(personaId);
      if (input.learningPolicy !== "review" && input.learningPolicy !== "remember_explicit") throw new AnikaError("INVALID_INPUT", "Unknown learning policy.");
      const rev = nextRevision(
        head,
        { persona: { ...head.persona, learningPolicy: input.learningPolicy } },
        input.learningPolicy === "review" ? "Learning set to review every change" : "Learning set to remember explicit corrections",
        "user",
        now(),
      );
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  /** A rule the writer typed directly is a trusted UI action: commit immediately. */
  addRule(personaId: Id, input: { expectedRevision: Id; statement: string; scope: RuleScope; strength: "hard" | "preference"; checker?: Checker; exceptions?: string[] }) {
    return this.repo.mutate(undefined, async () => {
      const head = this.repo.head(personaId);
      const at = now();
      const rule: Rule = {
        id: newId("rule"),
        statement: requireText(input.statement, "Rule", 400),
        dimension: input.checker && input.checker.kind !== "llm_rubric" ? "explicit" : "general",
        scope: this.validScope(head, input.scope),
        strength: input.strength === "hard" ? "hard" : "preference",
        status: "active",
        origin: "user_written",
        evidenceLevel: "explicit",
        evidence: [{ id: newId("stmt"), kind: "user_statement", excerpt: input.statement.slice(0, 200) }],
        exceptions: (input.exceptions ?? []).map((e) => e.slice(0, 300)).filter(Boolean),
        checker: validChecker(input.checker, input.statement),
        createdAt: at,
        updatedAt: at,
      };
      const rev = nextRevision(head, { rules: applyChanges(head.rules, [{ op: "add", rule }], at) }, `Added rule “${short(rule.statement)}”`, "user", at);
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  updateRule(personaId: Id, ruleId: Id, input: { expectedRevision: Id; statement?: string; scope?: RuleScope; exceptions?: string[]; strength?: "hard" | "preference" }) {
    return this.repo.mutate(undefined, async () => {
      const head = this.repo.head(personaId);
      const patch: Extract<RuleChange, { op: "update" }>["patch"] = {};
      if (input.statement !== undefined) patch.statement = requireText(input.statement, "Rule", 400);
      if (input.scope !== undefined) patch.scope = this.validScope(head, input.scope);
      if (input.exceptions !== undefined) patch.exceptions = input.exceptions.map((e) => e.slice(0, 300)).filter(Boolean);
      if (input.strength !== undefined) patch.strength = input.strength === "hard" ? "hard" : "preference";
      const at = now();
      const rule = head.rules.find((r) => r.id === ruleId);
      const rev = nextRevision(head, { rules: applyChanges(head.rules, [{ op: "update", ruleId, patch }], at) }, `Changed rule “${short(rule?.statement ?? ruleId)}”`, "user", at);
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  retireRule(personaId: Id, ruleId: Id, input: { expectedRevision: Id }) {
    return this.repo.mutate(undefined, async () => {
      const head = this.repo.head(personaId);
      const at = now();
      const rule = head.rules.find((r) => r.id === ruleId);
      const rev = nextRevision(head, { rules: applyChanges(head.rules, [{ op: "retire", ruleId }], at) }, `Retired “${short(rule?.statement ?? ruleId)}”`, "user", at);
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  /** Undo/restore never rewrites history: it commits a new revision. */
  restore(personaId: Id, input: { expectedRevision: Id; targetRevision: Id }) {
    return this.repo.mutate(undefined, async () => {
      const head = this.repo.head(personaId);
      const target = this.repo.revision(personaId, input.targetRevision);
      const rev = restoreRevision(head, target, now());
      await this.repo.commitRevision(rev, input.expectedRevision);
      return rev;
    });
  }

  private validScope(head: PersonaRevision, scope: RuleScope | undefined): RuleScope {
    if (!scope || scope.kind === "core") return { kind: "core" };
    const ids = (scope.modeIds ?? []).filter((id) => head.modes.some((m) => m.id === id));
    if (!ids.length) throw new AnikaError("INVALID_INPUT", "Choose at least one existing mode.");
    return { kind: "mode", modeIds: ids };
  }

  /* ------------------------------------------------------------ proposals */

  approveProposal(id: Id, input: { hash: string; expectedRevision: Id; opId?: string }) {
    return this.repo.mutate(input.opId, async () => {
      const proposal = this.mustGet(this.repo.proposals, id, "Proposal");
      const head = this.repo.head(proposal.personaId);
      validateCommit(proposal, input.hash, input.expectedRevision, head.id);
      const at = now();
      const rev = nextRevision(head, { rules: applyChanges(head.rules, proposal.changes, at) }, `Approved: ${proposal.title}`, "user", at);
      await this.repo.commitRevision(rev, input.expectedRevision);
      await this.afterCommit(proposal, rev, at);
      return { revision: rev, proposal: this.repo.proposals.get(id) };
    });
  }

  rejectProposal(id: Id) {
    return this.repo.mutate(undefined, async () => {
      const proposal = this.mustGet(this.repo.proposals, id, "Proposal");
      if (proposal.status !== "pending") throw new AnikaError("PROFILE_CONFLICT", "This proposal was already resolved.");
      const next: Proposal = { ...proposal, status: "rejected", resolvedAt: now() };
      await this.repo.saveProposal(next);
      return next;
    });
  }

  private async afterCommit(proposal: Proposal, rev: PersonaRevision, at: string) {
    await this.repo.saveProposal({ ...proposal, status: "approved", resolvedAt: at });
    const added = proposal.changes.flatMap((c) => (c.op === "add" ? [c.rule.id] : []));
    if (proposal.decisionId) {
      const d = this.repo.decisions.get(proposal.decisionId);
      /* The approved rule's scope becomes the decision's approved scope, so the
         before/after pair itself enters matching context, not only the rule. */
      const addedRule = proposal.changes.find((c) => c.op === "add");
      const scope = addedRule?.op === "add" ? (addedRule.rule.scope.kind === "core" ? "core" : "mode") : d?.approvedScope ?? null;
      if (d) await this.repo.saveDecision({ ...d, approvedScope: d.kind === "correction" ? scope : d.approvedScope, resultingRuleIds: [...d.resultingRuleIds, ...added] });
      /* A memory update schedules a candidate regression case; its gold label waits for the writer. */
      for (const ruleId of added) {
        await this.repo.saveRegressionCase({ id: newId("case"), ruleId, before: d?.before ?? "", after: d?.after ?? null, feedback: proposal.rawFeedback ?? "", gold: "pending_human_approval" });
      }
    }
    void rev;
  }

  private async createProposal(fields: Omit<Proposal, "id" | "hash" | "status" | "createdAt">): Promise<Proposal> {
    const base = { ...fields };
    const proposal: Proposal = { ...base, id: newId("prop"), status: "pending", createdAt: now(), hash: proposalHash(base) };
    await this.repo.saveProposal(proposal);
    return proposal;
  }

  /* ------------------------------------------------------------- feedback */

  /**
   * J03: a correction on highlighted text. Records the before/after pair as a
   * decision, then proposes a scoped rule. Commits immediately only when the
   * writer enabled "Remember explicit corrections" and the change is narrow.
   */
  proposeCorrection(input: { projectId: Id; draftVersionId: Id; blockId: Id; before: string; after?: string | null; feedback: string; scope: "task" | "mode" | "core"; opId?: string }) {
    return this.repo.mutate(input.opId, async () => {
      const project = this.mustGet(this.repo.projects, input.projectId, "Project");
      const head = this.repo.head(project.personaId);
      const feedback = requireText(input.feedback, "Feedback", 2000);
      const before = requireText(input.before, "Highlighted text", 8000);

      let labels: ReasonLabel[];
      let enduring: boolean;
      let statement = feedback;
      let dimension = "general";
      let classifier = "local heuristic";
      if (this.judges.available()) {
        try {
          const c = await this.judges.classify(feedback, before);
          labels = c.labels.filter(isReason);
          enduring = c.enduring;
          if (c.rule_statement.trim()) statement = c.rule_statement.trim();
          dimension = c.dimension || dimension;
          classifier = c.usage.model;
        } catch {
          ({ labels, enduring } = classifyFeedback(feedback));
        }
      } else {
        ({ labels, enduring } = classifyFeedback(feedback));
      }
      if (!labels.length) labels = ["unknown"];

      const at = now();
      const decision: Decision = {
        id: newId("decision"),
        personaId: project.personaId,
        projectId: project.id,
        modeId: project.modeId,
        draftVersionId: input.draftVersionId,
        blockId: input.blockId,
        before,
        after: input.after ?? null,
        rawFeedback: feedback,
        reasonLabels: labels,
        approvedScope: input.scope === "task" ? "task" : null,
        resultingRuleIds: [],
        kind: "correction",
        createdAt: at,
      };
      await this.repo.saveDecision(decision);

      /* Task-only instructions and factual corrections never become voice memory. */
      if (input.scope === "task" || !enduring) {
        return { decision, proposal: null, committed: null, note: !enduring ? "Kept as a task instruction: it reads as a one-off or factual correction, not an enduring preference." : "Kept for this task only." };
      }

      const rule: Rule = {
        id: newId("rule"),
        statement,
        dimension,
        scope: input.scope === "core" ? { kind: "core" } : { kind: "mode", modeIds: [project.modeId] },
        strength: "preference",
        status: "proposed",
        origin: "explicit_feedback",
        evidenceLevel: "explicit",
        evidence: [{ id: decision.id, kind: "decision", excerpt: before.slice(0, 200) }],
        exceptions: [],
        checker: { kind: "llm_rubric", criterion: statement },
        rawFeedback: feedback,
        createdAt: at,
        updatedAt: at,
      };
      const proposal = await this.createProposal({
        personaId: project.personaId,
        title: `New ${input.scope === "core" ? "core" : head.modes.find((m) => m.id === project.modeId)?.name ?? "mode"} preference: “${short(statement)}”`,
        baseRevision: head.id,
        changes: [{ op: "add", rule }],
        rawFeedback: feedback,
        classification: labels,
        decisionId: decision.id,
        origin: "correction",
      });

      if (policyMayAutoCommit(head.persona.learningPolicy, labels, input.scope)) {
        const rev = nextRevision(head, { rules: applyChanges(head.rules, proposal.changes, at) }, `Remembered: ${proposal.title}`, "policy", at);
        await this.repo.commitRevision(rev, head.id);
        await this.repo.saveDecision({ ...decision, approvedScope: "mode" });
        await this.afterCommit(proposal, rev, at);
        return { decision, proposal: this.repo.proposals.get(proposal.id), committed: rev, note: `Remembered for this mode under your standing setting (classified by ${classifier}). Undo from Your voice.` };
      }
      return { decision, proposal, committed: null, note: `Memory change awaiting approval (classified by ${classifier}).` };
    });
  }

  /**
   * J04: feedback about the critic. "Not an issue" never rewrites memory by
   * itself and never approves the draft as an example.
   */
  evaluatorFeedback(input: { runId: Id; findingId: Id; action: "dismiss_for_draft" | "not_an_issue"; choice?: "keep_local" | "add_exception" | "change_rule"; note?: string; newStatement?: string }) {
    return this.repo.mutate(undefined, async () => {
      const run = this.mustGet(this.repo.runs, input.runId, "Run");
      const finding = run.findings.find((f) => f.id === input.findingId);
      if (!finding) throw new AnikaError("NOT_FOUND", "Finding not found.");
      const project = this.mustGet(this.repo.projects, run.projectId, "Project");
      let proposal: Proposal | null = null;

      if (input.action === "dismiss_for_draft") {
        finding.resolution = "dismissed_for_draft";
      } else {
        finding.resolution = "evaluator_disputed";
        const at = now();
        const decision: Decision = {
          id: newId("decision"),
          personaId: project.personaId,
          projectId: project.id,
          modeId: project.modeId,
          draftVersionId: run.evaluatedVersionId,
          blockId: finding.anchor?.blockId ?? "",
          before: finding.anchor?.quote ?? "",
          after: null,
          rawFeedback: input.note?.trim() || "Not an issue.",
          reasonLabels: ["unknown"],
          approvedScope: null,
          resultingRuleIds: [],
          kind: "evaluator_feedback",
          createdAt: at,
        };
        await this.repo.saveDecision(decision);
        const ruleId = finding.ruleIds[0];
        const head = this.repo.head(project.personaId);
        const rule = head.rules.find((r) => r.id === ruleId);
        if (rule && input.choice === "add_exception") {
          const exception = requireText(input.note ?? "", "Exception", 300);
          proposal = await this.createProposal({
            personaId: project.personaId,
            title: `Exception to “${short(rule.statement)}”`,
            baseRevision: head.id,
            changes: [{ op: "update", ruleId: rule.id, patch: { exceptions: [...rule.exceptions, exception] } }],
            rawFeedback: exception,
            classification: ["style"],
            decisionId: decision.id,
            origin: "evaluator_feedback",
          });
        } else if (rule && input.choice === "change_rule") {
          const statement = requireText(input.newStatement ?? "", "New rule wording", 400);
          proposal = await this.createProposal({
            personaId: project.personaId,
            title: `Reword “${short(rule.statement)}”`,
            baseRevision: head.id,
            changes: [{ op: "update", ruleId: rule.id, patch: { statement } }],
            rawFeedback: input.note,
            classification: ["style"],
            decisionId: decision.id,
            origin: "evaluator_feedback",
          });
        }
      }
      await this.repo.saveRun(run);
      return { run, proposal };
    });
  }

  /* ------------------------------------------------------------- projects */

  createProject(input: { personaId: Id; modeId: Id; title: string; brief?: string; opId?: string }) {
    return this.repo.mutate(input.opId, async () => {
      const head = this.repo.head(input.personaId);
      if (!head.modes.some((m) => m.id === input.modeId)) throw new AnikaError("INVALID_INPUT", "Unknown mode for this persona.");
      const at = now();
      const project: Project = {
        id: newId("project"),
        personaId: input.personaId,
        modeId: input.modeId,
        title: requireText(input.title, "Title", 140),
        brief: (input.brief ?? "").slice(0, 4000),
        exceptions: [],
        head: null,
        createdAt: at,
        updatedAt: at,
      };
      await this.repo.saveProject(project);
      return project;
    });
  }

  /** J05: switching persona or mode keeps the draft; earlier reports become stale, never relabelled. */
  updateProject(id: Id, input: { title?: string; brief?: string; personaId?: Id; modeId?: Id }) {
    return this.repo.mutate(undefined, async () => {
      const project = this.mustGet(this.repo.projects, id, "Project");
      const personaId = input.personaId ?? project.personaId;
      const head = this.repo.head(personaId);
      const modeId = input.modeId ?? (personaId === project.personaId ? project.modeId : head.modes[0]?.id);
      if (!head.modes.some((m) => m.id === modeId)) throw new AnikaError("INVALID_INPUT", "Unknown mode for this persona.");
      const contextChanged = personaId !== project.personaId || modeId !== project.modeId;
      const next: Project = {
        ...project,
        title: input.title !== undefined ? requireText(input.title, "Title", 140) : project.title,
        brief: input.brief !== undefined ? input.brief.slice(0, 4000) : project.brief,
        personaId,
        modeId: modeId!,
        /* Task exceptions belong to the old context and expire with it. */
        exceptions: contextChanged ? [] : project.exceptions,
        updatedAt: now(),
      };
      await this.repo.saveProject(next);
      return next;
    });
  }

  addException(projectId: Id, input: { ruleId: Id; note: string; approvedByWriter: boolean }) {
    return this.repo.mutate(undefined, async () => {
      const project = this.mustGet(this.repo.projects, projectId, "Project");
      const rule = this.repo.head(project.personaId).rules.find((r) => r.id === input.ruleId);
      if (!rule) throw new AnikaError("NOT_FOUND", "Rule not found.");
      if (rule.strength === "hard" && !input.approvedByWriter) {
        throw new AnikaError("PROFILE_CONFLICT", "This rule is always enforced. Confirm the exception explicitly.");
      }
      const next: Project = {
        ...project,
        exceptions: [...project.exceptions.filter((e) => e.ruleId !== rule.id), { id: newId("exc"), ruleId: rule.id, note: (input.note ?? "").slice(0, 300), approvedByWriter: Boolean(input.approvedByWriter), createdAt: now() }],
        updatedAt: now(),
      };
      await this.repo.saveProject(next);
      return next;
    });
  }

  removeException(projectId: Id, exceptionId: Id) {
    return this.repo.mutate(undefined, async () => {
      const project = this.mustGet(this.repo.projects, projectId, "Project");
      const next = { ...project, exceptions: project.exceptions.filter((e) => e.id !== exceptionId), updatedAt: now() };
      await this.repo.saveProject(next);
      return next;
    });
  }

  /**
   * draft.save: acknowledged only after the version is durable. A stale base
   * never overwrites; the incoming text is preserved as a conflict version.
   */
  saveDraft(projectId: Id, input: { baseVersionId: Id | null; editorJson: unknown; opId?: string; origin?: DraftVersion["origin"] }) {
    return this.repo.mutate(input.opId, async () => {
      const project = this.mustGet(this.repo.projects, projectId, "Project");
      const blocks = blocksFromEditorJson(input.editorJson);
      const words = blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
      if (words > MAX_DRAFT_WORDS * 3) throw new AnikaError("INVALID_INPUT", "This draft is too large to store as one document. Split it into sections.");
      const hash = Repo.draftHash(blocks);
      const head = project.head ? this.repo.drafts.get(project.head) : null;
      const at = now();
      if (input.baseVersionId !== project.head) {
        const conflict: DraftVersion = { id: newId("draft"), projectId, parent: input.baseVersionId, editorJson: input.editorJson, blocks, hash, origin: "conflict", createdAt: at };
        await this.repo.saveDraft(conflict);
        throw new AnikaError("VERSION_CONFLICT", "This draft changed elsewhere. Your text was kept as a separate version in History.", { conflictVersionId: conflict.id, headVersionId: project.head });
      }
      if (head && head.hash === hash && JSON.stringify(head.editorJson) === JSON.stringify(input.editorJson)) {
        return { version: head, unchanged: true };
      }
      const version: DraftVersion = { id: newId("draft"), projectId, parent: project.head, editorJson: input.editorJson, blocks, hash, origin: input.origin ?? "user", createdAt: at };
      await this.repo.saveDraft(version);
      await this.repo.saveProject({ ...project, head: version.id, updatedAt: at });
      return { version, unchanged: false };
    });
  }

  listDrafts(projectId: Id) {
    return [...this.repo.drafts.values()]
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ editorJson: _e, ...meta }) => ({ ...meta, words: meta.blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0) }));
  }

  getDraft(id: Id) {
    return this.mustGet(this.repo.drafts, id, "Draft version");
  }

  /* ----------------------------------------------------------------- runs */

  compile(projectId: Id, excludeIds: Id[] = []) {
    const project = this.mustGet(this.repo.projects, projectId, "Project");
    const revision = this.repo.head(project.personaId);
    return compileContext({
      revision,
      project,
      examples: [...this.repo.examples.values()].filter((e) => !this.repo.isDeleted(e.id)),
      decisions: [...this.repo.decisions.values()],
      excludeIds,
    });
  }

  /** run.start: preflight failures incur no model request. */
  async startRun(projectId: Id, input: { task: "review" | "revise"; versionId: Id }) {
    const project = this.mustGet(this.repo.projects, projectId, "Project");
    const version = this.mustGet(this.repo.drafts, input.versionId, "Draft version");
    if (version.projectId !== projectId) throw new AnikaError("INVALID_INPUT", "Version belongs to another project.");
    const words = version.blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
    if (words > MAX_DRAFT_WORDS) throw new AnikaError("BUDGET_EXCEEDED", `Checks support up to ${MAX_DRAFT_WORDS} words. Check one section at a time.`);
    if (!words) throw new AnikaError("INVALID_INPUT", "There is nothing to check yet.");
    for (const r of this.repo.runs.values()) {
      if (r.projectId === projectId && !r.finishedAt) throw new AnikaError("INVALID_INPUT", "A check is already running for this draft.");
    }

    const revision = this.repo.head(project.personaId);
    const run = newRun({ id: newId("run"), projectId, task: input.task, baseVersionId: version.id, personaRevision: revision.id }, now());
    await this.repo.saveRun(run);
    let context;
    try {
      context = this.compile(projectId);
    } catch (err) {
      run.state = "FAILED";
      run.error = { code: err instanceof AnikaError ? err.code : "PROFILE_MISSING", message: err instanceof Error ? err.message : String(err) };
      run.history.push({ state: "FAILED", at: now(), note: run.error.message });
      run.finishedAt = now();
      await this.repo.saveRun(run);
      return run;
    }

    const controller = new AbortController();
    this.active.set(run.id, controller);
    void executeRun(run, {
      judges: this.judges,
      context,
      baseBlocks: version.blocks,
      signal: controller.signal,
      emit: (r) => this.repo.saveRun(r),
      saveCandidate: async (blocks, parentId) => {
        const candidate: DraftVersion = {
          id: newId("draft"),
          projectId,
          parent: parentId,
          editorJson: editorJsonFromBlocks(blocks),
          blocks,
          hash: Repo.draftHash(blocks),
          origin: "revision",
          runId: run.id,
          createdAt: now(),
        };
        await this.repo.saveDraft(candidate);
        return candidate.id;
      },
    }).finally(() => this.active.delete(run.id));
    return run;
  }

  cancelRun(id: Id) {
    const run = this.mustGet(this.repo.runs, id, "Run");
    const controller = this.active.get(id);
    if (controller) controller.abort();
    return { run, wasActive: Boolean(controller), note: controller ? "Stopping. Provider work already started may still be billed." : "This run had already finished." };
  }

  listRuns(projectId: Id) {
    return [...this.repo.runs.values()].filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /* ------------------------------------------------------------- examples */

  /** Import preview. Nothing is stored until the writer confirms. */
  async previewImport(input: { filename?: string; text?: string; base64?: string }) {
    const name = (input.filename ?? "pasted text").toLowerCase();
    let source: string;
    let format: Example["sourceFormat"];
    if (input.base64 !== undefined) {
      const buf = Buffer.from(input.base64, "base64");
      if (buf.length > MAX_IMPORT_BYTES) throw new AnikaError("UNSUPPORTED_IMPORT", "That file is larger than 2 MB. Paste the passage you want instead.");
      if (name.endsWith(".docx")) {
        /* Raw text only: no HTML, images, or external resources are loaded. */
        const result = await mammoth.extractRawText({ buffer: buf });
        source = result.value.replace(/\n{3,}/g, "\n\n");
        format = "docx";
      } else if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt")) {
        source = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        format = name.endsWith(".txt") ? "text" : "markdown";
      } else {
        throw new AnikaError("UNSUPPORTED_IMPORT", "Anika reads Markdown, plain text, and Word (.docx) files. For anything else, paste the text.");
      }
    } else {
      source = input.text ?? "";
      format = "paste";
    }
    if (!source.trim()) throw new AnikaError("UNSUPPORTED_IMPORT", "No readable text was found.");
    if (source.length > MAX_IMPORT_BYTES) throw new AnikaError("UNSUPPORTED_IMPORT", "That text is too long to import at once.");
    const blocks = markdownToBlocks(source, () => newId("blk"));
    /* Quotations are excluded by default: they are not the author's voice. */
    const suggestedExclusions = blocks.filter((b) => b.kind === "quote" || b.kind === "code" || looksQuoted(b.text)).map((b) => b.id);
    return { blocks, sourceFormat: format, suggestedExclusions, words: blocks.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0) };
  }

  addExample(input: { personaId: Id; title: string; blocks: Block[]; provenance: Provenance; modeId: Id | null; excludedBlockIds: Id[]; sourceFormat: Example["sourceFormat"]; opId?: string }) {
    return this.repo.mutate(input.opId, async () => {
      const head = this.repo.head(input.personaId);
      if (!["i_wrote", "ai_assisted", "client_authorized", "inspiration"].includes(input.provenance)) throw new AnikaError("INVALID_INPUT", "Choose where this writing came from.");
      if (input.modeId && !head.modes.some((m) => m.id === input.modeId)) throw new AnikaError("INVALID_INPUT", "Unknown mode.");
      const blocks = (input.blocks ?? []).map((b) => ({ id: String(b.id), kind: b.kind, text: String(b.text), level: b.level }));
      if (!blocks.length) throw new AnikaError("UNSUPPORTED_IMPORT", "Nothing to import.");
      const textHash = digest(blocks.map((b) => b.text).join("\n"));
      const duplicate = [...this.repo.examples.values()].find((e) => e.textHash === textHash && e.personaId === input.personaId);
      if (duplicate) throw new AnikaError("INVALID_INPUT", `This text is already in your examples as “${duplicate.title}”.`);
      const example: Example = {
        id: newId("example"),
        personaId: input.personaId,
        title: requireText(input.title, "Title", 140),
        blocks,
        provenance: input.provenance,
        modeId: input.modeId,
        language: "en",
        status: "pending",
        excludedBlockIds: (input.excludedBlockIds ?? []).filter((id) => blocks.some((b) => b.id === id)),
        highlights: [],
        familyId: newId("family"),
        split: "profile",
        textHash,
        sourceFormat: input.sourceFormat,
        createdAt: now(),
      };
      await this.repo.saveExample(example);
      return example;
    });
  }

  updateExample(id: Id, input: { status?: "approved" | "pending"; highlights?: Example["highlights"]; excludedBlockIds?: Id[]; split?: Split; modeId?: Id | null; provenance?: Provenance; title?: string }) {
    return this.repo.mutate(undefined, async () => {
      const ex = this.mustGet(this.repo.examples, id, "Example");
      const highlights = input.highlights
        ? input.highlights.filter((h) => {
            const b = ex.blocks.find((x) => x.id === h.blockId);
            return b && h.start >= 0 && h.end <= b.text.length && h.end > h.start;
          })
        : ex.highlights;
      const next: Example = {
        ...ex,
        status: input.status ?? ex.status,
        highlights,
        excludedBlockIds: input.excludedBlockIds ?? ex.excludedBlockIds,
        split: input.split ?? ex.split,
        modeId: input.modeId !== undefined ? input.modeId : ex.modeId,
        provenance: input.provenance ?? ex.provenance,
        title: input.title !== undefined ? requireText(input.title, "Title", 140) : ex.title,
      };
      await this.repo.saveExample(next);
      return next;
    });
  }

  /**
   * data.delete for an example. Immediately excluded from context; rules that
   * lose all their evidence are retired rather than keeping dangling evidence.
   */
  deleteExample(id: Id, input: { alsoRetireDerivedRules: boolean; confirm: string }) {
    return this.repo.mutate(undefined, async () => {
      const ex = this.mustGet(this.repo.examples, id, "Example");
      if (input.confirm !== ex.title) throw new AnikaError("INVALID_INPUT", "Type the example's title to confirm deletion.");
      const head = this.repo.head(ex.personaId);
      const at = now();
      const affected = head.rules.filter((r) => r.evidence.some((e) => e.id === id));
      let rules = head.rules.map((r) =>
        r.evidence.some((e) => e.id === id) ? { ...r, evidence: r.evidence.filter((e) => e.id !== id), updatedAt: at } : r,
      );
      const orphaned = rules.filter((r) => affected.some((a) => a.id === r.id) && r.evidence.length === 0);
      if (input.alsoRetireDerivedRules || orphaned.length) {
        const retire = input.alsoRetireDerivedRules ? affected.map((r) => r.id) : orphaned.map((r) => r.id);
        rules = rules.map((r) => (retire.includes(r.id) && r.status !== "retired" ? { ...r, status: "retired" as const, evidenceLevel: "insufficient" as const } : r));
      }
      const receipt = await this.repo.deleteRecords([{ id, kind: "example" }]);
      let revision: PersonaRevision | null = null;
      if (affected.length) {
        revision = nextRevision(head, { rules }, `Deleted example and removed it from ${affected.length} rule${affected.length === 1 ? "" : "s"}`, "user", at);
        await this.repo.commitRevision(revision, head.id);
      }
      const purged = await this.repo.purgeEvidenceExcerpts(ex.personaId, id);
      return {
        ...receipt,
        revision,
        purgedRecords: purged,
        retiredRuleIds: rules.filter((r) => r.status === "retired" && affected.some((a) => a.id === r.id)).map((r) => r.id),
        caveat:
          "Quoted excerpts were removed from earlier persona releases, which are marked as purged and can no longer reproduce old runs exactly. " +
          "Exported archives, synced copies, and OS backups are outside Anika's reach. Provider records follow the provider's retention policy.",
      };
    });
  }

  deleteProject(id: Id, input: { confirm: string }) {
    return this.repo.mutate(undefined, async () => {
      const project = this.mustGet(this.repo.projects, id, "Project");
      if (input.confirm !== project.title) throw new AnikaError("INVALID_INPUT", "Type the project title to confirm deletion.");
      for (const r of this.repo.runs.values()) if (r.projectId === id) this.active.get(r.id)?.abort();
      const receipt = await this.repo.deleteRecords([{ id, kind: "project" }]);
      return { ...receipt, caveat: "Rules learned from this project's corrections stay until you retire them in Your voice." };
    });
  }

  /** FR-04: a first profile, each rule with evidence quoted from approved examples. */
  async proposeProfile(personaId: Id, modeId: Id) {
    const head = this.repo.head(personaId);
    const mode = head.modes.find((m) => m.id === modeId);
    if (!mode) throw new AnikaError("INVALID_INPUT", "Unknown mode.");
    const examples = [...this.repo.examples.values()].filter(
      (e) => e.personaId === personaId && e.status === "approved" && e.provenance !== "inspiration" && e.split !== "heldout",
    );
    if (!examples.length) throw new AnikaError("INVALID_INPUT", "Approve at least one example you wrote first.");
    if (!this.judges.available()) throw new AnikaError("CHECKS_UNAVAILABLE", "Profile suggestions need a model processor. You can still write rules yourself.");
    const result = await this.judges.proposeProfile(examples, mode.name);
    const at = now();
    const changes: RuleChange[] = [];
    let unsupported = 0;
    for (const r of result.rules) {
      const evidence = r.evidence
        .map((ev) => {
          const ex = examples.find((e) => e.id === ev.example_id);
          const ok = ex?.blocks.some((b) => b.text.includes(ev.quote) && ev.quote.length > 8);
          return ok ? { id: ev.example_id, kind: "example" as const, excerpt: ev.quote.slice(0, 240) } : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      if (!evidence.length) {
        unsupported++;
        continue;
      }
      changes.push({
        op: "add",
        rule: {
          id: newId("rule"),
          statement: r.statement.slice(0, 400),
          dimension: r.dimension || "general",
          scope: r.applies_to === "core" ? { kind: "core" } : { kind: "mode", modeIds: [mode.id] },
          strength: "preference",
          status: "proposed",
          origin: "inferred_from_examples",
          evidenceLevel: examples.length === 1 ? "tentative" : evidence.length > 1 ? "repeated_approved" : "tentative",
          evidence,
          exceptions: r.exceptions.slice(0, 5),
          checker: { kind: "llm_rubric", criterion: r.statement.slice(0, 400) },
          createdAt: at,
          updatedAt: at,
        },
      });
    }
    if (!changes.length) throw new AnikaError("CHECKS_UNAVAILABLE", "No suggestion could be tied to exact evidence in your examples. Try adding another piece.");
    const proposal = await this.repo.mutate(undefined, () =>
      this.createProposal({
        personaId,
        title: `Provisional profile from ${examples.length} example${examples.length === 1 ? "" : "s"}`,
        baseRevision: head.id,
        changes,
        classification: ["style"],
        origin: "profile",
      }),
    );
    return { proposal, discardedWithoutEvidence: unsupported, provisional: examples.length < 3 };
  }

  /** Accept part of a multi-rule proposal: the writer picks which rules, with optional edits. */
  approvePartial(id: Id, input: { hash: string; expectedRevision: Id; keepRuleIds: Id[]; edits?: Record<Id, string> }) {
    return this.repo.mutate(undefined, async () => {
      const proposal = this.mustGet(this.repo.proposals, id, "Proposal");
      const head = this.repo.head(proposal.personaId);
      validateCommit(proposal, input.hash, input.expectedRevision, head.id);
      const at = now();
      const keep = proposal.changes.filter((c) => c.op !== "add" || input.keepRuleIds.includes(c.rule.id));
      const edited = keep.map((c) =>
        c.op === "add" && input.edits?.[c.rule.id] ? { ...c, rule: { ...c.rule, statement: requireText(input.edits[c.rule.id], "Rule", 400) } } : c,
      );
      if (!edited.length) return this.rejectProposalInner(proposal);
      const rev = nextRevision(head, { rules: applyChanges(head.rules, edited, at) }, `Approved ${edited.length} of ${proposal.changes.length}: ${proposal.title}`, "user", at);
      await this.repo.commitRevision(rev, input.expectedRevision);
      await this.afterCommit(proposal, rev, at);
      return { revision: rev };
    });
  }

  private async rejectProposalInner(proposal: Proposal) {
    const next: Proposal = { ...proposal, status: "rejected", resolvedAt: now() };
    await this.repo.saveProposal(next);
    return { revision: null };
  }

  /* --------------------------------------------------------------- export */

  /** workspace.export: selected persona memory, examples, and drafts with checksums. */
  exportPersona(personaId: Id, include: { examples: boolean; projects: boolean }) {
    const revisions = this.repo.revisions.get(personaId);
    if (!revisions?.length) throw new AnikaError("NOT_FOUND", "Persona not found.");
    const examples = include.examples ? [...this.repo.examples.values()].filter((e) => e.personaId === personaId) : [];
    const projects = include.projects ? [...this.repo.projects.values()].filter((p) => p.personaId === personaId) : [];
    const drafts = projects.flatMap((p) => [...this.repo.drafts.values()].filter((d) => d.projectId === p.id));
    const decisions = include.projects ? [...this.repo.decisions.values()].filter((d) => d.personaId === personaId) : [];
    const payload = { revisions, head: this.repo.heads.get(personaId), examples, projects, drafts, decisions };
    const files = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, digest(v ?? null)]));
    return {
      manifest: { format: "anika-export", schema_version: "1.0", exportedAt: now(), personaId, files, excludes: ["credentials", "indexes", "caches", "run receipts", "other personas"] },
      ...payload,
    };
  }

  /** workspace.import dry run: verify checksums and report conflicts before changing anything. */
  importPlan(bundle: ReturnType<Service["exportPersona"]>) {
    if (bundle?.manifest?.format !== "anika-export") throw new AnikaError("UNSUPPORTED_IMPORT", "This is not an Anika export.");
    const mismatched = Object.entries(bundle.manifest.files).filter(([k, h]) => digest((bundle as unknown as Record<string, unknown>)[k] ?? null) !== h).map(([k]) => k);
    const pid = bundle.manifest.personaId;
    const existing = this.repo.revisions.get(pid);
    return {
      checksumsValid: mismatched.length === 0,
      mismatched,
      persona: bundle.revisions[bundle.revisions.length - 1]?.persona.name,
      personaExists: Boolean(existing),
      revisions: bundle.revisions.length,
      examples: bundle.examples.length,
      exampleConflicts: bundle.examples.filter((e) => this.repo.examples.has(e.id)).length,
      projects: bundle.projects.length,
      projectConflicts: bundle.projects.filter((p) => this.repo.projects.has(p.id)).length,
      canApply: mismatched.length === 0 && !existing,
      note: existing ? "This persona already exists here. Merging into an existing persona is not supported yet; nothing will change." : "Ready to import as a new persona.",
    };
  }

  importApply(bundle: ReturnType<Service["exportPersona"]>) {
    return this.repo.mutate(undefined, async () => {
      const plan = this.importPlan(bundle);
      if (!plan.canApply) throw new AnikaError("PROFILE_CONFLICT", plan.note);
      let parent: Id | null = null;
      for (const rev of bundle.revisions) {
        await this.repo.commitRevision(rev, parent);
        parent = rev.id;
      }
      for (const e of bundle.examples) if (!this.repo.examples.has(e.id)) await this.repo.saveExample(e);
      for (const p of bundle.projects) if (!this.repo.projects.has(p.id)) await this.repo.saveProject(p);
      for (const d of bundle.drafts) if (!this.repo.drafts.has(d.id)) await this.repo.saveDraft(d);
      for (const d of bundle.decisions) if (!this.repo.decisions.has(d.id)) await this.repo.saveDecision(d);
      return plan;
    });
  }

  /* -------------------------------------------------------------- helpers */

  private mustGet<T>(map: Map<Id, T>, id: Id, label: string): T {
    const v = map.get(id);
    if (!v || this.repo.isDeleted(id)) throw new AnikaError("NOT_FOUND", `${label} not found.`);
    return v;
  }

  /** Rules that would apply to a project right now (for the Write sidebar). */
  applicableRules(projectId: Id) {
    const project = this.mustGet(this.repo.projects, projectId, "Project");
    return this.repo.head(project.personaId).rules.filter((r) => ruleApplies(r, project.modeId));
  }
}

function requireText(value: unknown, label: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new AnikaError("INVALID_INPUT", `${label} is required.`);
  if (s.length > max) throw new AnikaError("INVALID_INPUT", `${label} is longer than ${max} characters.`);
  return s;
}

function short(s: string): string {
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function isReason(s: string): s is ReasonLabel {
  return ["style", "factual_correction", "substantive_argument", "audience_context", "formatting", "unknown"].includes(s);
}

function looksQuoted(text: string): boolean {
  const t = text.trim();
  return /^["“].*["”]$/s.test(t) && t.length > 2;
}

function validChecker(checker: Checker | undefined, statement: string): Checker {
  if (!checker) return { kind: "llm_rubric", criterion: statement };
  switch (checker.kind) {
    case "forbidden_chars":
      if (!checker.chars?.length) throw new AnikaError("INVALID_INPUT", "List at least one character.");
      return { kind: "forbidden_chars", chars: checker.chars.map(String).filter((c) => c.length === 1), regions: checker.regions === "all" ? "all" : "author_prose" };
    case "forbidden_phrases":
      if (!checker.phrases?.length) throw new AnikaError("INVALID_INPUT", "List at least one phrase.");
      return { kind: "forbidden_phrases", phrases: checker.phrases.map((p) => String(p).trim()).filter(Boolean), caseSensitive: Boolean(checker.caseSensitive), regions: checker.regions === "all" ? "all" : "author_prose" };
    case "length_words":
      return { kind: "length_words", min: num(checker.min), max: num(checker.max) };
    case "required_heading":
      return { kind: "required_heading", text: requireText(checker.text, "Heading", 120) };
    default:
      return { kind: "llm_rubric", criterion: statement };
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
