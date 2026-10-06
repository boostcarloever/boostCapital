/**
 * Write: the central document, a persistent persona/mode context, marginalia
 * for findings, a proof sheet for comparisons, locks, autosave, and export.
 */
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blocksFromEditorJson, blocksToMarkdown, countWords } from "../core/document";
import type { Block, DraftVersion, Finding, PersonaRevision, Project, Rule, Run } from "../core/types";
import { api, ApiError, type AppState } from "./api";
import { clock, pad, STAGE_ORDER, stamp, useToast, words } from "./bits";
import { wordDiff } from "./diff";
import { BlockIdentity, blockRange, FindingMarks, findingsKey, Locks, toggleLock, type Mark } from "./editor";

type SaveState = { kind: "idle" | "dirty" | "saving" | "saved" | "error"; at?: string; message?: string };

const LABEL: Record<string, string> = {
  CREATED: "Working",
  PREFLIGHT: "Working",
  CONTEXT_READY: "Working",
  MECHANICAL_CHECK: "Working",
  VOICE_AND_MEANING_CHECKS: "Working",
  REPAIR: "Working",
  RECHECK: "Working",
  NEEDS_REVIEW: "Needs review",
  READY_FOR_REVIEW: "Ready for your review",
  CHECKS_INCOMPLETE: "Checks incomplete",
  FAILED: "Checks incomplete",
  CANCELED: "Stopped",
};

const CRITERIA: { key: keyof Run["sections"]; name: string }[] = [
  { key: "explicit_rules", name: "Explicit rules" },
  { key: "voice", name: "Voice and structure" },
  { key: "meaning", name: "Meaning preservation" },
  { key: "evidence", name: "Evidence coverage" },
];

const CRITERION_LABEL: Record<string, string> = { explicit_rules: "Explicit rule", voice: "Voice", meaning: "Meaning", evidence: "Evidence" };

export function Write(props: {
  state: AppState;
  persona: PersonaRevision;
  project: Project;
  refresh: () => Promise<void>;
  goVoice: () => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
}) {
  const { state, persona, project, refresh } = props;
  const { say, fail } = useToast();
  const mode = persona.modes.find((m) => m.id === project.modeId);

  const [, setHead] = useState<DraftVersion | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [conflict, setConflict] = useState<{ conflictVersionId: string } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [evaluated, setEvaluated] = useState<Block[] | null>(null);
  const [currentBlocks, setCurrentBlocks] = useState<Block[]>([]);
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [proof, setProof] = useState<null | { title: string; before: Block[]; after: Block[]; candidate?: DraftVersion; beforeLabel: string; afterLabel: string }>(null);
  const [correction, setCorrection] = useState<null | { blockId: string; quote: string; versionId: string }>(null);
  const [bubble, setBubble] = useState<null | { top: number; left: number }>(null);
  const [drawer, setDrawer] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [brief, setBrief] = useState(project.brief);

  const baseRef = useRef<string | null>(project.head);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<string | null> | null>(null);
  const timerRef = useRef<number | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef(project.id);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
      Placeholder.configure({ placeholder: "Begin here, or paste a draft you want to check…" }),
      BlockIdentity,
      Locks,
      FindingMarks.configure({ onSelect: (id) => selectFinding(id, false) }),
    ],
    editorProps: { attributes: { "aria-label": "Document", spellcheck: "true" } },
    onUpdate: ({ editor: ed, transaction }) => {
      if (!transaction.docChanged) return;
      dirtyRef.current = true;
      setCurrentBlocks(blocksFromEditorJson(ed.getJSON()));
      setSave({ kind: "dirty" });
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => void flush(), 1100);
    },
    onSelectionUpdate: ({ editor: ed }) => placeBubble(ed),
    onBlur: () => setTimeout(() => setBubble(null), 150),
  });

  /* ------------------------------------------------------------- saving */

  const flush = useCallback(async (): Promise<string | null> => {
    if (!editor) return baseRef.current;
    if (savingRef.current) await savingRef.current;
    if (!dirtyRef.current) return baseRef.current;
    const pid = projectRef.current;
    const json = editor.getJSON();
    dirtyRef.current = false;
    setSave({ kind: "saving" });
    const p = (async () => {
      try {
        const out = await api.saveDraft(pid, { baseVersionId: baseRef.current, editorJson: json });
        if (projectRef.current !== pid) return out.version.id;
        baseRef.current = out.version.id;
        setHead(out.version);
        setSave({ kind: "saved", at: out.version.createdAt });
        return out.version.id;
      } catch (err) {
        dirtyRef.current = true;
        if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
          setConflict(err.detail as { conflictVersionId: string });
          setSave({ kind: "error", message: "Not saved: changed elsewhere" });
        } else {
          setSave({ kind: "error", message: err instanceof Error ? err.message : "Not saved" });
          fail(err);
        }
        return null;
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = p;
    return p;
  }, [editor, fail]);

  useEffect(() => {
    const regrow = () => document.querySelectorAll<HTMLTextAreaElement>(".title-input, .standfirst").forEach(autoGrowEl);
    window.addEventListener("resize", regrow);
    return () => window.removeEventListener("resize", regrow);
  }, []);

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  /* -------------------------------------------------------- loading */

  useEffect(() => {
    if (!editor) return;
    let alive = true;
    projectRef.current = project.id;
    baseRef.current = project.head;
    dirtyRef.current = false;
    setLoaded(false);
    setRun(null);
    setEvaluated(null);
    setConflict(null);
    setCorrection(null);
    setAccepted(new Set());
    setTitle(project.title);
    setBrief(project.brief);
    (async () => {
      try {
        const v = project.head ? await api.draft(project.head) : null;
        if (!alive) return;
        setHead(v);
        editor.commands.setContent((v?.editorJson as object) ?? { type: "doc", content: [{ type: "paragraph" }] }, { emitUpdate: false });
        editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
        setCurrentBlocks(blocksFromEditorJson(editor.getJSON()));
        setSave(v ? { kind: "saved", at: v.createdAt } : { kind: "idle" });
        const runs = await api.runs(project.id);
        if (!alive) return;
        setRun(runs[0] ?? null);
        setLoaded(true);
      } catch (err) {
        fail(err);
      }
    })();
    return () => {
      alive = false;
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, project.id]);

  /* Poll an active run until it reaches a terminal state. */
  useEffect(() => {
    if (!run || run.finishedAt) return;
    const t = window.setInterval(async () => {
      try {
        const next = await api.run(run.id);
        setRun(next);
        if (next.finishedAt) {
          window.clearInterval(t);
          onRunFinished(next);
        }
      } catch {
        /* keep polling; the server may be busy */
      }
    }, 600);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.finishedAt]);

  /* Load the evaluated version's blocks to tell whether the report is current. */
  useEffect(() => {
    if (!run) return;
    let alive = true;
    api.draft(run.evaluatedVersionId).then((v) => alive && setEvaluated(v.blocks), () => alive && setEvaluated(null));
    return () => {
      alive = false;
    };
  }, [run?.evaluatedVersionId, run?.id]);

  const fresh = useMemo(() => {
    if (!run || !evaluated) return false;
    return JSON.stringify(evaluated.map((b) => [b.id, b.text])) === JSON.stringify(currentBlocks.map((b) => [b.id, b.text]));
  }, [run, evaluated, currentBlocks]);
  const contextChanged = Boolean(run?.manifest && (run.manifest.mode_id !== project.modeId || run.manifest.persona_id !== project.personaId));
  const memoryChanged = Boolean(run && run.personaRevision !== persona.id);
  const working = Boolean(run && !run.finishedAt);

  /* Findings in document order, numbered like footnotes. */
  const findings = useMemo(() => {
    if (!run) return [];
    const order = new Map((evaluated ?? currentBlocks).map((b, i) => [b.id, i]));
    return [...run.findings]
      .sort((a, b) => (order.get(a.anchor?.blockId ?? "") ?? 1e6) - (order.get(b.anchor?.blockId ?? "") ?? 1e6) || (a.anchor?.start ?? 0) - (b.anchor?.start ?? 0))
      .map((f, i) => ({ ...f, n: i + 1 }));
  }, [run, evaluated, currentBlocks]);

  /* Draw marks only for a report that describes the text in the editor. */
  useEffect(() => {
    if (!editor || !loaded) return;
    const showable = run && run.task === "review" && fresh && !contextChanged;
    const marks: Mark[] = showable
      ? findings
          .filter((f) => f.anchor && f.resolution === "open" && !accepted.has(f.id))
          .filter((f) => {
            const r = blockRange(editor.state.doc, f.anchor!.blockId, f.anchor!.start, f.anchor!.end);
            return r && r.text === f.anchor!.quote;
          })
          .map((f) => ({ id: f.id, n: f.n, blockId: f.anchor!.blockId, start: f.anchor!.start, end: f.anchor!.end, criterion: f.criterion }))
      : [];
    editor.view.dispatch(editor.state.tr.setMeta(findingsKey, { marks, active: activeFinding }).setMeta("addToHistory", false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, loaded, run?.id, run?.finishedAt, run?.findings, fresh, contextChanged, accepted]);

  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(findingsKey, { active: activeFinding }).setMeta("addToHistory", false));
  }, [editor, activeFinding]);

  function selectFinding(id: string, scroll: boolean) {
    setActiveFinding(id);
    setDrawer(true);
    if (scroll) {
      const el = document.querySelector(`.ProseMirror [data-finding="${id}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      document.getElementById(`note-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  async function onRunFinished(r: Run) {
    if (r.task === "revise" && r.candidateVersionIds.length) {
      try {
        const candidate = await api.draft(r.candidateVersionIds[r.candidateVersionIds.length - 1]);
        const base = await api.draft(r.baseVersionId);
        setProof({ title: "Proposed revision", before: base.blocks, after: candidate.blocks, candidate, beforeLabel: "Your text", afterLabel: `Candidate · ${LABEL[r.state]}` });
      } catch (err) {
        fail(err);
      }
    } else if (r.task === "revise") {
      say(r.state === "CHECKS_INCOMPLETE" ? "Revision unavailable. Your text is unchanged." : "No patch could be applied safely. The findings need your judgement.");
    }
    void refresh();
  }

  /* ------------------------------------------------------------- actions */

  async function check(task: "review" | "revise") {
    const versionId = await flush();
    if (!versionId) {
      say(currentBlocks.length ? "Save the draft before checking." : "There is nothing to check yet.", "error");
      return;
    }
    try {
      const r = await api.startRun(project.id, { task, versionId });
      setRun(r);
      setAccepted(new Set());
      setActiveFinding(null);
      setDrawer(true);
      if (r.state === "FAILED") onRunFinished(r);
    } catch (err) {
      fail(err);
    }
  }

  async function stop() {
    if (!run) return;
    try {
      const out = await api.cancelRun(run.id);
      say(out.note);
    } catch (err) {
      fail(err);
    }
  }

  function applyToEditor(f: Finding, replacement: string) {
    if (!editor || !f.anchor) return;
    const r = blockRange(editor.state.doc, f.anchor.blockId, f.anchor.start, f.anchor.end);
    if (!r || r.text !== f.anchor.quote) {
      say("The text changed since this note was made. Check again to get a fresh suggestion.", "error");
      return;
    }
    const tr = editor.state.tr.insertText(replacement, r.from, r.to);
    if (tr.docChanged) {
      editor.view.dispatch(tr);
      if (editor.state.doc.eq(tr.before)) {
        say("That passage is locked. Unlock it to change it.", "error");
        return;
      }
    }
    setAccepted((s) => new Set(s).add(f.id));
  }

  async function dismiss(f: Finding) {
    if (!run) return;
    try {
      const out = await api.findingFeedback({ runId: run.id, findingId: f.id, action: "dismiss_for_draft" });
      setRun(out.run);
    } catch (err) {
      fail(err);
    }
  }

  async function dispute(f: Finding, choice: "keep_local" | "add_exception" | "change_rule", note: string, newStatement?: string) {
    if (!run) return;
    try {
      const out = await api.findingFeedback({ runId: run.id, findingId: f.id, action: "not_an_issue", choice, note, newStatement });
      setRun(out.run);
      say(out.proposal ? "Recorded. The rule change is awaiting your approval in Your voice." : "Recorded as feedback about the critic. Your voice memory is unchanged.");
      void refresh();
    } catch (err) {
      fail(err);
    }
  }

  function placeBubble(ed: Editor) {
    const { from, to, empty } = ed.state.selection;
    if (empty || !pageRef.current) {
      setBubble(null);
      return;
    }
    const start = ed.view.coordsAtPos(from);
    const end = ed.view.coordsAtPos(to);
    const box = pageRef.current.getBoundingClientRect();
    setBubble({ top: Math.min(start.top, end.top) - box.top - 44, left: Math.max(0, (start.left + end.left) / 2 - box.left - 110) });
  }

  async function openCorrection() {
    if (!editor) return;
    const { from, to, $from } = editor.state.selection;
    const quote = editor.state.doc.textBetween(from, to, "\n");
    let blockId: string | null = null;
    for (let d = $from.depth; d > 0; d--) {
      const id = $from.node(d).attrs.blockId as string | undefined;
      if (id) {
        blockId = id;
        break;
      }
    }
    const versionId = await flush();
    if (!blockId || !versionId) return;
    setCorrection({ blockId, quote, versionId });
    setBubble(null);
    setDrawer(true);
  }

  function lock() {
    if (!editor) return;
    toggleLock(editor.state, (tr) => editor.view.dispatch(tr));
    editor.commands.focus();
  }

  async function saveMeta(fields: { title?: string; brief?: string }) {
    if ((fields.title ?? project.title) === project.title && (fields.brief ?? project.brief) === project.brief) return;
    try {
      await api.updateProject(project.id, fields);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  const unresolved = findings.filter((f) => f.resolution === "open" && !accepted.has(f.id));
  const ready = run?.state === "READY_FOR_REVIEW" && fresh && !contextChanged;

  function exportMarkdown() {
    const md = `# ${title}\n\n${brief ? `_${brief}_\n\n` : ""}${blocksToMarkdown(currentBlocks)}`;
    if (!ready) {
      const ok = window.confirm(
        run ? "This text has unresolved or out-of-date checks. Export it anyway, marked as a draft with warnings?" : "This text has not been checked. Export it as a draft with warnings?",
      );
      if (!ok) return;
    }
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "draft"}${ready ? "" : "-with-warnings"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(blocksToMarkdown(currentBlocks));
      say("Copied the current visible text.");
    } catch {
      say("The browser blocked clipboard access.", "error");
    }
  }

  async function compareWithPrevious() {
    try {
      const list = await api.drafts(project.id);
      const prev = list.find((d) => d.id !== baseRef.current && d.origin !== "conflict");
      if (!prev) {
        say("There is no earlier version to compare yet.");
        return;
      }
      setProof({ title: "Compare", before: prev.blocks, after: currentBlocks, beforeLabel: `Version of ${stamp(prev.createdAt)}`, afterLabel: "Current text" });
    } catch (err) {
      fail(err);
    }
  }

  async function acceptCandidate(candidate: DraftVersion) {
    if (!editor) return;
    editor.commands.setContent(candidate.editorJson as object, { emitUpdate: false });
    setCurrentBlocks(candidate.blocks);
    dirtyRef.current = true;
    await flush();
    setProof(null);
    say("Revision applied as a new version. Undo is in History.");
  }

  async function reloadLatest() {
    await refresh();
    const latest = await api.drafts(project.id);
    const current = latest.find((d) => d.origin !== "conflict");
    if (!editor || !current) return;
    const v = await api.draft(current.id);
    baseRef.current = v.id;
    dirtyRef.current = false;
    editor.commands.setContent(v.editorJson as object, { emitUpdate: false });
    setCurrentBlocks(v.blocks);
    setHead(v);
    setConflict(null);
    setSave({ kind: "saved", at: v.createdAt });
  }

  const wordCount = currentBlocks.filter((b) => b.kind === "paragraph" || b.kind === "heading").reduce((n, b) => n + countWords(b.text), 0);
  const processorOk = state.processor.available;
  const pendingCount = state.proposals.filter((p) => p.status === "pending" && p.personaId === persona.id).length;

  return (
    <div className="desk">
      <ProjectsRail state={state} project={project} onSelectProject={props.onSelectProject} onNewProject={props.onNewProject} />

      <article className="page" ref={pageRef} style={{ position: "relative" }}>
        <div className="page__inner">
          <div className="kicker">
            <span className="label accent">{mode?.name ?? "Mode"}</span>
            <span className="sep">/</span>
            <span className="label">{persona.persona.name}</span>
            <span className="sep">/</span>
            <span className="label">Persona {persona.id.replace("rev_", "v")}</span>
          </div>
          <textarea
            className="title-input"
            rows={1}
            value={title}
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && saveMeta({ title: title.trim() })}
            onInput={autoGrow}
            ref={(el) => {
              if (el) autoGrowEl(el);
            }}
          />
          <textarea
            className="standfirst"
            rows={1}
            value={brief}
            placeholder="The brief: who it is for, what it argues, what must stay true."
            aria-label="Brief"
            onChange={(e) => setBrief(e.target.value)}
            onBlur={() => saveMeta({ brief })}
            onInput={autoGrow}
            ref={(el) => {
              if (el) autoGrowEl(el);
            }}
          />
          <div className="byline">
            <span className="meta">
              {words(wordCount)} · {Math.max(1, Math.round(wordCount / 230))} min read
            </span>
            <span className="saved" data-state={save.kind} aria-live="polite">
              {save.kind === "saved" && `Saved locally · ${clock(save.at)}`}
              {save.kind === "saving" && "Saving…"}
              {save.kind === "dirty" && "Unsaved changes"}
              {save.kind === "idle" && "Nothing written yet"}
              {save.kind === "error" && (save.message ?? "Not saved")}
            </span>
          </div>

          {conflict && (
            <div className="notice error" role="alert">
              <span className="label">Conflict</span>
              <p>
                This draft changed elsewhere, so your edit was not written over it. Your text is kept as a separate version in History.{" "}
                <button className="tbtn" onClick={reloadLatest}>
                  Load latest version
                </button>
              </p>
            </div>
          )}

          <div className="toolbar" role="toolbar" aria-label="Draft actions">
            <button className="btn btn--small" onClick={() => check("review")} disabled={working}>
              Check my draft
            </button>
            <button
              className="tbtn"
              onClick={() => check("revise")}
              disabled={working || !processorOk}
              title={processorOk ? "Propose limited patches for flagged passages, then check again" : "Needs a model processor"}
            >
              Revise flagged passages
            </button>
            <button className="tbtn" onClick={lock} title="Lock or unlock the paragraph at the cursor (locked text is never changed)">
              Lock paragraph
            </button>
            <button className="tbtn" onClick={() => editor?.chain().focus().undo().run()} disabled={!editor?.can().undo()}>
              Undo
            </button>
            <button className="tbtn" onClick={compareWithPrevious}>
              Compare
            </button>
            <span className="grow" />
            <button className="tbtn" onClick={copyText}>
              Copy
            </button>
            <button className="tbtn" onClick={exportMarkdown}>
              {ready ? "Export" : "Export with warnings"}
            </button>
          </div>

          <div className="prose">
            <EditorContent editor={editor} />
          </div>
        </div>

        {bubble && (
          <div className="bubble" style={{ top: bubble.top, left: bubble.left }} onMouseDown={(e) => e.preventDefault()}>
            <button onClick={openCorrection}>Note to Anika</button>
            <button onClick={lock}>Lock</button>
          </div>
        )}
      </article>

      <aside className="margin" data-open={drawer} aria-label="Review notes">
        <div className="margin__head">
          <span className="label">Marginalia</span>
          <span className="meta">
            {unresolved.length} open{" "}
            <button className="tbtn drawer-close" onClick={() => setDrawer(false)} style={{ marginLeft: 8 }}>
              Close
            </button>
          </span>
        </div>

        {correction && (
          <CorrectionPanel
            quote={correction.quote}
            modeName={mode?.name ?? "this mode"}
            policy={persona.persona.learningPolicy}
            onCancel={() => setCorrection(null)}
            onSubmit={async (feedback, scope, after) => {
              try {
                const out = await api.feedback({ projectId: project.id, draftVersionId: correction.versionId, blockId: correction.blockId, before: correction.quote, after, feedback, scope });
                say(out.note);
                setCorrection(null);
                await refresh();
              } catch (err) {
                fail(err);
              }
            }}
          />
        )}

        <Verdict
          run={run}
          working={working}
          fresh={fresh}
          contextChanged={contextChanged}
          memoryChanged={memoryChanged}
          persona={persona}
          processorOk={processorOk}
          onStop={stop}
          onCheck={() => check("review")}
        />

        {run && run.finishedAt && (
          <>
            <div className="checks" aria-label="The four checks">
              {CRITERIA.map((c) => (
                <div className="checks__row" key={c.key}>
                  <span className="name">{c.name}</span>
                  <span className="leader" aria-hidden />
                  <span className="st" data-s={run.sections[c.key].status}>
                    {sectionWord(run.sections[c.key].status)}
                  </span>
                  {run.sections[c.key].note && <span className="checks__note">{run.sections[c.key].note}</span>}
                </div>
              ))}
            </div>
            {run.dimensions.length > 0 && (
              <details>
                <summary className="label" style={{ cursor: "pointer", padding: "6px 0" }}>
                  Voice dimensions
                </summary>
                <ul className="stages">
                  {run.dimensions.map((d) => (
                    <li key={d.dimension}>
                      {d.dimension.replace(/_/g, " ")}: {d.result.replace(/_/g, " ")}
                      {d.reason ? ` — ${d.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {run?.task === "review" && fresh && !contextChanged && findings.length > 0 && (
          <ol className="notes" aria-label="Findings">
            {findings.map((f) => (
              <NoteItem
                key={f.id}
                f={f}
                rules={persona.rules}
                active={activeFinding === f.id}
                resolved={f.resolution !== "open" || accepted.has(f.id)}
                onFocus={() => selectFinding(f.id, true)}
                onAccept={(text) => applyToEditor(f, text)}
                onDismiss={() => dismiss(f)}
                onDispute={(choice, note, statement) => dispute(f, choice, note, statement)}
              />
            ))}
          </ol>
        )}

        {run?.finishedAt && (
          <div className="receipt">
            Receipt · {run.id}
            <br />
            Checked against persona {run.personaRevision} · {run.manifest ? `${run.manifest.active_rule_ids.length} rules, ${run.manifest.example_ids.length} examples, ${run.manifest.decision_ids.length} decisions` : "no context"}
            <br />
            {run.manifest && <>Context {run.manifest.context_hash.slice(0, 23)}…<br /></>}
            Requests {run.usage.requests} · tokens {run.usage.inputTokens ?? "unknown"} in / {run.usage.outputTokens ?? "unknown"} out
            {run.usage.models.length ? ` · ${run.usage.models.join(", ")}` : ""}
          </div>
        )}

        <RulesInForce project={project} persona={persona} refresh={refresh} />

        {pendingCount > 0 && (
          <p className="meta" style={{ marginTop: 16 }}>
            {pendingCount} memory change{pendingCount === 1 ? "" : "s"} awaiting approval.{" "}
            <button className="tbtn" onClick={props.goVoice}>
              Review in Your voice
            </button>
          </p>
        )}
      </aside>

      <button className="btn drawer-toggle" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer}>
        Notes {unresolved.length ? `(${unresolved.length})` : ""}
      </button>

      {proof && (
        <ProofSheet
          {...proof}
          onClose={() => setProof(null)}
          onAccept={proof.candidate ? () => acceptCandidate(proof.candidate!) : undefined}
          runState={proof.candidate && run ? LABEL[run.state] : undefined}
          meaningFindings={proof.candidate && run ? run.findings.filter((f) => f.criterion === "meaning") : []}
        />
      )}
    </div>
  );
}

function sectionWord(s: string): string {
  return { complete: "Complete", unavailable: "Unavailable", not_applicable: "Not applicable", not_run: "Not run" }[s] ?? s;
}

function autoGrow(e: React.FormEvent<HTMLTextAreaElement>) {
  autoGrowEl(e.currentTarget);
}
function autoGrowEl(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/* ------------------------------------------------------------------ rail */

function ProjectsRail(props: { state: AppState; project: Project; onSelectProject: (id: string) => void; onNewProject: () => void }) {
  const { state, project } = props;
  return (
    <nav className="rail" aria-label="Pieces">
      <div className="rail__head">
        <span className="label">Contents</span>
        <button className="tbtn" onClick={props.onNewProject}>
          + New
        </button>
      </div>
      <ol className="toc">
        {state.projects.map((p, i) => {
          const persona = state.personas.find((x) => x.head.persona.id === p.personaId)?.head;
          const m = persona?.modes.find((x) => x.id === p.modeId);
          return (
            <li key={p.id}>
              <button aria-current={p.id === project.id} onClick={() => props.onSelectProject(p.id)}>
                <span className="folio">{pad(i + 1)}</span>
                <span className="t">{p.title}</span>
                <span className="m">{m?.name ?? ""}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* --------------------------------------------------------------- verdict */

function Verdict(props: {
  run: Run | null;
  working: boolean;
  fresh: boolean;
  contextChanged: boolean;
  memoryChanged: boolean;
  persona: PersonaRevision;
  processorOk: boolean;
  onStop: () => void;
  onCheck: () => void;
}) {
  const { run, working } = props;
  if (!run) {
    return (
      <div className="verdict">
        <span className="label">Status</span>
        <div className="verdict__state">Not checked yet</div>
        <p>
          A check runs your explicit rules locally, then {props.processorOk ? "asks the voice and meaning reviewers for evidence-backed notes" : "would ask the voice and meaning reviewers, which are unavailable until a model processor is configured"}.
        </p>
      </div>
    );
  }
  const reached = new Set(run.history.map((h) => h.state));
  const tone = run.state === "READY_FOR_REVIEW" ? "ok" : "warn";
  const last = run.history[run.history.length - 1];
  return (
    <div className="verdict" aria-live="polite">
      <span className="label">{run.task === "revise" ? "Revision" : "Check"} · {clock(run.startedAt)}</span>
      <div className="verdict__state" data-tone={working ? undefined : tone}>
        {LABEL[run.state]}
        {working ? "…" : ""}
      </div>
      {working && (
        <>
          <ul className="stages">
            {STAGE_ORDER.filter((s) => run.task === "revise" || (s.state !== "REPAIR" && s.state !== "RECHECK")).map((s) => (
              <li key={s.state} data-done={reached.has(s.state) && run.state !== s.state} data-now={run.state === s.state}>
                {reached.has(s.state) ? (run.state === s.state ? "→" : "✓") : "·"} {s.label}
              </li>
            ))}
          </ul>
          <button className="tbtn danger" style={{ marginTop: 10 }} onClick={props.onStop}>
            Stop
          </button>
        </>
      )}
      {!working && last?.note && <p>{last.note}</p>}
      {!working && run.error && <p>{run.error.message}</p>}
      {!working && !props.fresh && run.task === "review" && (
        <p>
          <strong>The text has changed since this check.</strong> Its notes describe an earlier version.{" "}
          <button className="tbtn" onClick={props.onCheck}>
            Check again
          </button>
        </p>
      )}
      {!working && props.contextChanged && (
        <p>
          <strong>This report was made for a different persona or mode.</strong> It no longer applies.{" "}
          <button className="tbtn" onClick={props.onCheck}>
            Check again
          </button>
        </p>
      )}
      {!working && props.memoryChanged && !props.contextChanged && (
        <p>
          Checked against persona {run.personaRevision}; your memory is now {props.persona.id}.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ note item */

function NoteItem(props: {
  f: Finding & { n: number };
  rules: Rule[];
  active: boolean;
  resolved: boolean;
  onFocus: () => void;
  onAccept: (text: string) => void;
  onDismiss: () => void;
  onDispute: (choice: "keep_local" | "add_exception" | "change_rule", note: string, statement?: string) => void;
}) {
  const { f } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [choice, setChoice] = useState<"keep_local" | "add_exception" | "change_rule">("keep_local");
  const [note, setNote] = useState("");
  const [statement, setStatement] = useState("");
  const rule = props.rules.find((r) => r.id === f.ruleIds[0]);

  return (
    <li className="note" id={`note-${f.id}`} data-active={props.active} data-resolved={props.resolved}>
      <button className="note__n" onClick={props.onFocus} aria-label={`Show note ${f.n} in the text`}>
        {f.n}
      </button>
      <div className="note__body">
        <span className="label">
          {CRITERION_LABEL[f.criterion]}
          {f.dimension && !["explicit", "general"].includes(f.dimension) ? ` · ${f.dimension.replace(/_/g, " ")}` : ""}
          {f.severity === "blocker" ? " · blocking" : ""}
          {props.resolved ? ` · ${resolutionText(f.resolution)}` : ""}
        </span>
        {f.anchor && f.anchor.quote.length < 400 && <span className="note__quote">“{f.anchor.quote}”</span>}
        <p>{f.explanation}</p>
        {f.replacement !== undefined && f.replacement !== null && !props.resolved && (
          <p className="note__try">
            Try: <ins>{f.replacement || "(remove)"}</ins>
          </p>
        )}
        {!f.replacement && f.proposedAction && <p className="note__try muted">{f.proposedAction}</p>}
        {rule && <span className="note__rule">{rule.statement}</span>}
        {f.evidenceIds.some((id) => !id.startsWith("stmt_")) && (
          <span className="meta">Evidence: {f.evidenceIds.filter((id) => !id.startsWith("stmt_")).join(", ")}</span>
        )}

        {editing !== null && (
          <div className="grid-form">
            <textarea className="textarea" value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Your wording" />
            <div className="tbtn-row">
              <button className="btn btn--small" onClick={() => (props.onAccept(editing), setEditing(null))}>
                Apply
              </button>
              <button className="tbtn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {disputing && (
          <div className="panel" style={{ margin: "6px 0" }}>
            <p className="ink2" style={{ fontSize: 14 }}>
              This is feedback about Anika's critic. It will not approve the whole draft as an example, and it changes memory only if you approve a rule change.
            </p>
            <fieldset>
              <legend className="label">What should happen</legend>
              <label className="choice">
                <input type="radio" checked={choice === "keep_local"} onChange={() => setChoice("keep_local")} />
                <span>
                  It is deliberate here; keep the disagreement local
                  <small>The rule stays as it is.</small>
                </span>
              </label>
              {rule && (
                <label className="choice">
                  <input type="radio" checked={choice === "add_exception"} onChange={() => setChoice("add_exception")} />
                  <span>
                    Keep the rule, but add an exception
                    <small>Proposed as a memory change for your approval.</small>
                  </span>
                </label>
              )}
              {rule && (
                <label className="choice">
                  <input type="radio" checked={choice === "change_rule"} onChange={() => setChoice("change_rule")} />
                  <span>
                    The rule itself is wrong; reword it
                    <small>Proposed as a memory change for your approval.</small>
                  </span>
                </label>
              )}
            </fieldset>
            {choice === "change_rule" ? (
              <label className="field">
                <span>New wording</span>
                <textarea className="textarea" value={statement} onChange={(e) => setStatement(e.target.value)} placeholder={rule?.statement} />
              </label>
            ) : (
              <label className="field">
                <span>{choice === "add_exception" ? "The exception" : "Why (optional)"}</span>
                <textarea
                  className="textarea"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={choice === "add_exception" ? "A short standalone paragraph may provide deliberate emphasis." : "Deliberate emphasis."}
                />
              </label>
            )}
            <div className="tbtn-row">
              <button
                className="btn btn--small"
                onClick={() => {
                  props.onDispute(choice, note, statement);
                  setDisputing(false);
                }}
                disabled={(choice === "add_exception" && !note.trim()) || (choice === "change_rule" && !statement.trim())}
              >
                Record
              </button>
              <button className="tbtn" onClick={() => setDisputing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {!props.resolved && editing === null && !disputing && (
          <div className="tbtn-row">
            {f.replacement !== undefined && f.replacement !== null && f.anchor && (
              <button className="tbtn" onClick={() => props.onAccept(f.replacement!)}>
                Accept
              </button>
            )}
            {f.anchor && f.criterion !== "meaning" && (
              <button className="tbtn" onClick={() => setEditing(f.replacement ?? f.anchor!.quote)}>
                Edit
              </button>
            )}
            <button className="tbtn" onClick={props.onDismiss}>
              Dismiss for this draft
            </button>
            {f.criterion !== "meaning" && (
              <button className="tbtn" onClick={() => setDisputing(true)}>
                Not an issue
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function resolutionText(r: string): string {
  return { accepted: "accepted", dismissed_for_draft: "dismissed for this draft", evaluator_disputed: "you disagreed", exception_added: "exception added", open: "applied" }[r] ?? r;
}

/* ------------------------------------------------------------ correction */

function CorrectionPanel(props: {
  quote: string;
  modeName: string;
  policy: string;
  onCancel: () => void;
  onSubmit: (feedback: string, scope: "task" | "mode" | "core", after: string | null) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState("");
  const [scope, setScope] = useState<"task" | "mode" | "core">("mode");
  const [after, setAfter] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await props.onSubmit(feedback, scope, after.trim() || null);
        setBusy(false);
      }}
    >
      <h3>Note to Anika</h3>
      <span className="note__quote">“{props.quote.length > 280 ? props.quote.slice(0, 277) + "…" : props.quote}”</span>
      <label className="field">
        <span>What is wrong with it?</span>
        <textarea className="textarea" required autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Too many disconnected one-line paragraphs. Develop the argument." />
      </label>
      <label className="field">
        <span>Your rewrite (optional)</span>
        <textarea className="textarea" value={after} onChange={(e) => setAfter(e.target.value)} />
      </label>
      <fieldset>
        <legend className="label">Remember this for</legend>
        <label className="choice">
          <input type="radio" checked={scope === "task"} onChange={() => setScope("task")} />
          <span>
            Just this piece
            <small>Never becomes voice memory.</small>
          </span>
        </label>
        <label className="choice">
          <input type="radio" checked={scope === "mode"} onChange={() => setScope("mode")} />
          <span>
            Every {props.modeName}
            <small>{props.policy === "remember_explicit" ? "Remembered now with undo, if it reads as a clear style instruction." : "Proposed for your approval."}</small>
          </span>
        </label>
        <label className="choice">
          <input type="radio" checked={scope === "core"} onChange={() => setScope("core")} />
          <span>
            Everything I write
            <small>Always needs your explicit approval.</small>
          </span>
        </label>
      </fieldset>
      <div className="tbtn-row">
        <button className="btn btn--small" type="submit" disabled={!feedback.trim() || busy}>
          {busy ? "Recording…" : "Record"}
        </button>
        <button className="tbtn" type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------- rules in force */

function RulesInForce(props: { project: Project; persona: PersonaRevision; refresh: () => Promise<void> }) {
  const { project, persona } = props;
  const { fail, say } = useToast();
  const applicable = persona.rules.filter((r) => r.status === "active" && (r.scope.kind === "core" || r.scope.modeIds.includes(project.modeId)));
  const excepted = new Map(project.exceptions.map((e) => [e.ruleId, e]));
  return (
    <details style={{ marginTop: 18, borderTop: "1px solid var(--rule)" }}>
      <summary className="label" style={{ cursor: "pointer", padding: "10px 0" }}>
        Rules in force · {applicable.length - project.exceptions.length}
      </summary>
      {!applicable.length && <p className="meta">No rules yet for this mode. Correct a passage, or write rules in Your voice.</p>}
      <ul className="ledger">
        {applicable.map((r) => {
          const exc = excepted.get(r.id);
          return (
            <li key={r.id} style={{ gridTemplateColumns: "1fr" }}>
              <span className="what" style={exc ? { textDecoration: "line-through", color: "var(--ink-3)" } : undefined}>
                {r.statement}
              </span>
              <span className="tbtn-row">
                <span className="meta">{r.strength === "hard" ? "Always enforced" : "Preference"}</span>
                {exc ? (
                  <button
                    className="tbtn"
                    onClick={async () => {
                      try {
                        await api.removeException(project.id, exc.id);
                        await props.refresh();
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  >
                    Restore for this piece
                  </button>
                ) : (
                  <button
                    className="tbtn"
                    onClick={async () => {
                      const hard = r.strength === "hard";
                      if (hard && !window.confirm("This rule is marked “always enforce”. Suspend it for this piece only?")) return;
                      try {
                        await api.addException(project.id, { ruleId: r.id, note: "Suspended for this piece", approvedByWriter: hard });
                        say("Suspended for this piece only. It expires with this task.");
                        await props.refresh();
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  >
                    Suspend for this piece
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/* ----------------------------------------------------------------- proof */

export function ProofSheet(props: {
  title: string;
  before: Block[];
  after: Block[];
  beforeLabel: string;
  afterLabel: string;
  runState?: string;
  meaningFindings: Finding[];
  onClose: () => void;
  onAccept?: () => void;
}) {
  const afterById = new Map(props.after.map((b) => [b.id, b]));
  const beforeIds = new Set(props.before.map((b) => b.id));
  const rows: { id: string; a: string | null; b: string | null }[] = props.before.map((b) => ({ id: b.id, a: b.text, b: afterById.get(b.id)?.text ?? null }));
  for (const b of props.after) if (!beforeIds.has(b.id)) rows.push({ id: b.id, a: null, b: b.text });
  const changed = rows.filter((r) => r.a !== r.b).length;
  const blocking = props.meaningFindings.filter((f) => f.severity === "blocker");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sheet">
        <div className="sheet__head">
          <div>
            <span className="label accent">Proof</span>
            <h2>{props.title}</h2>
          </div>
          <div className="tbtn-row">
            <span className="meta">
              {changed} paragraph{changed === 1 ? "" : "s"} changed{props.runState ? ` · ${props.runState}` : ""}
            </span>
            {props.onAccept && (
              <button className="btn btn--small" onClick={props.onAccept}>
                Accept revision
              </button>
            )}
            <button className="btn btn--ghost btn--small" onClick={props.onClose} autoFocus>
              {props.onAccept ? "Discard" : "Close"}
            </button>
          </div>
        </div>
        {blocking.length > 0 && (
          <div className="notice error" role="alert">
            <span className="label">Meaning may have changed</span>
            <p>{blocking.map((f) => f.explanation).join(" ")}</p>
          </div>
        )}
        <p className="meta" style={{ margin: "10px 0 0" }}>
          Struck through: removed. Underlined: added. Grey: unchanged.
        </p>
        <div className="proof">
          <div>
            <span className="label">{props.beforeLabel}</span>
            {rows.map((r) =>
              r.a === null ? null : r.a === r.b ? (
                <p key={r.id} className="unchanged">
                  {r.a}
                </p>
              ) : (
                <p key={r.id}>
                  {r.b === null ? <del>{r.a}</del> : wordDiff(r.a, r.b).filter((piece) => piece.kind !== "ins").map((piece, i) => (piece.kind === "same" ? <span key={i}>{piece.text}</span> : <del key={i}>{piece.text}</del>))}
                </p>
              ),
            )}
          </div>
          <div>
            <span className="label">{props.afterLabel}</span>
            {rows.map((r) =>
              r.b === null ? (
                <p key={r.id}>
                  <del>(paragraph removed)</del>
                </p>
              ) : r.a === r.b ? (
                <p key={r.id} className="unchanged">
                  {r.b}
                </p>
              ) : (
                <p key={r.id}>
                  {wordDiff(r.a ?? "", r.b)
                    .filter((piece) => piece.kind !== "del")
                    .map((piece, i) => (piece.kind === "same" ? <span key={i}>{piece.text}</span> : <ins key={i}>{piece.text}</ins>))}
                </p>
              ),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

