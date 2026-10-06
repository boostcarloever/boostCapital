/**
 * Data and models: where things live, what is sent where, usage, export,
 * import with a dry run, and deletion.
 */
import { useRef, useState } from "react";
import type { PersonaRevision, Project } from "../core/types";
import { api, type AppState } from "./api";
import { useToast } from "./bits";

export function DataModels(props: { state: AppState; persona: PersonaRevision; project: Project | null; refresh: () => Promise<void>; onProjectDeleted: () => void }) {
  const { state, persona, project, refresh } = props;
  const { fail, say } = useToast();
  const [plan, setPlan] = useState<null | { bundle: unknown; plan: Record<string, unknown> }>(null);
  const [confirm, setConfirm] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const p = state.processor;

  return (
    <>
      <header className="section-head">
        <h1>
          Data <em>&amp;</em> models
        </h1>
        <p className="dek">Your memory is plain files in a folder you chose. Only the excerpts a check needs are sent to the model provider, and only when you run a check.</p>
      </header>

      <div className="columns">
        <div>
          <section className="department">
            <div className="department__head">
              <h2>Where your writing lives</h2>
            </div>
            <p className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
              {state.workspace.root}
            </p>
            <p className="ink2" style={{ fontSize: 15 }}>
              Persona memory is stored as Markdown and JSON. Open the folder in Obsidian or any editor to read it: <span className="mono">personas/…/working/</span> holds readable notes,{" "}
              <span className="mono">releases/</span> holds committed versions that are checked for tampering. These files are not encrypted; rely on your account password and full-disk encryption.
            </p>
            {state.quarantined.length > 0 && (
              <div className="notice error">
                <span className="label">Quarantined</span>
                <p>
                  {state.quarantined.map((q) => `${q.revisionId}: ${q.reason}`).join(" ")} The last valid version is in use.
                </p>
              </div>
            )}
          </section>

          <section className="department">
            <div className="department__head">
              <h2>Model processor</h2>
              <span className={`tag ${p.available ? "tag--solid" : "tag--accent"}`}>{p.available ? "Connected" : "Not configured"}</span>
            </div>
            <div className="two" style={{ marginTop: 8 }}>
              <div>
                <span className="label">Provider</span>
                <p style={{ margin: "2px 0 10px" }}>{p.provider}</p>
                <span className="label">Model</span>
                <p className="mono" style={{ margin: "2px 0 10px" }}>
                  {p.model}
                </p>
                <span className="label">Fallback</span>
                <p style={{ margin: "2px 0 10px", fontSize: 15 }}>{p.fallback}</p>
              </div>
              <div>
                <span className="label">Sent with a check</span>
                <ul style={{ margin: "4px 0 12px", paddingLeft: "1.1em", fontSize: 15 }}>
                  {p.sends.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
                <span className="label">Never sent</span>
                <ul style={{ margin: "4px 0 0", paddingLeft: "1.1em", fontSize: 15 }}>
                  {p.neverSends.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            </div>
            {!p.available && (
              <p className="notice">
                <span className="label">Offline mode</span>
                <span>Editing, saving, memory, and exact checks work. Voice review, meaning review, revision, and profile suggestions report “unavailable” until <span className="mono">ANTHROPIC_API_KEY</span> is set for the local service.</span>
              </p>
            )}
          </section>

          <section className="department">
            <div className="department__head">
              <h2>Usage</h2>
            </div>
            <p className="ink2" style={{ fontSize: 15 }}>
              {state.usage.requests} model request{state.usage.requests === 1 ? "" : "s"} · {state.usage.inputTokens.toLocaleString()} input and {state.usage.outputTokens.toLocaleString()} output tokens recorded
              {state.usage.someUnknown ? " (some runs reported unknown usage)" : ""}. Each run is capped at 12 requests and 2 repair passes.
            </p>
          </section>
        </div>

        <aside>
          <section className="department">
            <div className="department__head">
              <h2>Export</h2>
            </div>
            <p className="ink2" style={{ fontSize: 15 }}>
              {persona.persona.name}'s memory, versions, examples, and pieces, with checksums. Credentials, caches, and other personas are left out.
            </p>
            <a className="btn btn--small" href={api.exportUrl(persona.persona.id)} download>
              Download export
            </a>
          </section>

          <section className="department">
            <div className="department__head">
              <h2>Import</h2>
            </div>
            <p className="ink2" style={{ fontSize: 15 }}>Anika checks the file and shows what would change before changing anything.</p>
            <button className="tbtn" onClick={() => fileRef.current?.click()}>
              Choose an export file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const bundle = JSON.parse(await file.text());
                  setPlan({ bundle, plan: await api.importPlan(bundle) });
                } catch (err) {
                  fail(err instanceof SyntaxError ? new Error("That file is not a readable export.") : err);
                }
                e.target.value = "";
              }}
            />
            {plan && (
              <div className="panel">
                <span className="label">Dry run</span>
                <p style={{ margin: 0, fontSize: 15 }}>
                  {String(plan.plan.persona)}: {String(plan.plan.revisions)} versions, {String(plan.plan.examples)} examples, {String(plan.plan.projects)} pieces. Checksums{" "}
                  {plan.plan.checksumsValid ? "verified" : `failed for ${(plan.plan.mismatched as string[]).join(", ")}`}.
                </p>
                <p style={{ margin: 0, fontSize: 15 }}>{String(plan.plan.note)}</p>
                <div className="tbtn-row">
                  <button
                    className="btn btn--small"
                    disabled={!plan.plan.canApply}
                    onClick={async () => {
                      try {
                        await api.importApply(plan.bundle);
                        say("Imported.");
                        setPlan(null);
                        await refresh();
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  >
                    Import
                  </button>
                  <button className="tbtn" onClick={() => setPlan(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>

          {project && (
            <section className="department">
              <div className="department__head">
                <h2>Delete a piece</h2>
              </div>
              <p className="ink2" style={{ fontSize: 15 }}>
                Deletes “{project.title}”, all its versions, its check receipts, and the corrections recorded on it. Rules already approved stay until you retire them.
              </p>
              <label className="field">
                <span>Type the title to confirm</span>
                <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </label>
              <button
                className="btn btn--small"
                style={{ marginTop: 10 }}
                disabled={confirm !== project.title}
                onClick={async () => {
                  try {
                    const out = await api.deleteProject(project.id, confirm);
                    say(`Deleted ${out.removed.length} records. ${out.caveat}`);
                    setConfirm("");
                    props.onProjectDeleted();
                    await refresh();
                  } catch (err) {
                    fail(err);
                  }
                }}
              >
                Delete permanently
              </button>
              <p className="meta" style={{ marginTop: 8 }}>
                Exported copies, synced folders, and OS backups are outside Anika's reach. Text already sent to the provider follows the provider's retention policy.
              </p>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
