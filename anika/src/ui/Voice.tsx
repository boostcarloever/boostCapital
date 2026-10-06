/**
 * Your voice: rules grouped by scope with plain wording, origin, evidence,
 * status, change scope, retire, and undo through visible revisions.
 */
import { useEffect, useState } from "react";
import type { Checker, Id, PersonaRevision, Proposal, Rule, RuleScope } from "../core/types";
import { api, type AppState } from "./api";
import { day, ORIGIN, pad, scopeText, stamp, useToast } from "./bits";

export function Voice(props: { state: AppState; persona: PersonaRevision; refresh: () => Promise<void>; goExamples: () => void }) {
  const { state, persona, refresh } = props;
  const { fail, say } = useToast();
  const [revisions, setRevisions] = useState<PersonaRevision[]>([]);
  const pending = state.proposals.filter((p) => p.personaId === persona.persona.id && p.status === "pending");
  const active = persona.rules.filter((r) => r.status === "active");
  const retired = persona.rules.filter((r) => r.status === "retired");
  const core = active.filter((r) => r.scope.kind === "core");

  useEffect(() => {
    api.revisions(persona.persona.id).then((r) => setRevisions([...r].reverse()), fail);
  }, [persona.id, persona.persona.id, fail]);

  const act = async (fn: () => Promise<unknown>, message?: string) => {
    try {
      await fn();
      if (message) say(message);
    } catch (err) {
      fail(err);
    }
    await refresh();
  };

  let n = 0;
  const numbered = (r: Rule) => ({ rule: r, n: ++n });

  return (
    <>
      <header className="section-head">
        <h1>
          Your <em>voice</em>
        </h1>
        <p className="dek">
          The decisions Anika applies on your behalf, grouped by where they apply. Each one says where it came from, and every change makes a new version you can undo.
        </p>
      </header>

      <div className="columns">
        <div>
          {pending.length > 0 && (
            <section className="department" aria-labelledby="pending-h">
              <div className="department__head">
                <h2 id="pending-h">Awaiting your approval</h2>
                <span className="label accent">{pending.length} memory change{pending.length === 1 ? "" : "s"}</span>
              </div>
              {pending.map((p) => (
                <ProposalCard key={p.id} proposal={p} persona={persona} onDone={refresh} />
              ))}
            </section>
          )}

          <section className="department" aria-labelledby="core-h">
            <div className="department__head">
              <h2 id="core-h">Always</h2>
              <span className="label">Core voice · every mode</span>
            </div>
            {!core.length && <p className="muted italic">No core rules yet. Core rules apply to everything you write, so add them sparingly.</p>}
            {core.map((r) => (
              <RuleRow key={r.id} {...numbered(r)} persona={persona} act={act} />
            ))}
          </section>

          {persona.modes.map((m) => {
            const rules = active.filter((r) => r.scope.kind === "mode" && r.scope.modeIds.includes(m.id));
            return (
              <section className="department" key={m.id} aria-labelledby={`mode-${m.id}`}>
                <div className="department__head">
                  <h2 id={`mode-${m.id}`}>{m.name}</h2>
                  <span className="label">{m.description || "Mode"}</span>
                </div>
                {!rules.length && <p className="muted italic">Nothing specific to this mode yet. Corrections you make while writing in it can land here.</p>}
                {rules.map((r) => (
                  <RuleRow key={`${m.id}-${r.id}`} {...numbered(r)} persona={persona} act={act} />
                ))}
              </section>
            );
          })}

          {retired.length > 0 && (
            <details className="department">
              <summary className="department__head" style={{ cursor: "pointer" }}>
                <h2>Retired</h2>
                <span className="label">{retired.length} · not used in new context</span>
              </summary>
              {retired.map((r) => (
                <RuleRow key={r.id} rule={r} n={0} persona={persona} act={act} />
              ))}
            </details>
          )}

          <AddRule persona={persona} act={act} />
        </div>

        <aside>
          <section className="department" style={{ paddingTop: 28 }}>
            <div className="department__head">
              <h2>Learning</h2>
            </div>
            <fieldset>
              <legend className="sr-only">Learning policy</legend>
              <label className="choice">
                <input
                  type="radio"
                  checked={persona.persona.learningPolicy === "review"}
                  onChange={() => act(() => api.setPolicy(persona.persona.id, { expectedRevision: persona.id, learningPolicy: "review" }))}
                />
                <span>
                  Review every change
                  <small>Anika proposes; you approve.</small>
                </span>
              </label>
              <label className="choice">
                <input
                  type="radio"
                  checked={persona.persona.learningPolicy === "remember_explicit"}
                  onChange={() => act(() => api.setPolicy(persona.persona.id, { expectedRevision: persona.id, learningPolicy: "remember_explicit" }))}
                />
                <span>
                  Remember explicit corrections
                  <small>Clear style instructions scoped to one mode are kept at once, with undo. Never global, never inferred.</small>
                </span>
              </label>
            </fieldset>
          </section>

          <ProfileSuggest persona={persona} state={state} refresh={refresh} goExamples={props.goExamples} />

          <section className="department">
            <div className="department__head">
              <h2>Modes</h2>
            </div>
            <ul className="ledger">
              {persona.modes.map((m) => (
                <li key={m.id} style={{ gridTemplateColumns: "1fr" }}>
                  <span className="what">
                    <strong style={{ fontWeight: 600 }}>{m.name}</strong> {m.description && <span className="muted">— {m.description}</span>}
                  </span>
                </li>
              ))}
            </ul>
            <AddMode persona={persona} act={act} />
          </section>

          <section className="department">
            <div className="department__head">
              <h2>Versions</h2>
              <span className="label">{persona.id} is current</span>
            </div>
            <ol className="ledger" reversed>
              {revisions.map((r) => (
                <li key={r.id}>
                  <span className="when">
                    {r.id.replace("rev_", "v")}
                    <br />
                    {day(r.createdAt)}
                  </span>
                  <span className="what">
                    {r.operation}
                    {r.actor === "policy" && <span className="muted"> · by your standing setting</span>}
                  </span>
                  {r.id !== persona.id && (
                    <span className="actions">
                      <button
                        className="tbtn"
                        onClick={() =>
                          act(() => api.restore(persona.persona.id, { expectedRevision: persona.id, targetRevision: r.id }), `Restored ${r.id} as a new version.`)
                        }
                      >
                        Restore this version
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ rule */

function RuleRow(props: { rule: Rule; n: number; persona: PersonaRevision; act: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const { rule, persona, act } = props;
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(rule.statement);
  const [scoping, setScoping] = useState(false);
  const pid = persona.persona.id;
  const expected = { expectedRevision: persona.id };

  return (
    <div className="rule" data-status={rule.status}>
      <span className="rule__n">{props.n ? `§${pad(props.n)}` : "—"}</span>
      <div>
        {editing ? (
          <div className="grid-form" style={{ marginBottom: 8 }}>
            <textarea className="textarea" value={statement} onChange={(e) => setStatement(e.target.value)} aria-label="Rule wording" />
            <div className="tbtn-row">
              <button className="btn btn--small" onClick={() => act(() => api.updateRule(pid, rule.id, { ...expected, statement }), "Saved as a new version.").then(() => setEditing(false))}>
                Save wording
              </button>
              <button className="tbtn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="rule__statement">{rule.statement}</p>
        )}
        <div className="rule__meta">
          <span className={`tag ${rule.strength === "hard" ? "tag--solid" : ""}`}>{rule.strength === "hard" ? "Always enforce" : "Preference"}</span>
          <span className="tag">{checkerLabel(rule.checker)}</span>
          <span className="label">{ORIGIN[rule.origin]}</span>
          <span className="label">{scopeText(rule, persona.modes)}</span>
          <span className="label">Evidence: {rule.evidenceLevel.replace("_", " ")}</span>
        </div>
        {rule.exceptions.map((e, i) => (
          <p className="rule__exc" key={i}>
            {e}
          </p>
        ))}
        {rule.rawFeedback && <p className="rule__ev">You said: “{rule.rawFeedback}”</p>}
        {rule.evidence
          .filter((e) => e.excerpt && e.kind !== "user_statement")
          .slice(0, 3)
          .map((e) => (
            <p className="rule__ev" key={e.id}>
              {e.kind === "example" ? "From an example" : "From a decision"}: “{e.excerpt}”
            </p>
          ))}

        {scoping && <ScopeEditor rule={rule} persona={persona} onCancel={() => setScoping(false)} onSave={(scope) => act(() => api.updateRule(pid, rule.id, { ...expected, scope }), "Scope changed.").then(() => setScoping(false))} />}

        {rule.status === "active" && !editing && !scoping && (
          <div className="tbtn-row">
            <button className="tbtn" onClick={() => setEditing(true)}>
              Change wording
            </button>
            <button className="tbtn" onClick={() => setScoping(true)}>
              Change scope
            </button>
            <button className="tbtn" onClick={() => act(() => api.updateRule(pid, rule.id, { ...expected, strength: rule.strength === "hard" ? "preference" : "hard" }))}>
              {rule.strength === "hard" ? "Make a preference" : "Always enforce"}
            </button>
            <button className="tbtn danger" onClick={() => act(() => api.retireRule(pid, rule.id, expected), "Retired. Restore it from Versions if that was a mistake.")}>
              Retire
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function checkerLabel(c: Checker): string {
  switch (c.kind) {
    case "forbidden_chars":
      return `Checked: never ${c.chars.map((x) => (x === "—" ? "em dash" : x === "–" ? "en dash" : x)).join(", ")}`;
    case "forbidden_phrases":
      return `Checked: ${c.phrases.length} phrase${c.phrases.length === 1 ? "" : "s"}`;
    case "length_words":
      return `Checked: ${c.min ? `≥${c.min}` : ""}${c.min && c.max ? ", " : ""}${c.max ? `≤${c.max}` : ""} words`;
    case "required_heading":
      return `Checked: heading “${c.text}”`;
    default:
      return "Judged in voice review";
  }
}

function ScopeEditor(props: { rule: Rule; persona: PersonaRevision; onSave: (s: RuleScope) => void; onCancel: () => void }) {
  const [core, setCore] = useState(props.rule.scope.kind === "core");
  const [modes, setModes] = useState<Id[]>(props.rule.scope.kind === "mode" ? props.rule.scope.modeIds : []);
  return (
    <div className="panel">
      <span className="label">Applies to</span>
      <label className="choice">
        <input type="radio" checked={core} onChange={() => setCore(true)} />
        <span>Everything I write</span>
      </label>
      <label className="choice">
        <input type="radio" checked={!core} onChange={() => setCore(false)} />
        <span>Only these modes</span>
      </label>
      {!core &&
        props.persona.modes.map((m) => (
          <label className="choice" key={m.id} style={{ paddingLeft: 24 }}>
            <input type="checkbox" checked={modes.includes(m.id)} onChange={(e) => setModes((x) => (e.target.checked ? [...x, m.id] : x.filter((y) => y !== m.id)))} />
            <span>{m.name}</span>
          </label>
        ))}
      <div className="tbtn-row">
        <button className="btn btn--small" disabled={!core && !modes.length} onClick={() => props.onSave(core ? { kind: "core" } : { kind: "mode", modeIds: modes })}>
          Save scope
        </button>
        <button className="tbtn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- proposal */

function ProposalCard(props: { proposal: Proposal; persona: PersonaRevision; onDone: () => Promise<void> }) {
  const { proposal, persona } = props;
  const { fail, say } = useToast();
  const adds = proposal.changes.filter((c) => c.op === "add") as Extract<Proposal["changes"][number], { op: "add" }>[];
  const [keep, setKeep] = useState<Id[]>(adds.map((c) => c.rule.id));
  const [edits, setEdits] = useState<Record<Id, string>>({});
  const stale = proposal.baseRevision !== persona.id;
  const multi = adds.length > 1;

  const approve = async () => {
    try {
      if (multi || Object.keys(edits).length) await api.approvePartial(proposal.id, { hash: proposal.hash, expectedRevision: persona.id, keepRuleIds: keep, edits });
      else await api.approve(proposal.id, { hash: proposal.hash, expectedRevision: persona.id });
      say("Approved. The next matching run uses it.");
    } catch (err) {
      fail(err);
    }
    await props.onDone();
  };
  const reject = async () => {
    try {
      await api.reject(proposal.id);
    } catch (err) {
      fail(err);
    }
    await props.onDone();
  };

  return (
    <div className="rule" data-status="proposed">
      <span className="rule__n">{stamp(proposal.createdAt).split(",")[0]}</span>
      <div>
        <span className="label accent">
          {proposal.origin === "profile" ? "Provisional profile" : proposal.origin === "evaluator_feedback" ? "From disagreeing with a note" : "From your correction"}
          {proposal.classification.length ? ` · ${proposal.classification.join(", ").replace(/_/g, " ")}` : ""}
        </span>
        <p className="rule__statement" style={{ fontSize: 19, marginTop: 4 }}>
          {proposal.title}
        </p>
        {proposal.rawFeedback && <p className="rule__ev">You said: “{proposal.rawFeedback}”</p>}
        {proposal.changes.map((c, i) => {
          if (c.op === "add") {
            return (
              <div key={c.rule.id} style={{ borderTop: "1px dashed var(--rule-soft)", padding: "8px 0" }}>
                {multi && (
                  <label className="choice">
                    <input type="checkbox" checked={keep.includes(c.rule.id)} onChange={(e) => setKeep((k) => (e.target.checked ? [...k, c.rule.id] : k.filter((x) => x !== c.rule.id)))} />
                    <span className="label">Keep this rule</span>
                  </label>
                )}
                <textarea
                  className="textarea"
                  style={{ minHeight: 56, fontSize: 17 }}
                  value={edits[c.rule.id] ?? c.rule.statement}
                  onChange={(e) => setEdits((x) => ({ ...x, [c.rule.id]: e.target.value }))}
                  aria-label="Proposed rule wording"
                />
                <div className="rule__meta" style={{ marginTop: 6 }}>
                  <span className="label">{scopeText(c.rule, persona.modes)}</span>
                  <span className="label">Evidence: {c.rule.evidenceLevel.replace("_", " ")}</span>
                </div>
                {c.rule.evidence
                  .filter((e) => e.excerpt)
                  .map((e) => (
                    <p className="rule__ev" key={e.id + e.excerpt}>
                      “{e.excerpt}”
                    </p>
                  ))}
              </div>
            );
          }
          const target = persona.rules.find((r) => r.id === c.ruleId);
          return (
            <div key={i} style={{ borderTop: "1px dashed var(--rule-soft)", padding: "8px 0" }}>
              <p className="rule__ev">Rule: “{target?.statement ?? c.ruleId}”</p>
              {c.op === "retire" && <p>Retire it.</p>}
              {c.op === "update" && c.patch.statement && (
                <p>
                  New wording: <ins>{c.patch.statement}</ins>
                </p>
              )}
              {c.op === "update" && c.patch.exceptions && (
                <p>
                  Add exception: <ins>{c.patch.exceptions[c.patch.exceptions.length - 1]}</ins>
                </p>
              )}
            </div>
          );
        })}
        {stale && (
          <p className="notice error" style={{ margin: "8px 0" }}>
            <span className="label">Out of date</span>
            <span>Your memory changed since this was proposed (based on {proposal.baseRevision}, now {persona.id}). Reject it and correct again if it still matters.</span>
          </p>
        )}
        <div className="tbtn-row" style={{ marginTop: 8 }}>
          <button className="btn btn--small" onClick={approve} disabled={stale || (multi && !keep.length)}>
            {multi ? `Approve ${keep.length} of ${adds.length}` : "Approve"}
          </button>
          <button className="tbtn" onClick={reject}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- add forms */

function AddRule(props: { persona: PersonaRevision; act: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const { persona } = props;
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");
  const [scope, setScope] = useState<string>("core");
  const [strength, setStrength] = useState<"preference" | "hard">("preference");
  const [kind, setKind] = useState<Checker["kind"]>("llm_rubric");
  const [param, setParam] = useState("");

  if (!open) {
    return (
      <div style={{ padding: "24px 0" }}>
        <button className="btn btn--ghost" onClick={() => setOpen(true)}>
          Write a rule yourself
        </button>
      </div>
    );
  }

  const checker = (): Checker | undefined => {
    switch (kind) {
      case "forbidden_chars":
        return { kind, chars: [...param.replace(/\s|,/g, "")], regions: "author_prose" };
      case "forbidden_phrases":
        return { kind, phrases: param.split(",").map((s) => s.trim()).filter(Boolean), caseSensitive: false, regions: "author_prose" };
      case "length_words": {
        const [min, max] = param.split(/[-–,]/).map((x) => Number(x.trim()));
        return { kind, min: min || undefined, max: max || undefined };
      }
      case "required_heading":
        return { kind, text: param };
      default:
        return undefined;
    }
  };

  return (
    <form
      className="panel"
      style={{ margin: "24px 0" }}
      onSubmit={async (e) => {
        e.preventDefault();
        await props.act(
          () =>
            api.addRule(persona.persona.id, {
              expectedRevision: persona.id,
              statement,
              strength,
              scope: scope === "core" ? { kind: "core" } : { kind: "mode", modeIds: [scope] },
              checker: checker(),
            }),
          "Rule added as a new version.",
        );
        setOpen(false);
        setStatement("");
        setParam("");
        setStrength("preference");
        setKind("llm_rubric");
        setScope("core");
      }}
    >
      <h3>Write a rule</h3>
      <label className="field">
        <span>In plain words</span>
        <textarea className="textarea" required value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="Never use em dashes." />
      </label>
      <div className="two">
        <label className="field">
          <span>Applies to</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="core">Everything I write</option>
            {persona.modes.map((m) => (
              <option key={m.id} value={m.id}>
                Only {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Strength</span>
          <select className="select" value={strength} onChange={(e) => setStrength(e.target.value as "hard" | "preference")}>
            <option value="preference">Preference</option>
            <option value="hard">Always enforce</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>How Anika checks it</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Checker["kind"])}>
          <option value="llm_rubric">Judged by the voice reviewer</option>
          <option value="forbidden_chars">Exact: characters I never use</option>
          <option value="forbidden_phrases">Exact: phrases I never use</option>
          <option value="length_words">Exact: length in words</option>
          <option value="required_heading">Exact: a heading that must appear</option>
        </select>
      </label>
      {kind !== "llm_rubric" && (
        <label className="field">
          <span>
            {kind === "forbidden_chars" && "Characters (e.g. — ! …)"}
            {kind === "forbidden_phrases" && "Phrases, comma separated"}
            {kind === "length_words" && "Range, e.g. 600-1200"}
            {kind === "required_heading" && "Heading text"}
          </span>
          <input className="input" required value={param} onChange={(e) => setParam(e.target.value)} />
        </label>
      )}
      <p className="meta">Exact checks run locally and never need a model. Quotations and block quotes are not checked as your prose.</p>
      <div className="tbtn-row">
        <button className="btn btn--small" type="submit">
          Add rule
        </button>
        <button className="tbtn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddMode(props: { persona: PersonaRevision; act: (fn: () => Promise<unknown>, msg?: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  if (!open)
    return (
      <button className="tbtn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        + Add a mode
      </button>
    );
  return (
    <form
      className="grid-form"
      style={{ marginTop: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        await props.act(() => api.addMode(props.persona.persona.id, { expectedRevision: props.persona.id, name, description }), `Added ${name}.`);
        setOpen(false);
        setName("");
        setDescription("");
      }}
    >
      <label className="field">
        <span>Name</span>
        <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Client email" />
      </label>
      <label className="field">
        <span>Audience and format</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short, warm, never theatrical" />
      </label>
      <div className="tbtn-row">
        <button className="btn btn--small" type="submit">
          Add mode
        </button>
        <button className="tbtn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ProfileSuggest(props: { persona: PersonaRevision; state: AppState; refresh: () => Promise<void>; goExamples: () => void }) {
  const { persona, state } = props;
  const { fail, say } = useToast();
  const [modeId, setModeId] = useState(persona.modes[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const approved = state.examples.filter((e) => e.personaId === persona.persona.id && e.status === "approved" && e.provenance !== "inspiration");
  return (
    <section className="department">
      <div className="department__head">
        <h2>First profile</h2>
      </div>
      <p className="ink2" style={{ fontSize: 15, margin: "6px 0 10px" }}>
        Anika can read your approved examples and propose a few rules, each tied to a passage you wrote. One example gives a provisional profile, not a score.
      </p>
      {!approved.length ? (
        <button className="tbtn" onClick={props.goExamples}>
          Add an example first
        </button>
      ) : (
        <div className="grid-form">
          <label className="field">
            <span>For mode</span>
            <select className="select" value={modeId} onChange={(e) => setModeId(e.target.value)}>
              {persona.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn--small"
            disabled={busy || !state.processor.available}
            onClick={async () => {
              setBusy(true);
              try {
                const out = await api.proposeProfile(persona.persona.id, modeId);
                say(`Proposed ${out.proposal.changes.length} rule${out.proposal.changes.length === 1 ? "" : "s"}${out.discardedWithoutEvidence ? `; ${out.discardedWithoutEvidence} dropped for lack of exact evidence` : ""}.`);
                await props.refresh();
              } catch (err) {
                fail(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Reading your examples…" : `Propose from ${approved.length} example${approved.length === 1 ? "" : "s"}`}
          </button>
          {!state.processor.available && <span className="meta">Unavailable: no model processor configured. You can write rules yourself.</span>}
        </div>
      )}
    </section>
  );
}
