/**
 * Application shell: masthead with a persistent persona/mode dateline,
 * section navigation, onboarding (J01), and the five screens.
 */
import { useCallback, useEffect, useState } from "react";
import type { PersonaRevision, Project } from "../core/types";
import { api, type AppState } from "./api";
import { ToastProvider, useToast } from "./bits";
import { DataModels } from "./DataModels";
import { Examples } from "./Examples";
import { History } from "./History";
import { Voice } from "./Voice";
import { Write } from "./Write";

type View = "write" | "voice" | "examples" | "history" | "data";

const NAV: { key: View; label: string }[] = [
  { key: "write", label: "Write" },
  { key: "voice", label: "Your voice" },
  { key: "examples", label: "Examples" },
  { key: "history", label: "History" },
];

function remember(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(`anika.${key}`);
    if (value === null) localStorage.removeItem(`anika.${key}`);
    else localStorage.setItem(`anika.${key}`, value);
  } catch {
    /* storage unavailable: the app still works without remembering */
  }
  return null;
}

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const { fail } = useToast();
  const [state, setState] = useState<AppState | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (remember("view") as View) || "write");
  const [projectId, setProjectId] = useState<string | null>(() => remember("project"));
  const [personaId, setPersonaId] = useState<string | null>(() => remember("persona"));
  const [addingPersona, setAddingPersona] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setOffline(null);
    } catch (err) {
      setOffline(err instanceof Error ? err.message : "Unavailable");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => void remember("view", view), [view]);
  useEffect(() => void remember("project", projectId), [projectId]);
  useEffect(() => void remember("persona", personaId), [personaId]);

  if (offline && !state) {
    return (
      <div className="masthead">
        <div className="empty" style={{ paddingTop: "20vh" }}>
          <div className="display">Anika is not responding.</div>
          <p>{offline} Your saved writing is safe on disk.</p>
          <button className="btn" onClick={refresh}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!state) return <div className="empty" style={{ paddingTop: "30vh" }}>Opening your workspace…</div>;

  if (!state.personas.length || addingPersona) {
    return (
      <Onboarding
        state={state}
        canCancel={addingPersona}
        onCancel={() => setAddingPersona(false)}
        onDone={async (rev, project) => {
          setPersonaId(rev.persona.id);
          setProjectId(project.id);
          setAddingPersona(false);
          setView("write");
          await refresh();
        }}
      />
    );
  }

  const project = state.projects.find((p) => p.id === projectId) ?? state.projects.find((p) => p.personaId === personaId) ?? state.projects[0] ?? null;
  const persona =
    state.personas.find((p) => p.head.persona.id === (project?.personaId ?? personaId))?.head ?? state.personas[0].head;
  const mode = project ? persona.modes.find((m) => m.id === project.modeId) : persona.modes[0];
  const pending = state.proposals.filter((p) => p.status === "pending").length;

  async function newProject() {
    try {
      const p = await api.createProject({ personaId: persona.persona.id, modeId: project?.modeId && project.personaId === persona.persona.id ? project.modeId : persona.modes[0].id, title: "Untitled piece" });
      setProjectId(p.id);
      setView("write");
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  async function switchContext(fields: { personaId?: string; modeId?: string }) {
    if (!project) {
      if (fields.personaId) setPersonaId(fields.personaId);
      return;
    }
    try {
      await api.updateProject(project.id, fields);
      if (fields.personaId) setPersonaId(fields.personaId);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  const today = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <header className="masthead">
        <div className="masthead__strip">
          <span>Anika Intelligence · local workspace · {state.workspace.root}</span>
          <span>
            {today} · {state.processor.available ? `model: ${state.processor.model}` : "model checks offline"}
          </span>
        </div>
        <div className="masthead__row">
          <a className="wordmark" href="#" onClick={(e) => (e.preventDefault(), setView("write"))} aria-label="Anika, go to Write">
            <span className="wordmark__name">
              Anik<em>a</em>
            </span>
            <span className="wordmark__sub">Intelligence</span>
          </a>
          <span />
          <div className="dateline">
            <div className="dateline__line">
              <span>Writing as</span>
              <select
                aria-label="Persona"
                value={persona.persona.id}
                onChange={(e) => (e.target.value === "__new" ? setAddingPersona(true) : switchContext({ personaId: e.target.value }))}
              >
                {state.personas.map((p) => (
                  <option key={p.head.persona.id} value={p.head.persona.id}>
                    {p.head.persona.name}
                  </option>
                ))}
                <option value="__new">New persona…</option>
              </select>
              <span>in</span>
              <select aria-label="Writing mode" value={mode?.id ?? ""} onChange={(e) => switchContext({ modeId: e.target.value })} disabled={!project}>
                {persona.modes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <span className="label">
              Memory {persona.id.replace("rev_", "v")} · {persona.rules.filter((r) => r.status === "active").length} active rules
            </span>
          </div>
        </div>
        <div className="rule-double" />
        <nav className="nav" aria-label="Sections">
          {NAV.map((n, i) => (
            <button key={n.key} aria-current={view === n.key ? "page" : undefined} onClick={() => setView(n.key)}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>
              {n.label}
              {n.key === "voice" && pending > 0 && <span className="badge" aria-label={`${pending} awaiting approval`}>{pending}</span>}
            </button>
          ))}
          <span className="spacer" />
          <button className="secondary" aria-current={view === "data" ? "page" : undefined} onClick={() => setView("data")}>
            Data &amp; models
          </button>
        </nav>
      </header>

      <main>
        {view === "write" &&
          (project ? (
            <Write
              key={project.id}
              state={state}
              persona={persona}
              project={project}
              refresh={refresh}
              goVoice={() => setView("voice")}
              onSelectProject={setProjectId}
              onNewProject={newProject}
            />
          ) : (
            <BlankPage onStart={newProject} />
          ))}
        {view === "voice" && <Voice state={state} persona={persona} refresh={refresh} goExamples={() => setView("examples")} />}
        {view === "examples" && <Examples state={state} persona={persona} refresh={refresh} />}
        {view === "history" && <History state={state} persona={persona} project={project} refresh={refresh} goVoice={() => setView("voice")} />}
        {view === "data" && (
          <DataModels
            state={state}
            persona={persona}
            project={project}
            refresh={refresh}
            onProjectDeleted={() => {
              setProjectId(null);
              setView("write");
            }}
          />
        )}
      </main>
    </>
  );
}

function BlankPage(props: { onStart: () => void }) {
  return (
    <div className="empty" style={{ padding: "18vh 0" }}>
      <div className="display">A blank page.</div>
      <p>Start a piece, or paste a draft you want checked.</p>
      <button className="btn" onClick={props.onStart}>
        Start a piece
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ onboarding */

const MODE_PRESETS = [
  { name: "Opinion essay", description: "Long-form argument for a general professional audience." },
  { name: "Business correspondence", description: "Clear, warm, never theatrical." },
  { name: "Newsletter", description: "Regular notes to readers who know me." },
  { name: "Speech", description: "Written to be heard." },
];

function Onboarding(props: { state: AppState; canCancel: boolean; onCancel: () => void; onDone: (rev: PersonaRevision, project: Project) => Promise<void> }) {
  const { fail } = useToast();
  const [name, setName] = useState("");
  const [preset, setPreset] = useState(0);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const isCustom = preset === MODE_PRESETS.length;
  const p = props.state.processor;

  return (
    <div className="masthead">
      <div className="masthead__strip">
        <span>Anika Intelligence · first issue</span>
        <span>{props.state.workspace.root}</span>
      </div>
      <div className="cover">
        <div className="cover__left">
          <div>
            <span className="label accent">An editor for one writer</span>
            <h1 style={{ marginTop: 18 }}>
              Teach it
              <br />
              how you <em>edit</em>.
            </h1>
          </div>
          <p className="lede">
            Anika keeps the decisions you make about your writing: what you cut, what you connect, what you never say. Correct a habit once, and you should not have to correct it again in the same kind of writing.
          </p>
          <div className="disclosure">
            <div>
              <span className="label">Stays on this computer</span>
              <ul>
                <li>Your drafts and every version</li>
                <li>Your rules, examples, and corrections, as plain files</li>
                <li>Exact checks, like words you never use</li>
              </ul>
            </div>
            <div>
              <span className="label">Sent only when you run a check</span>
              <ul>
                <li>The draft and the rules that apply to it</li>
                <li>A few selected excerpts from your examples</li>
                <li>To {p.provider}{p.available ? "" : " (not configured yet)"}</li>
              </ul>
            </div>
          </div>
        </div>
        <form
          className="cover__right"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const mode = isCustom ? { name: custom.trim(), description: "" } : MODE_PRESETS[preset];
              const rev = await api.createPersona({ name, modeName: mode.name, modeDescription: mode.description });
              const project = await api.createProject({ personaId: rev.persona.id, modeId: rev.modes[0].id, title: "Untitled piece" });
              await props.onDone(rev, project);
            } catch (err) {
              fail(err);
              setBusy(false);
            }
          }}
        >
          <span className="label">{props.canCancel ? "A new persona" : "Begin"}</span>
          <label className="field">
            <span>Whose voice is this?</span>
            <input className="input" style={{ fontSize: 26, fontFamily: "var(--display)" }} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name, or a publication" autoFocus />
          </label>
          <fieldset>
            <legend className="label">What are you writing first?</legend>
            {MODE_PRESETS.map((m, i) => (
              <label className="choice" key={m.name}>
                <input type="radio" name="mode" checked={preset === i} onChange={() => setPreset(i)} />
                <span>
                  {m.name}
                  <small>{m.description}</small>
                </span>
              </label>
            ))}
            <label className="choice">
              <input type="radio" name="mode" checked={isCustom} onChange={() => setPreset(MODE_PRESETS.length)} />
              <span>Something else</span>
            </label>
            {isCustom && <input className="input" required value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Board update" aria-label="Mode name" />}
          </fieldset>
          <p className="meta">
            A persona is the voice you want, not proof of who wrote something. You can add representative pieces next; one is enough to start, and nothing is learned without your approval.
          </p>
          <div className="tbtn-row">
            <button className="btn" type="submit" disabled={busy || !name.trim()}>
              {busy ? "Setting the page…" : "Open the desk"}
            </button>
            {props.canCancel && (
              <button className="tbtn" type="button" onClick={props.onCancel}>
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
