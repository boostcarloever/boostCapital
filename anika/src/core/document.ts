/**
 * Conversions between the editor's ProseMirror JSON, analysis blocks, and
 * Markdown. Pure functions, safe to import from both the UI and the server.
 */
import type { Block, BlockKind } from "./types";

interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
}

const HARD_BREAK = "\n";

/** Exact text of an inline-content node, with hard breaks as "\n". */
export function inlineText(node: PmNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return HARD_BREAK;
  return (node.content ?? []).map(inlineText).join("");
}

/**
 * Flatten editor JSON into analysis blocks. Block quotes become one "quote"
 * block per inner paragraph so quotation text is never mistaken for author prose.
 * Lists are flattened to paragraphs (one per item), keeping their ids.
 */
export function blocksFromEditorJson(doc: unknown): Block[] {
  const blocks: Block[] = [];
  const visit = (node: PmNode, inQuote: boolean) => {
    switch (node.type) {
      case "paragraph":
      case "heading":
      case "codeBlock": {
        const kind: BlockKind =
          node.type === "heading" ? "heading" : node.type === "codeBlock" ? "code" : inQuote ? "quote" : "paragraph";
        const block: Block = {
          id: String(node.attrs?.blockId ?? `blk_missing_${blocks.length}`),
          kind,
          text: inlineText(node),
        };
        if (node.type === "heading") block.level = Number(node.attrs?.level ?? 2);
        if (node.attrs?.locked) block.locked = true;
        blocks.push(block);
        return;
      }
      case "blockquote":
        (node.content ?? []).forEach((child) => visit(child, true));
        return;
      default:
        (node.content ?? []).forEach((child) => visit(child, inQuote));
    }
  };
  visit(doc as PmNode, false);
  return blocks;
}

/** Build minimal editor JSON from blocks (used for imports and candidates). */
export function editorJsonFromBlocks(blocks: Block[]): unknown {
  const content: PmNode[] = [];
  for (const block of blocks) {
    const attrs = { blockId: block.id, locked: block.locked ?? false };
    const inline = textToInline(block.text);
    if (block.kind === "heading") {
      content.push({ type: "heading", attrs: { ...attrs, level: block.level ?? 2 }, content: inline });
    } else if (block.kind === "code") {
      content.push({ type: "codeBlock", attrs, content: block.text ? [{ type: "text", text: block.text }] : undefined });
    } else if (block.kind === "quote") {
      const para = { type: "paragraph", attrs, content: inline };
      const prev = content[content.length - 1];
      if (prev?.type === "blockquote") prev.content!.push(para);
      else content.push({ type: "blockquote", content: [para] });
    } else {
      content.push({ type: "paragraph", attrs, content: inline });
    }
  }
  return { type: "doc", content };
}

function textToInline(text: string): PmNode[] | undefined {
  if (!text) return undefined;
  const parts = text.split(HARD_BREAK);
  const out: PmNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    if (part) out.push({ type: "text", text: part });
  });
  return out;
}

/** Markdown reading/export view. Derived; never authoritative. */
export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.kind === "heading") return `${"#".repeat(b.level ?? 2)} ${b.text}`;
      if (b.kind === "quote") return b.text.split("\n").map((l) => `> ${l}`).join("\n");
      if (b.kind === "code") return "```\n" + b.text + "\n```";
      return b.text;
    })
    .join("\n\n")
    .concat("\n");
}

/**
 * Parse the supported Markdown/plain-text subset into blocks: ATX headings,
 * block quotes, fenced code, and blank-line separated paragraphs.
 * `makeId` supplies stable ids for new blocks.
 */
export function markdownToBlocks(source: string, makeId: () => string): Block[] {
  const text = source.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ id: makeId(), kind: "paragraph", text: para.join(" ").trim() });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ id: makeId(), kind: "quote", text: quote.join(" ").trim() });
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      flushQuote();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      blocks.push({ id: makeId(), kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushQuote();
      blocks.push({ id: makeId(), kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushQuote();
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flushPara();
  flushQuote();
  return blocks.filter((b) => b.kind === "code" || b.text.length > 0);
}

/** Count words the way the length checker does: whitespace-separated tokens. */
export function countWords(text: string): number {
  const tokens = text.trim().split(/\s+/u);
  return tokens.length === 1 && tokens[0] === "" ? 0 : tokens.length;
}
