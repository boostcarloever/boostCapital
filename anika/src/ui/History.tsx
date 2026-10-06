/**
 * History: draft versions with before/after comparison and restore,
 * evaluation receipts, and the feedback decisions Anika recorded.
 */
import { useCallback, useEffect, useState } from "react";
import type { Block, PersonaRevision, Project, Run } from "../core/types";
import { api, type AppState, type DraftMeta } from "./api";
import { pad, stamp, useToast, words } from "./bits";
import { ProofSheet } from "./Write";

const ORIGIN: Record<string, string> = {
  user: "Your edit",
  revision: "Revision candidate",
  restore: "Restored",
  import: "Imported",
  conflict: "Kept from a conflicting save",
};

const RUN_LABEL: Record<string, string> = {
  NEEDS_REVIEW: "Needs review",
  READY_FOR_REVIEW: "Ready for your review",
  CHECKS_INCOMPLETE: "Checks incomplete",
  FAILED: "Checks incomplete",
  CANCELED: "Stopped",
};

export function History(props: { state: AppState; persona: PersonaRevision; project: Project | null; refresh: () => Promise<void>; goVoice: () => void }) {
  const { state, persona, project, refresh } = props;
  const { fail, say } = useToast();
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [proof, setProof] = useState<null | { before: Block[]; after: Block[]; beforeLabel: string; afterLabel: string }>(null);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const [d, r] = await Promise.all([api.drafts(project.id), api.runs(project.id)]);
      setDrafts(d);
      setRuns(r);
    } catch (err) {
      fail(err);
    }
  }, [project, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const head = drafts.find((d) => d.id === project?.head);
  const decisions = state.decisions.filter((d) => d.personaId === persona.persona.id);

  async function restore(d: DraftMeta) {
    if (!project) return;
    try {
      const full = await api.draft(d.id);
      await api.saveDraft(project.id, { baseVersionId: project.head, editorJson: full.editorJson, origin: "restore" });
      say("Restored as the newest version. Nothing was deleted.");
      await refresh();
      await load();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <>
      <header className="section-head">
        <h1>
          The <em>record</em>
        </h1>
        <p className="dek">Every saved version, every check and what it was checked against, and every piece of feedback you gave. Restoring never erases anything.</p>
      </header>

      <div className="columns">
        <div>
          <section className="department">
            <div className="department__head">
              <h2>{project ? `Versions of “${project.title}”` : "Versions"}</h2>
              <span className="label">{drafts.length} saved</span>
            </div>
            {!project && <p className="muted italic">Open a piece in Write to see its versions.</p>}
            <ol className="index-list">
              {drafts.map((d, i) => (
                <li key={d.id}>
                  <span className="mono muted">{pad(drafts.length - i)}</span>
                  <div>
                    <span className="t" style={{ fontSize: 18 }}>
                      {stamp(d.createdAt)}
                    </span>
                    <div className="meta">
                      {ORIGIN[d.origin] ?? d.origin} · {words(d.words)} · <span className="mono">{d.hash.slice(7, 19)}</span>
                    </div>
                  </div>
                  <span className="tbtn-row">
                    {d.id === project?.head ? (
                      <span className="tag tag--solid">Current</span>
                    ) : (
                      <>
                        {head && (
                          <button className="tbtn" onClick={() => setProof({ before: d.blocks, after: head.blocks, beforeLabel: stamp(d.createdAt), afterLabel: "Current" })}>
                            Compare
                          </button>
                        )}
                        <button className="tbtn" onClick={() => restore(d)}>
                          Restore
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="department">
            <div className="department__head">
              <h2>Evaluation receipts</h2>
              <span className="label">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
            </div>
            {!runs.length && <p className="muted italic">No checks yet.</p>}
            {runs.map((r) => (
              <details key={r.id} className="rule" style={{ display: "block" }}>
                <summary style={{ cursor: "pointer", listStyle: "none" }}>
                  <span className="label">
                    {stamp(r.startedAt)} · {r.task === "revise" ? "Revision" : "Check"}
                  </span>
                  <p className="rule__statement" style={{ fontSize: 20, margin: "4px 0" }}>
                    {RUN_LABEL[r.state] ?? "Working"} <span className="muted" style={{ fontSize: 15 }}>· {r.findings.length} notes · persona {r.personaRevision}</span>
                  </p>
                </summary>
                <div className="receipt" style={{ borderTop: "none" }}>
                  Run {r.id}
                  <br />
                  Base {r.baseVersionId} · evaluated {r.evaluatedVersionId}
                  {r.candidateVersionIds.length ? ` · candidates ${r.candidateVersionIds.join(", ")}` : ""}
                  <br />
                  {r.manifest && (
                    <>
                      {r.manifest.context_hash}
                      <br />
                      Mode {r.manifest.mode_id} · rules {r.manifest.active_rule_ids.join(", ") || "none"}
                      <br />
                      Examples {r.manifest.example_ids.join(", ") || "none"} · decisions {r.manifest.decision_ids.join(", ") || "none"}
                      <br />
                      Excluded {r.manifest.excluded.length ? r.manifest.excluded.map((e) => `${e.id} (${e.reason.replace(/_/g, " ")})`).join(", ") : "none"}
                      <br />
                      Compiler {r.manifest.compiler_version} · policy {r.manifest.processor_policy_revision}
                      <br />
                    </>
                  )}
                  Requests {r.usage.requests} · tokens {r.usage.inputTokens ?? "unknown"} in / {r.usage.outputTokens ?? "unknown"} out · repair passes {r.repairPasses} · discarded findings {r.rejectedFindings}
                </div>
                <ul className="stages">
                  {(Object.keys(r.sections) as (keyof Run["sections"])[]).map((k) => (
                    <li key={k}>
                      {k.replace("_", " ")}: {r.sections[k].status.replace("_", " ")}
                      {r.sections[k].note ? ` — ${r.sections[k].note}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
        </div>

        <aside>
          <section className="department">
            <div className="department__head">
              <h2>Feedback you gave</h2>
            </div>
            {!decisions.length && <p className="muted italic">Highlight text in Write and choose “Note to Anika”.</p>}
            <ul className="ledger">
              {decisions.map((d) => (
                <li key={d.id}>
                  <span className="when">{stamp(d.createdAt).split(",")[0]}</span>
                  <span className="what">
                    “{d.rawFeedback}”
                    <br />
                    <span className="meta">
                      {d.kind === "evaluator_feedback" ? "About the critic" : "Correction"} · {d.reasonLabels.join(", ").replace(/_/g, " ")} ·{" "}
                      {d.approvedScope === "task" ? "this piece only" : d.approvedScope === "mode" ? "this mode" : d.approvedScope === "core" ? "everything" : d.resultingRuleIds.length ? "became a rule" : "not promoted"}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="department">
            <div className="department__head">
              <h2>Persona versions</h2>
            </div>
            <p className="ink2" style={{ fontSize: 15 }}>
              {persona.persona.name} is at {persona.id}.{" "}
              <button className="tbtn" onClick={props.goVoice}>
                See versions in Your voice
              </button>
            </p>
          </section>
        </aside>
      </div>

      {proof && <ProofSheet title="Compare versions" {...proof} meaningFindings={[]} onClose={() => setProof(null)} />}
    </>
  );
}

