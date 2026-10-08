/**
 * Examples: import preview, provenance labels, quotation exclusion,
 * "this is very me" highlights, approval, split, and removal.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Block, Example, Highlight, PersonaRevision, Provenance, Split } from "../core/types";
import { api, type AppState } from "./api";
import { day, pad, PROVENANCE, useToast, words } from "./bits";

export function Examples(props: { state: AppState; persona: PersonaRevision; refresh: () => Promise<void> }) {
  const { state, persona, refresh } = props;
  const examples = state.examples.filter((e) => e.personaId === persona.persona.id);
  const [selected, setSelected] = useState<string | null>(examples[0]?.id ?? null);
  const [importing, setImporting] = useState(examples.length === 0);
  const current = examples.find((e) => e.id === selected) ?? null;

  return (
    <>
      <header className="section-head">
        <h1>
          <em>Examples</em> of you
        </h1>
        <p className="dek">
          Writing Anika may learn from, each labelled by where it came from. Quotations and other people's words are set aside, and nothing counts until you approve it.
        </p>
      </header>

      <div className="columns">
        <div>
          {importing ? (
            <Importer persona={persona} onCancel={examples.length ? () => setImporting(false) : undefined} onAdded={async (id) => (await refresh(), setSelected(id), setImporting(false))} />
          ) : (
            <div style={{ padding: "24px 0 8px" }}>
              <button className="btn" onClick={() => setImporting(true)}>
                Add writing
              </button>
              <span className="meta" style={{ marginLeft: 14 }}>
                Three to five representative pieces is a good start. One is enough to begin.
              </span>
            </div>
          )}

          <section className="department">
            <div className="department__head">
              <h2>Index</h2>
              <span className="label">
                {examples.filter((e) => e.status === "approved").length} approved · {examples.length} in all
              </span>
            </div>
            {!examples.length && <p className="muted italic">No examples yet.</p>}
            <ol className="index-list">
              {examples.map((e, i) => (
                <li key={e.id}>
                  <span className="mono muted">{pad(i + 1)}</span>
                  <div>
                    <button className="t" onClick={() => setSelected(e.id)} aria-current={e.id === selected}>
                      {e.title}
                    </button>
                    <div className="meta">
                      {PROVENANCE[e.provenance].label} · {persona.modes.find((m) => m.id === e.modeId)?.name ?? "Any mode"} · {words(wordsIn(e))} · {day(e.createdAt)}
                    </div>
                  </div>
                  <span className="tbtn-row">
                    {e.status === "approved" ? <span className="tag tag--solid">Approved</span> : <span className="tag tag--accent">Awaiting approval</span>}
                    {e.split !== "profile" && <span className="tag">{e.split === "heldout" ? "Held out" : "Calibration"}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside>{current ? <ExampleDetail key={current.id} example={current} persona={persona} refresh={refresh} onDeleted={() => setSelected(null)} /> : <p className="empty">Select an example to read it.</p>}</aside>
      </div>
    </>
  );
}

function wordsIn(e: Example): number {
  return e.blocks.filter((b) => !e.excludedBlockIds.includes(b.id)).reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
}

/* -------------------------------------------------------------- importer */

function Importer(props: { persona: PersonaRevision; onCancel?: () => void; onAdded: (id: string) => Promise<void> }) {
  const { persona } = props;
  const { fail } = useToast();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<null | { blocks: Block[]; sourceFormat: Example["sourceFormat"]; words: number }>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [modeId, setModeId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (input: { text?: string; base64?: string; filename?: string }) => {
    setBusy(true);
    try {
      const out = await api.previewImport(input);
      setPreview(out);
      setExcluded(new Set(out.suggestedExclusions));
      if (input.filename && !title) setTitle(input.filename.replace(/\.[^.]+$/, ""));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await load({ base64: btoa(bin), filename: file.name });
  };

  return (
    <div className="panel" style={{ margin: "24px 0" }}>
      <h3>{preview ? "Check the import" : "Add writing"}</h3>
      {!preview ? (
        <>
          <label className="field">
            <span>Paste text or Markdown</span>
            <textarea className="textarea" style={{ minHeight: 180 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a piece you wrote…" />
          </label>
          <div className="tbtn-row">
            <button className="btn btn--small" disabled={!text.trim() || busy} onClick={() => load({ text })}>
              Preview
            </button>
            <span className="meta">or</span>
            <button className="tbtn" onClick={() => fileRef.current?.click()}>
              Choose a file (.md, .txt, .docx)
            </button>
            <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.docx" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            {props.onCancel && (
              <button className="tbtn" onClick={props.onCancel}>
                Cancel
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="meta">
            {preview.blocks.length} blocks, {words(preview.words)} from {preview.sourceFormat === "docx" ? "a Word file (text only)" : preview.sourceFormat}. Tick anything that is not your own writing: quotations, other people's contributions, boilerplate.
          </p>
          <div className="reader" style={{ maxHeight: 360, overflowY: "auto", borderTop: "1px solid var(--rule)", borderBottom: "1px solid var(--rule)" }}>
            {preview.blocks.map((b) => (
              <label className="blockrow" key={b.id}>
                <input
                  type="checkbox"
                  checked={excluded.has(b.id)}
                  onChange={(e) => setExcluded((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(b.id);
                    else n.delete(b.id);
                    return n;
                  })}
                  aria-label="Exclude this block"
                />
                <span className={excluded.has(b.id) ? "excluded" : ""} style={b.kind === "heading" ? { fontFamily: "var(--display)", fontWeight: 600 } : b.kind === "quote" ? { fontStyle: "italic" } : undefined}>
                  {b.kind !== "paragraph" && <span className="label" style={{ marginRight: 8 }}>{b.kind}</span>}
                  {b.text}
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Why I stopped writing memos" />
          </label>
          <fieldset>
            <legend className="label">Where did this come from?</legend>
            {(Object.keys(PROVENANCE) as Provenance[]).map((p) => (
              <label className="choice" key={p}>
                <input type="radio" name="prov" checked={provenance === p} onChange={() => setProvenance(p)} />
                <span>
                  {PROVENANCE[p].label}
                  <small>{PROVENANCE[p].hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span>Mode</span>
            <select className="select" value={modeId} onChange={(e) => setModeId(e.target.value)}>
              <option value="">Any mode</option>
              {persona.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="tbtn-row">
            <button
              className="btn btn--small"
              disabled={!title.trim() || !provenance || busy || excluded.size === preview.blocks.length}
              onClick={async () => {
                setBusy(true);
                try {
                  const ex = await api.addExample({
                    personaId: persona.persona.id,
                    title,
                    blocks: preview.blocks,
                    provenance,
                    modeId: modeId || null,
                    excludedBlockIds: [...excluded],
                    sourceFormat: preview.sourceFormat,
                  });
                  await props.onAdded(ex.id);
                } catch (err) {
                  fail(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add for approval
            </button>
            <button className="tbtn" onClick={() => setPreview(null)}>
              Back
            </button>
            {!provenance && <span className="meta">Choose where it came from.</span>}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- detail */

function ExampleDetail(props: { example: Example; persona: PersonaRevision; refresh: () => Promise<void>; onDeleted: () => void }) {
  const { example: ex, persona, refresh } = props;
  const { fail, say } = useToast();
  const [pick, setPick] = useState<Highlight | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [retireToo, setRetireToo] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const excluded = new Set(ex.excludedBlockIds);

  const update = async (b: Partial<Example>, msg?: string) => {
    try {
      await api.updateExample(ex.id, b);
      if (msg) say(msg);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !readerRef.current) return setPick(null);
    const range = sel.getRangeAt(0);
    const startP = (range.startContainer.parentElement as HTMLElement)?.closest("[data-block-id]") as HTMLElement | null;
    const endP = (range.endContainer.parentElement as HTMLElement)?.closest("[data-block-id]") as HTMLElement | null;
    if (!startP || startP !== endP) return setPick(null);
    const pre = document.createRange();
    pre.setStart(startP, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const end = start + range.toString().length;
    setPick({ blockId: startP.dataset.blockId!, start, end });
  };

  const byBlock = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const h of ex.highlights) m.set(h.blockId, [...(m.get(h.blockId) ?? []), h].sort((a, b) => a.start - b.start));
    return m;
  }, [ex.highlights]);

  return (
    <div style={{ paddingTop: 24 }}>
      <span className="label accent">{PROVENANCE[ex.provenance].label}</span>
      <h2 className="display" style={{ fontSize: 34, margin: "6px 0 10px" }}>
        {ex.title}
      </h2>
      <div className="tbtn-row" style={{ marginBottom: 12 }}>
        {ex.status === "approved" ? (
          <>
            <span className="tag tag--solid">Approved</span>
            <button className="tbtn" onClick={() => update({ status: "pending" }, "No longer used as evidence.")}>
              Withdraw approval
            </button>
          </>
        ) : (
          <button className="btn btn--small" onClick={() => update({ status: "approved" }, ex.provenance === "inspiration" ? "Approved as inspiration. It is never used as evidence of your voice." : "Approved. Eligible for context from the next run.")}>
            Approve as representative
          </button>
        )}
      </div>

      <div className="two" style={{ marginBottom: 12 }}>
        <label className="field">
          <span>Use for</span>
          <select className="select" value={ex.split} onChange={(e) => update({ split: e.target.value as Split })}>
            <option value="profile">Profile</option>
            <option value="calibration">Calibration</option>
            <option value="heldout">Held out for testing</option>
          </select>
        </label>
        <label className="field">
          <span>Mode</span>
          <select className="select" value={ex.modeId ?? ""} onChange={(e) => update({ modeId: e.target.value || null })}>
            <option value="">Any mode</option>
            {persona.modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="meta">Select a passage to mark it as very you. Highlighted passages are stronger evidence than the whole piece.</p>
      {pick && (
        <div className="tbtn-row" style={{ margin: "6px 0" }}>
          <button className="btn btn--small" onClick={() => (update({ highlights: [...ex.highlights, pick] }, "Marked as very you."), setPick(null), window.getSelection()?.removeAllRanges())}>
            This is very me
          </button>
          <button className="tbtn" onClick={() => setPick(null)}>
            Cancel
          </button>
        </div>
      )}

      <div className="reader" ref={readerRef} onMouseUp={onMouseUp} style={{ borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
        {ex.blocks.map((b) => {
          const content = renderHighlighted(b.text, byBlock.get(b.id) ?? []);
          if (b.kind === "heading") return <h3 key={b.id} data-block-id={b.id} className="display" style={{ fontSize: 22, margin: "16px 0 8px" }}>{content}</h3>;
          if (b.kind === "quote") return <blockquote key={b.id} data-block-id={b.id} className={excluded.has(b.id) ? "excluded" : ""}>{content}</blockquote>;
          return <p key={b.id} data-block-id={b.id} className={excluded.has(b.id) ? "excluded" : ""}>{content}</p>;
        })}
      </div>
      {ex.highlights.length > 0 && (
        <div style={{ margin: "8px 0 16px" }}>
          <span className="label">{ex.highlights.length} highlighted</span>{" "}
          <button className="tbtn" onClick={() => update({ highlights: [] })}>
            Clear highlights
          </button>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--rule)", paddingTop: 12, marginTop: 16 }}>
        {!deleting ? (
          <button className="tbtn danger" onClick={() => setDeleting(true)}>
            Delete this example…
          </button>
        ) : (
          <div className="panel">
            <h3>Delete “{ex.title}”</h3>
            <p style={{ margin: 0, fontSize: 15 }}>
              It leaves future context immediately, and its text and quoted excerpts are removed from your workspace. Rules that rested only on it are retired.
            </p>
            <label className="choice">
              <input type="checkbox" checked={retireToo} onChange={(e) => setRetireToo(e.target.checked)} />
              <span>Also retire every rule that cites it</span>
            </label>
            <label className="field">
              <span>Type the title to confirm</span>
              <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <div className="tbtn-row">
              <button
                className="btn btn--small"
                disabled={confirm !== ex.title}
                onClick={async () => {
                  try {
                    const out = await api.deleteExample(ex.id, { alsoRetireDerivedRules: retireToo, confirm });
                    say(`Deleted. ${out.retiredRuleIds.length ? `${out.retiredRuleIds.length} rule(s) retired. ` : ""}${out.caveat}`);
                    props.onDeleted();
                    await refresh();
                  } catch (err) {
                    fail(err);
                  }
                }}
              >
                Delete
              </button>
              <button className="tbtn" onClick={() => setDeleting(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function renderHighlighted(text: string, hs: Highlight[]) {
  if (!hs.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  hs.forEach((h, i) => {
    if (h.start < at) return;
    out.push(text.slice(at, h.start));
    out.push(<mark key={i}>{text.slice(h.start, h.end)}</mark>);
    at = h.end;
  });
  out.push(text.slice(at));
  return out;
}
