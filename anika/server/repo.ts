/**
 * Canonical local storage (spec section 16).
 *
 * Committed files under the user-selected folder are authoritative. Persona
 * memory is a chain of immutable releases; HEAD.json is replaced atomically only
 * after a complete release is durable. Working notes are rendered views for
 * Obsidian or any editor and are never read back as accepted memory.
 */
import { promises as fs, constants as fsc } from "node:fs";
import path from "node:path";
import { blocksToMarkdown } from "../src/core/document";
import { digest, newId, now } from "../src/core/hash";
import { revisionHash } from "../src/core/learning";
import type {
  Decision,
  DraftVersion,
  Example,
  Id,
  PersonaRevision,
  Project,
  Proposal,
  Run,
} from "../src/core/types";
import { AnikaError } from "../src/core/types";

const ID_RE = /^[a-z]+_[A-Za-z0-9_-]+$/;
export const SCHEMA_VERSION = "1.0";

export interface WorkspaceFile {
  schema_version: string;
  id: Id;
  createdAt: string;
  processorPolicyRevision: string;
  personaIds: Id[];
}

interface Tombstone {
  id: Id;
  kind: string;
  deletedAt: string;
}

function safeId(id: string): string {
  if (!ID_RE.test(id)) throw new AnikaError("INVALID_INPUT", `Invalid identifier: ${id}`);
  return id;
}

/** Write-then-rename with fsync of file and directory. */
export async function atomicWrite(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await syncDir(path.dirname(file));
}

async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, fsc.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Some platforms do not allow fsync on directories; the rename is still atomic. */
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/** Serializes mutations: one writer per workspace. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class Repo {
  readonly root: string;
  workspace!: WorkspaceFile;
  /** All valid revisions per persona, ascending. */
  revisions = new Map<Id, PersonaRevision[]>();
  heads = new Map<Id, Id>();
  quarantined: { personaId: Id; revisionId: Id; reason: string }[] = [];
  projects = new Map<Id, Project>();
  drafts = new Map<Id, DraftVersion>();
  examples = new Map<Id, Example>();
  decisions = new Map<Id, Decision>();
  proposals = new Map<Id, Proposal>();
  runs = new Map<Id, Run>();
  tombstones: Tombstone[] = [];
  private lock = new Mutex();
  private ops = new Map<string, unknown>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Open (or create) the workspace and load every committed record. */
  static async open(root: string): Promise<Repo> {
    const repo = new Repo(root);
    try {
      await fs.mkdir(repo.root, { recursive: true });
      await fs.access(repo.root, fsc.W_OK);
    } catch {
      throw new AnikaError("STORAGE_UNAVAILABLE", `Cannot write to ${repo.root}.`);
    }
    await repo.load();
    return repo;
  }

  private p(...parts: string[]): string {
    const full = path.resolve(this.root, ...parts);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new AnikaError("INVALID_INPUT", "Path escapes the workspace root.");
    }
    return full;
  }

  private async load(): Promise<void> {
    const ws = await readJson<WorkspaceFile>(this.p("workspace.json"));
    if (ws) {
      this.workspace = ws;
    } else {
      this.workspace = { schema_version: SCHEMA_VERSION, id: newId("ws"), createdAt: now(), processorPolicyRevision: "policy_001", personaIds: [] };
      await atomicWrite(this.p("workspace.json"), JSON.stringify(this.workspace, null, 2));
    }
    this.tombstones = (await readJson<Tombstone[]>(this.p("tombstones.json"))) ?? [];
    const dead = new Set(this.tombstones.map((t) => t.id));

    for (const pid of this.workspace.personaIds) {
      const releases: PersonaRevision[] = [];
      for (const rev of await listDir(this.p("personas", pid, "releases"))) {
        const r = await readJson<PersonaRevision>(this.p("personas", pid, "releases", rev, "manifest.json"));
        if (!r) continue;
        const { hash, ...rest } = r;
        if (revisionHash(rest) !== hash) {
          this.quarantined.push({ personaId: pid, revisionId: rev, reason: "Integrity check failed: the release was edited after it was committed." });
          continue;
        }
        releases.push(r);
      }
      releases.sort((a, b) => a.number - b.number);
      this.revisions.set(pid, releases);
      const head = await readJson<{ revision: Id; hash: string }>(this.p("personas", pid, "HEAD.json"));
      const valid = releases.find((r) => r.id === head?.revision && r.hash === head?.hash);
      const fallback = valid ?? releases[releases.length - 1];
      if (fallback) this.heads.set(pid, fallback.id);
    }

    const loadAll = async <T extends { id: Id }>(dir: string[], file: (name: string) => string[], into: Map<Id, T>) => {
      for (const name of await listDir(this.p(...dir))) {
        const rec = await readJson<T>(this.p(...file(name)));
        if (rec && !dead.has(rec.id)) into.set(rec.id, rec);
      }
    };
    await loadAll<Project>(["projects"], (n) => ["projects", n, "project.json"], this.projects);
    for (const project of this.projects.values()) {
      for (const name of await listDir(this.p("projects", project.id, "drafts"))) {
        if (!name.endsWith(".json")) continue;
        const v = await readJson<DraftVersion>(this.p("projects", project.id, "drafts", name));
        if (v) this.drafts.set(v.id, v);
      }
    }
    await loadAll<Example>(["examples"], (n) => ["examples", n, "metadata.json"], this.examples);
    await loadAll<Decision>(["decisions"], (n) => ["decisions", n], this.decisions);
    await loadAll<Proposal>(["proposals"], (n) => ["proposals", n], this.proposals);
    await loadAll<Run>(["runs"], (n) => ["runs", n, "receipt.json"], this.runs);
    /* A run interrupted by a crash or restart never displays a ready state. */
    for (const run of this.runs.values()) {
      if (!run.finishedAt) {
        run.state = "CHECKS_INCOMPLETE";
        run.history.push({ state: "CHECKS_INCOMPLETE", at: now(), note: "Anika restarted before this run finished." });
        run.finishedAt = now();
        await this.saveRun(run);
      }
    }
  }

  /** Run a mutation under the workspace lock, idempotent by operation id. */
  mutate<T>(opId: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      if (opId && this.ops.has(opId)) return this.ops.get(opId) as T;
      const result = await fn();
      if (opId) this.ops.set(opId, result);
      return result;
    });
  }

  /* -------------------------------------------------------------- personas */

  head(personaId: Id): PersonaRevision {
    const id = this.heads.get(personaId);
    const rev = this.revisions.get(personaId)?.find((r) => r.id === id);
    if (!rev) throw new AnikaError("PROFILE_MISSING", "This persona has no committed memory.");
    return rev;
  }

  revision(personaId: Id, revisionId: Id): PersonaRevision {
    const rev = this.revisions.get(personaId)?.find((r) => r.id === revisionId);
    if (!rev) throw new AnikaError("NOT_FOUND", `Revision ${revisionId} not found.`);
    return rev;
  }

  /**
   * Commit protocol: stage the full release, flush, move it into place, then
   * atomically replace HEAD. Caller must hold the lock (use within mutate()).
   */
  async commitRevision(rev: PersonaRevision, expectedParent: Id | null): Promise<void> {
    const pid = safeId(rev.persona.id);
    const currentHead = this.heads.get(pid) ?? null;
    if (currentHead !== expectedParent) {
      throw new AnikaError("VERSION_CONFLICT", `Memory changed (expected ${expectedParent ?? "none"}, found ${currentHead ?? "none"}).`);
    }
    const staging = this.p(".anika", "staging", `${rev.id}-${Date.now()}`);
    await atomicWrite(path.join(staging, "manifest.json"), JSON.stringify(rev, null, 2));
    await atomicWrite(path.join(staging, "core.md"), renderRevisionMarkdown(rev));
    const finalDir = this.p("personas", pid, "releases", safeId(rev.id));
    await fs.mkdir(path.dirname(finalDir), { recursive: true });
    await fs.rm(finalDir, { recursive: true, force: true });
    await fs.rename(staging, finalDir);
    await syncDir(path.dirname(finalDir));
    await atomicWrite(this.p("personas", pid, "HEAD.json"), JSON.stringify({ revision: rev.id, hash: rev.hash }, null, 2));

    const list = this.revisions.get(pid) ?? [];
    this.revisions.set(pid, [...list.filter((r) => r.id !== rev.id), rev]);
    this.heads.set(pid, rev.id);
    if (!this.workspace.personaIds.includes(pid)) {
      this.workspace.personaIds.push(pid);
      await atomicWrite(this.p("workspace.json"), JSON.stringify(this.workspace, null, 2));
    }
    await this.renderWorkingNotes(rev);
  }

  /** Human-readable working notes for Obsidian. Derived; safe to regenerate. */
  private async renderWorkingNotes(rev: PersonaRevision): Promise<void> {
    const base = this.p("personas", rev.persona.id, "working");
    await fs.rm(base, { recursive: true, force: true });
    await atomicWrite(path.join(base, "core.md"), renderRevisionMarkdown(rev));
    for (const mode of rev.modes) {
      const rules = rev.rules.filter((r) => r.scope.kind === "mode" && r.scope.modeIds.includes(mode.id));
      await atomicWrite(
        path.join(base, "modes", `${safeId(mode.id)}.md`),
        `# ${mode.name}\n\n${mode.description}\n\n${rules.map((r) => `- [[${r.id}]] ${r.statement}`).join("\n")}\n`,
      );
    }
    for (const rule of rev.rules) {
      await atomicWrite(path.join(base, "rules", `${safeId(rule.id)}.md`), renderRuleMarkdown(rule));
    }
  }

  /* ------------------------------------------------------- simple records */

  async saveProject(p: Project): Promise<void> {
    await atomicWrite(this.p("projects", safeId(p.id), "project.json"), JSON.stringify(p, null, 2));
    await atomicWrite(this.p("projects", p.id, "brief.md"), p.brief + "\n");
    this.projects.set(p.id, p);
  }

  async saveDraft(v: DraftVersion): Promise<void> {
    const dir = this.p("projects", safeId(v.projectId), "drafts");
    await atomicWrite(path.join(dir, `${safeId(v.id)}.json`), JSON.stringify(v));
    await atomicWrite(path.join(dir, `${v.id}.md`), blocksToMarkdown(v.blocks));
    this.drafts.set(v.id, v);
  }

  async saveExample(e: Example): Promise<void> {
    const dir = this.p("examples", safeId(e.id));
    await atomicWrite(path.join(dir, "source.md"), blocksToMarkdown(e.blocks));
    await atomicWrite(path.join(dir, "metadata.json"), JSON.stringify(e, null, 2));
    this.examples.set(e.id, e);
  }

  async saveDecision(d: Decision): Promise<void> {
    await atomicWrite(this.p("decisions", `${safeId(d.id)}.json`), JSON.stringify(d, null, 2));
    this.decisions.set(d.id, d);
  }

  async saveProposal(p: Proposal): Promise<void> {
    await atomicWrite(this.p("proposals", `${safeId(p.id)}.json`), JSON.stringify(p, null, 2));
    this.proposals.set(p.id, p);
  }

  async saveRun(r: Run): Promise<void> {
    await atomicWrite(this.p("runs", safeId(r.id), "receipt.json"), JSON.stringify(r, null, 2));
    this.runs.set(r.id, r);
  }

  async saveRegressionCase(c: { id: Id; ruleId: Id; before: string; after: string | null; feedback: string; gold: "pending_human_approval" }): Promise<void> {
    await atomicWrite(this.p("evals", "regression", `${safeId(c.id)}.json`), JSON.stringify(c, null, 2));
  }

  /* --------------------------------------------------------------- deletion */

  /**
   * Two-stage deletion: tombstone first so nothing new can use the material,
   * then purge files and derived copies. Returns what was removed.
   */
  async deleteRecords(ids: { id: Id; kind: "example" | "project" }[]): Promise<{ removed: string[]; tombstoned: Id[] }> {
    const at = now();
    this.tombstones.push(...ids.map((i) => ({ id: i.id, kind: i.kind, deletedAt: at })));
    await atomicWrite(this.p("tombstones.json"), JSON.stringify(this.tombstones, null, 2));
    const removed: string[] = [];
    for (const { id, kind } of ids) {
      if (kind === "example") {
        this.examples.delete(id);
        await fs.rm(this.p("examples", safeId(id)), { recursive: true, force: true });
        removed.push(`examples/${id}/`);
      } else {
        this.projects.delete(id);
        for (const [vid, v] of this.drafts) if (v.projectId === id) this.drafts.delete(vid);
        await fs.rm(this.p("projects", safeId(id)), { recursive: true, force: true });
        removed.push(`projects/${id}/`);
        for (const [did, d] of this.decisions) {
          if (d.projectId !== id) continue;
          this.decisions.delete(did);
          await fs.rm(this.p("decisions", `${safeId(did)}.json`), { force: true });
          removed.push(`decisions/${did}.json`);
        }
        for (const [rid, r] of this.runs) {
          if (r.projectId !== id) continue;
          this.runs.delete(rid);
          await fs.rm(this.p("runs", safeId(rid)), { recursive: true, force: true });
          removed.push(`runs/${rid}/`);
        }
      }
    }
    await fs.rm(this.p(".anika", "staging"), { recursive: true, force: true });
    return { removed, tombstoned: ids.map((i) => i.id) };
  }

  /**
   * Deletion is the documented exception to append-only history: excerpts
   * quoted from a deleted source are removed from every committed release and
   * proposal. Affected releases are re-hashed and marked as purged.
   */
  async purgeEvidenceExcerpts(personaId: Id, sourceId: Id): Promise<number> {
    let touched = 0;
    const releases = this.revisions.get(personaId) ?? [];
    const updated: PersonaRevision[] = [];
    for (const rev of releases) {
      const hit = rev.rules.some((r) => r.evidence.some((e) => e.id === sourceId && e.excerpt));
      if (!hit) {
        updated.push(rev);
        continue;
      }
      const { hash: _old, ...rest } = rev;
      const cleaned: Omit<PersonaRevision, "hash"> = {
        ...rest,
        operation: rev.operation.includes("(excerpts purged)") ? rev.operation : `${rev.operation} (excerpts purged)`,
        rules: rev.rules.map((r) => ({ ...r, evidence: r.evidence.map((e) => (e.id === sourceId ? { id: e.id, kind: e.kind } : e)) })),
      };
      const next: PersonaRevision = { ...cleaned, hash: revisionHash(cleaned) };
      const dir = this.p("personas", safeId(personaId), "releases", safeId(rev.id));
      await atomicWrite(path.join(dir, "manifest.json"), JSON.stringify(next, null, 2));
      await atomicWrite(path.join(dir, "core.md"), renderRevisionMarkdown(next));
      if (this.heads.get(personaId) === rev.id) {
        await atomicWrite(this.p("personas", personaId, "HEAD.json"), JSON.stringify({ revision: rev.id, hash: next.hash }, null, 2));
        await this.renderWorkingNotes(next);
      }
      updated.push(next);
      touched++;
    }
    this.revisions.set(personaId, updated);
    for (const p of this.proposals.values()) {
      const hit = p.changes.some((c) => c.op === "add" && c.rule.evidence.some((e) => e.id === sourceId && e.excerpt));
      if (!hit) continue;
      await this.saveProposal({
        ...p,
        changes: p.changes.map((c) => (c.op === "add" ? { ...c, rule: { ...c.rule, evidence: c.rule.evidence.map((e) => (e.id === sourceId ? { id: e.id, kind: e.kind } : e)) } } : c)),
        /* The proposal's text changed, so any outstanding approval no longer matches. */
        status: p.status === "pending" ? "rejected" : p.status,
      });
      touched++;
    }
    return touched;
  }

  isDeleted(id: Id): boolean {
    return this.tombstones.some((t) => t.id === id);
  }

  /** Hash for draft content (exact blocks). */
  static draftHash(blocks: unknown): string {
    return digest(blocks);
  }
}

/* --------------------------------------------------------------- rendering */

function scopeLabel(rule: PersonaRevision["rules"][number], rev: PersonaRevision): string {
  if (rule.scope.kind === "core") return "core voice";
  const ids = rule.scope.modeIds;
  return ids.map((id) => rev.modes.find((m) => m.id === id)?.name ?? id).join(", ");
}

export function renderRevisionMarkdown(rev: PersonaRevision): string {
  const lines = [
    `# ${rev.persona.name} — ${rev.id}`,
    "",
    `Committed ${rev.createdAt} · ${rev.operation}`,
    "",
    "> Accepted memory. Edit the notes in `working/` instead; releases are checked for integrity.",
    "",
    "## Rules",
    "",
  ];
  for (const r of rev.rules.filter((x) => x.status === "active")) {
    lines.push(`- **${r.statement}** _(${scopeLabel(r, rev)}, ${r.strength})_ [[${r.id}]]`);
  }
  lines.push("", "## Modes", "");
  for (const m of rev.modes) lines.push(`- **${m.name}** — ${m.description}`);
  return lines.join("\n") + "\n";
}

function renderRuleMarkdown(rule: PersonaRevision["rules"][number]): string {
  const fm = [
    "---",
    `id: ${rule.id}`,
    `status: ${rule.status}`,
    `strength: ${rule.strength}`,
    `scope: ${rule.scope.kind === "core" ? "core" : rule.scope.modeIds.join(", ")}`,
    `origin: ${rule.origin}`,
    `evidence: ${rule.evidenceLevel}`,
    "---",
  ];
  const body = [
    "",
    `# ${rule.statement}`,
    "",
    rule.exceptions.length ? `Exceptions:\n${rule.exceptions.map((e) => `- ${e}`).join("\n")}\n` : "",
    rule.rawFeedback ? `Original feedback:\n\n> ${rule.rawFeedback}\n` : "",
    rule.evidence.length ? `Evidence:\n${rule.evidence.map((e) => `- ${e.kind} ${e.id}${e.excerpt ? `: “${e.excerpt}”` : ""}`).join("\n")}\n` : "",
  ];
  return fm.concat(body).join("\n");
}
