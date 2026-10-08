/**
 * Tiptap extensions for Anika's writing desk:
 *  - BlockIdentity: every block carries a stable id (never copied on split).
 *  - Locks: locked blocks reject any edit that touches them (byte-identical text).
 *  - FindingMarks: review findings drawn as decorations with printed numbers.
 */
import { Extension } from "@tiptap/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Criterion } from "../core/types";

const BLOCK_TYPES = ["paragraph", "heading", "codeBlock"];
export const LOCK_META = "anikaLockToggle";

export function makeBlockId(): string {
  return `blk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export const BlockIdentity = Extension.create({
  name: "anikaBlockIdentity",
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute("data-block-id"),
            renderHTML: (attrs) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
          },
          locked: {
            default: false,
            keepOnSplit: false,
            parseHTML: (el) => el.hasAttribute("data-locked"),
            renderHTML: (attrs) => (attrs.locked ? { "data-locked": "" } : {}),
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("anikaBlockIds"),
        appendTransaction: (_trs, _old, state) => {
          const seen = new Set<string>();
          let tr: Transaction | null = null;
          state.doc.descendants((node, pos) => {
            if (!BLOCK_TYPES.includes(node.type.name)) return;
            const id = node.attrs.blockId as string | null;
            if (!id || seen.has(id)) {
              tr = tr ?? state.tr;
              tr.setNodeAttribute(pos, "blockId", makeBlockId());
              if (id && node.attrs.locked) tr.setNodeAttribute(pos, "locked", false);
            } else seen.add(id);
          });
          if (tr) (tr as Transaction).setMeta("addToHistory", false).setMeta(LOCK_META, true);
          return tr;
        },
      }),
    ];
  },
});

function lockedRanges(doc: PmNode): [number, number][] {
  const out: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (node.attrs?.locked) out.push([pos, pos + node.nodeSize]);
  });
  return out;
}

export const Locks = Extension.create({
  name: "anikaLocks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("anikaLocks"),
        filterTransaction: (tr, state) => {
          if (!tr.docChanged || tr.getMeta(LOCK_META)) return true;
          let ranges = lockedRanges(state.doc);
          if (!ranges.length) return true;
          for (const step of tr.steps) {
            const map = step.getMap();
            let blocked = false;
            map.forEach((oldStart, oldEnd) => {
              if (ranges.some(([f, t]) => oldStart < t && oldEnd > f)) blocked = true;
            });
            if (blocked) return false;
            ranges = ranges.map(([f, t]) => [map.map(f, 1), map.map(t, -1)]);
          }
          return true;
        },
      }),
    ];
  },
});

/** Toggle the lock on the block containing the selection. */
export function toggleLock(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (BLOCK_TYPES.includes(node.type.name)) {
      const pos = $from.before(d);
      dispatch(state.tr.setNodeAttribute(pos, "locked", !node.attrs.locked).setMeta(LOCK_META, true));
      return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------- findings */

export interface Mark {
  id: string;
  n: number;
  blockId: string;
  start: number;
  end: number;
  criterion: Criterion;
}

export const findingsKey = new PluginKey<{ marks: Mark[]; active: string | null; set: DecorationSet }>("anikaFindings");

/** Document position of a UTF-16 offset inside the block with `blockId`. */
export function blockRange(doc: PmNode, blockId: string, start: number, end: number): { from: number; to: number; text: string } | null {
  let found: { from: number; to: number; text: string } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.blockId === blockId) {
      const text = blockText(node);
      if (end > text.length) return false;
      found = { from: pos + 1 + start, to: pos + 1 + end, text: text.slice(start, end) };
      return false;
    }
    return undefined;
  });
  return found;
}

/** Exact block text, with hard breaks as "\n" (matches the server's analysis text). */
export function blockText(node: PmNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
    else out += child.textContent;
  });
  return out;
}

function build(doc: PmNode, marks: Mark[], active: string | null): DecorationSet {
  const decos: Decoration[] = [];
  for (const m of marks) {
    const r = blockRange(doc, m.blockId, m.start, m.end);
    if (!r || r.from >= r.to) continue;
    decos.push(
      Decoration.inline(r.from, r.to, {
        class: `fx fx--${m.criterion}${m.id === active ? " is-active" : ""}`,
        "data-finding": m.id,
      }),
    );
    decos.push(
      Decoration.widget(
        r.to,
        () => {
          const sup = document.createElement("sup");
          sup.className = "fx-n";
          sup.textContent = String(m.n);
          sup.dataset.finding = m.id;
          sup.setAttribute("aria-label", `Note ${m.n}`);
          return sup;
        },
        { side: 1, key: `n-${m.id}-${m.n}` },
      ),
    );
  }
  return DecorationSet.create(doc, decos);
}

export const FindingMarks = Extension.create<{ onSelect: (id: string) => void }>({
  name: "anikaFindings",
  addOptions() {
    return { onSelect: () => {} };
  },
  addProseMirrorPlugins() {
    const onSelect = this.options.onSelect;
    return [
      new Plugin({
        key: findingsKey,
        state: {
          init: (): { marks: Mark[]; active: string | null; set: DecorationSet } => ({ marks: [], active: null, set: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(findingsKey) as { marks?: Mark[]; active?: string | null } | undefined;
            if (meta) {
              const marks = meta.marks ?? value.marks;
              const active = meta.active !== undefined ? meta.active : value.active;
              return { marks, active, set: build(newState.doc, marks, active) };
            }
            /* After an edit the marks follow the text; the report is labelled stale elsewhere. */
            return tr.docChanged ? { ...value, set: value.set.map(tr.mapping, tr.doc) } : value;
          },
        },
        props: {
          decorations(state) {
            return findingsKey.getState(state)?.set ?? DecorationSet.empty;
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest("[data-finding]") as HTMLElement | null;
            if (el?.dataset.finding) {
              onSelect(el.dataset.finding);
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});
