import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownBaseline, spliceMarkdown, type MarkdownCodec } from "./planningMarkdownSplice";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function load(source: string) {
  const editor = new Editor({ extensions: [StarterKit, TableKit, TaskList, TaskItem, Markdown], content: source, contentType: "markdown" });
  editors.push(editor);
  const manager = editor.storage.markdown.manager!;
  const codec: MarkdownCodec = {
    lex: (text) => manager.instance.lexer(text) as unknown as Array<{ type: string; raw: string }>,
    serialize: (doc) => manager.serialize(doc),
  };
  const baseline = createMarkdownBaseline(source, editor.getJSON(), codec);
  return { editor, baseline, save: () => spliceMarkdown(baseline, editor.getJSON(), codec) };
}

// A hand-written planning file. A full rewrite pads these tables, escapes the underscores, and changes the list indent.
const source = [
  "# Plan", "",
  "| ID | Decision | Status |", "| --- | --- | --- |", "| D1 | One replica in each region. | Closed |", "| D2 | Power-off after success. | Open |", "",
  "Notes with BMC_AUTH_FAILED and  two spaces.", "",
  "1. First step.", "   Continued on the next line.", "",
  "## Next", "", "Last paragraph.", "",
].join("\n");

describe("planning Markdown splice", () => {
  it("returns the exact file when nothing changed", () => {
    const { baseline, save } = load(source);
    expect(baseline.ranges).not.toBeNull();
    expect(save()).toBe(source);
  });

  it("rewrites only the edited block and keeps every other byte", () => {
    const { editor, save } = load(source);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " Added.");
    expect(save()).toBe(source.replace("Last paragraph.", "Last paragraph. Added."));
  });

  it("inserts and removes whole blocks without touching the table", () => {
    const inserted = load(source);
    inserted.editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Intro." }] });
    expect(inserted.save()).toBe("Intro.\n\n" + source);

    const removed = load(source);
    const json = removed.editor.getJSON();
    removed.editor.commands.setContent({ ...json, content: json.content!.filter((node) => node.type !== "orderedList") }, { emitUpdate: false });
    expect(removed.save()).toBe(source.replace("1. First step.\n   Continued on the next line.\n\n", ""));
  });
});
