import type { JSONContent } from "@tiptap/core";

/** The subset of the Tiptap markdown manager that the splice needs. */
export interface MarkdownCodec {
  lex: (source: string) => Array<{ type: string; raw: string }>;
  serialize: (doc: JSONContent) => string;
}

export interface MarkdownBaseline {
  /** The exact markdown text that the editor loaded. */
  source: string;
  /** The top-level blocks of the loaded document, without empty paragraphs. */
  blocks: JSONContent[];
  /** The source range of each block, or null when the blocks do not map to the source. */
  ranges: Array<{ start: number; end: number }> | null;
}

const TOKEN_NODE_TYPES: Record<string, readonly string[]> = {
  blockquote: ["blockquote"],
  code: ["codeBlock"],
  heading: ["heading"],
  hr: ["horizontalRule"],
  list: ["bulletList", "orderedList", "taskList"],
  paragraph: ["paragraph"],
  table: ["table"],
};

function isEmptyParagraph(node: JSONContent) {
  return node.type === "paragraph" && !(node.content ?? []).some(
    (child) => child.type !== "text" || (child.text ?? "").replace(/\u00a0/g, "").trim() !== "",
  );
}

export function contentBlocks(doc: JSONContent): JSONContent[] {
  return (doc.content ?? []).filter((node) => !isEmptyParagraph(node));
}

function sameBlock(left: JSONContent, right: JSONContent) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Maps each loaded block to its exact source range. Returns null when the mapping is not certain. */
export function createMarkdownBaseline(source: string, doc: JSONContent, codec: MarkdownCodec): MarkdownBaseline {
  const blocks = contentBlocks(doc);
  let ranges: MarkdownBaseline["ranges"] = null;
  try {
    const tokens = codec.lex(source);
    let offset = 0;
    const blockRanges: Array<{ start: number; end: number; type: string }> = [];
    for (const token of tokens) {
      const start = offset;
      offset += token.raw.length;
      if (token.type === "space" || token.type === "def") continue;
      if (token.type === "paragraph" && token.raw.replace(/&nbsp;|\u00a0/g, "").trim() === "") continue;
      const trimmed = token.raw.replace(/\n+$/, "");
      blockRanges.push({ start, end: start + trimmed.length, type: token.type });
    }
    const exact = offset === source.length && tokens.map((token) => token.raw).join("") === source;
    const typesMatch = blockRanges.length === blocks.length && blockRanges.every((range, index) => {
      const allowed = TOKEN_NODE_TYPES[range.type];
      return !allowed || allowed.includes(blocks[index]!.type ?? "");
    });
    if (exact && typesMatch) ranges = blockRanges.map(({ start, end }) => ({ start, end }));
  } catch {
    ranges = null;
  }
  return { source, blocks, ranges };
}

/**
 * Returns markdown for the edited document. Unchanged blocks keep their exact source text.
 * Only the changed blocks are written again. When the blocks do not map to the source,
 * the complete document is written again.
 */
export function spliceMarkdown(baseline: MarkdownBaseline, doc: JSONContent, codec: MarkdownCodec): string {
  const next = contentBlocks(doc);
  const previous = baseline.blocks;
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && sameBlock(previous[prefix]!, next[prefix]!)) prefix += 1;
  if (prefix === previous.length && prefix === next.length) return baseline.source;
  if (!baseline.ranges) return codec.serialize({ type: "doc", content: next });
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    sameBlock(previous[previous.length - 1 - suffix]!, next[next.length - 1 - suffix]!)
  ) suffix += 1;

  const ranges = baseline.ranges;
  const source = baseline.source;
  const changedOld = ranges.slice(prefix, previous.length - suffix);
  const changedNew = next.slice(prefix, next.length - suffix);
  const written = changedNew.length ? codec.serialize({ type: "doc", content: changedNew }).replace(/\n+$/, "") : "";

  if (changedOld.length) {
    const start = changedOld[0]!.start;
    const end = changedOld[changedOld.length - 1]!.end;
    if (!written) {
      // Remove the deleted blocks and the blank lines that follow them.
      if (suffix) return source.slice(0, start) + source.slice(ranges[previous.length - suffix]!.start);
      if (!prefix) return "";
      return source.slice(0, ranges[prefix - 1]!.end) + (source.endsWith("\n") ? "\n" : "");
    }
    return source.slice(0, start) + written + source.slice(end);
  }

  // Only new blocks: insert them between the unchanged blocks.
  if (suffix) {
    const at = ranges[previous.length - suffix]!.start;
    return source.slice(0, at) + written + "\n\n" + source.slice(at);
  }
  const at = prefix ? ranges[prefix - 1]!.end : 0;
  const tail = source.slice(at);
  return source.slice(0, at) + (prefix ? "\n\n" : "") + written + (tail.trim() ? tail : tail || (prefix ? "\n" : ""));
}
