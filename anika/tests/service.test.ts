import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorJsonFromBlocks } from "../src/core/document";
import { AnikaError } from "../src/core/types";
import { ClaudeJudges } from "../server/llm";
import { Repo } from "../server/repo";
import { Service } from "../server/service";

let dir: string;
let service: Service;

const doc = (...texts: string[]) => editorJsonFromBlocks(texts.map((t, i) => ({ id: `blk_${i}`, kind: "paragraph" as const, text: t })));

beforeEach(async () => {
  process.env.ANIKA_INFERENCE = "off";
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "anika-test-"));
  service = new Service(await Repo.open(dir), new ClaudeJudges());
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function seed() {
  const rev = await service.createPersona({ name: "Carlo", modeName: "Opinion essay", modeDescription: "Long-form" });
  const withEmail = await service.addMode(rev.persona.id, { expectedRevision: rev.id, name: "Client email", description: "Short" });
  const essay = withEmail.modes[0].id;
  const email = withEmail.modes[1].id;
  const project = await service.createProject({ personaId: rev.persona.id, modeId: essay, title: "Essay" });
  return { personaId: rev.persona.id, essay, email, project, head: withEmail };
}

describe("workspace storage", () => {
  it("AT-01: a persona survives restart, with readable working notes", async () => {
    const { personaId } = await seed();
    const reopened = new Service(await Repo.open(dir), new ClaudeJudges());
    expect(reopened.repo.head(personaId).persona.name).toBe("Carlo");
    expect(await fs.readFile(path.join(dir, "personas", personaId, "working", "core.md"), "utf8")).toMatch(/Carlo/);
  });

  it("quarantines a release edited after commit and falls back to the last valid one", async () => {
    const { personaId, head } = await seed();
    const manifest = path.join(dir, "personas", personaId, "releases", head.id, "manifest.json");
    const tampered = JSON.parse(await fs.readFile(manifest, "utf8"));
    tampered.persona.name = "Mallory";
    await fs.writeFile(manifest, JSON.stringify(tampered));
    const repo = await Repo.open(dir);
    expect(repo.quarantined.map((q) => q.revisionId)).toEqual([head.id]);
    expect(repo.head(personaId).id).toBe("rev_001");
  });

  it("AT-06: a stale save never overwrites; the incoming text is preserved", async () => {
    const { project } = await seed();
    const first = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("One.") });
    await service.saveDraft(project.id, { baseVersionId: first.version.id, editorJson: doc("Two.") });
    const err = await service.saveDraft(project.id, { baseVersionId: first.version.id, editorJson: doc("Three.") }).catch((e) => e);
    expect(err).toBeInstanceOf(AnikaError);
    expect(err.code).toBe("VERSION_CONFLICT");
    const kept = service.getDraft(err.detail.conflictVersionId);
    expect(kept.blocks[0].text).toBe("Three.");
    expect(service.getDraft(service.repo.projects.get(project.id)!.head!).blocks[0].text).toBe("Two.");
  });

  it("is idempotent by operation id", async () => {
    const { project } = await seed();
    const a = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("One."), opId: "op_1" });
    const b = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("One."), opId: "op_1" });
    expect(b.version.id).toBe(a.version.id);
  });
});

describe("learning loop", () => {
  it("AT-12 and J03: an approved correction is in the next run's context for that mode only", async () => {
    const { personaId, email, project } = await seed();
    const saved = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("Point one.", "Point two.") });
    const result = await service.proposeCorrection({
      projectId: project.id,
      draftVersionId: saved.version.id,
      blockId: "blk_0",
      before: "Point one.",
      feedback: "Too many disconnected one-line paragraphs. Develop the argument.",
      scope: "mode",
    });
    expect(result.proposal).not.toBeNull();
    expect(service.compile(project.id).manifest.active_rule_ids).toEqual([]);

    const head = service.repo.head(personaId);
    await service.approveProposal(result.proposal!.id, { hash: result.proposal!.hash, expectedRevision: head.id });
    const after = service.compile(project.id);
    expect(after.manifest.active_rule_ids).toHaveLength(1);
    expect(after.manifest.persona_revision).toBe("rev_003");

    const emailProject = await service.createProject({ personaId, modeId: email, title: "Email" });
    expect(service.compile(emailProject.id).manifest.active_rule_ids).toEqual([]);
  });

  it("a stale approval is a VERSION_CONFLICT", async () => {
    const { personaId, project } = await seed();
    const saved = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("Text.") });
    const r = await service.proposeCorrection({ projectId: project.id, draftVersionId: saved.version.id, blockId: "blk_0", before: "Text.", feedback: "Too formal in tone.", scope: "mode" });
    const head = service.repo.head(personaId);
    await service.addRule(personaId, { expectedRevision: head.id, statement: "Never use em dashes.", scope: { kind: "core" }, strength: "hard" });
    const err = await service.approveProposal(r.proposal!.id, { hash: r.proposal!.hash, expectedRevision: head.id }).catch((e) => e);
    expect(err.code).toBe("VERSION_CONFLICT");
  });

  it("AT-14: retire removes a rule from new context; undo is a new visible revision", async () => {
    const { personaId, project } = await seed();
    const added = await service.addRule(personaId, { expectedRevision: "rev_002", statement: "Never use em dashes.", scope: { kind: "core" }, strength: "hard", checker: { kind: "forbidden_chars", chars: ["—"], regions: "author_prose" } });
    const ruleId = added.rules[0].id;
    const retired = await service.retireRule(personaId, ruleId, { expectedRevision: added.id });
    expect(service.compile(project.id).manifest.active_rule_ids).toEqual([]);
    const undone = await service.restore(personaId, { expectedRevision: retired.id, targetRevision: added.id });
    expect(undone.number).toBe(5);
    expect(service.compile(project.id).manifest.active_rule_ids).toEqual([ruleId]);
    expect(service.repo.revisions.get(personaId)!.map((r) => r.id)).toEqual(["rev_001", "rev_002", "rev_003", "rev_004", "rev_005"]);
  });

  it("AT-13: 'Not an issue' records evaluator feedback without touching memory", async () => {
    const { personaId, project } = await seed();
    const added = await service.addRule(personaId, { expectedRevision: "rev_002", statement: "Never use em dashes.", scope: { kind: "core" }, strength: "preference", checker: { kind: "forbidden_chars", chars: ["—"], regions: "author_prose" } });
    const saved = await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("Deliberate—emphasis.") });
    const run = await service.startRun(project.id, { task: "review", versionId: saved.version.id });
    await waitFor(() => Boolean(service.repo.runs.get(run.id)!.finishedAt));
    const finding = service.repo.runs.get(run.id)!.findings[0];
    const out = await service.evaluatorFeedback({ runId: run.id, findingId: finding.id, action: "not_an_issue", choice: "keep_local", note: "Deliberate." });
    expect(out.proposal).toBeNull();
    expect(service.repo.head(personaId).id).toBe(added.id);
    expect(out.run.findings[0].resolution).toBe("evaluator_disputed");
  });
});

describe("deletion and portability", () => {
  it("AT-21: a deleted example leaves context immediately and its quoted excerpts are purged", async () => {
    const { personaId, project } = await seed();
    const ex = await service.addExample({ personaId, title: "Mine", blocks: [{ id: "blk_e1", kind: "paragraph", text: "A distinctive sentence I wrote myself." }], provenance: "i_wrote", modeId: null, excludedBlockIds: [], sourceFormat: "paste" });
    await service.updateExample(ex.id, { status: "approved" });
    expect(service.compile(project.id).manifest.example_ids).toEqual([ex.id]);

    /* Simulate an approved profile rule that quotes the example. */
    const head = service.repo.head(personaId);
    const rev = await service.addRule(personaId, { expectedRevision: head.id, statement: "Write plainly.", scope: { kind: "core" }, strength: "preference" });
    const quoting = { ...rev, rules: rev.rules.map((r) => ({ ...r, evidence: [{ id: ex.id, kind: "example" as const, excerpt: "A distinctive sentence" }] })) };
    const { nextRevision } = await import("../src/core/learning");
    const withEvidence = nextRevision(rev, { rules: quoting.rules }, "evidence", "user", new Date().toISOString());
    await service.repo.mutate(undefined, () => service.repo.commitRevision(withEvidence, rev.id));

    const receipt = await service.deleteExample(ex.id, { alsoRetireDerivedRules: false, confirm: "Mine" });
    expect(service.compile(project.id).manifest.example_ids).toEqual([]);
    expect(receipt.retiredRuleIds).toHaveLength(1);
    const releases = path.join(dir, "personas", personaId, "releases");
    for (const name of await fs.readdir(releases)) {
      expect(await fs.readFile(path.join(releases, name, "manifest.json"), "utf8")).not.toMatch(/distinctive/);
    }
    const reopened = await Repo.open(dir);
    expect(reopened.quarantined).toEqual([]);
    expect(reopened.examples.has(ex.id)).toBe(false);
  });

  it("AT-16: export round-trips into a fresh workspace with ids and checksums intact", async () => {
    const { personaId, project } = await seed();
    await service.saveDraft(project.id, { baseVersionId: null, editorJson: doc("Draft text.") });
    const bundle = JSON.parse(JSON.stringify(service.exportPersona(personaId, { examples: true, projects: true })));
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "anika-import-"));
    try {
      const other = new Service(await Repo.open(otherDir), new ClaudeJudges());
      const plan = other.importPlan(bundle);
      expect(plan).toMatchObject({ checksumsValid: true, canApply: true });
      await other.importApply(bundle);
      expect(other.repo.head(personaId).id).toBe(service.repo.head(personaId).id);
      expect(other.repo.projects.get(project.id)?.title).toBe("Essay");
      bundle.revisions[0].persona.name = "Tampered";
      expect(other.importPlan(bundle).checksumsValid).toBe(false);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});

async function waitFor(cond: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
