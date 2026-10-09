import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { createMarkdownBaseline, spliceMarkdown, type MarkdownBaseline, type MarkdownCodec } from "./planningMarkdownSplice";
import styles from "./PlanningDocumentsPanel.module.css";

export interface PlanningRichEditorProps {
  label: string;
  value: string;
  readOnly?: boolean;
  onChange: (markdown: string) => void;
  onSave: () => void;
}

function codecFor(editor: Editor): MarkdownCodec | null {
  const manager = editor.storage.markdown?.manager;
  if (!manager) return null;
  return {
    lex: (source) => manager.instance.lexer(source) as unknown as Array<{ type: string; raw: string }>,
    serialize: (doc) => manager.serialize(doc),
  };
}

interface ToolbarAction {
  id: string;
  label: string;
  text: string;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

const TOOLBAR_GROUPS: ToolbarAction[][] = [
  [
    { id: "heading-2", label: "Heading", text: "H2", isActive: (e) => e.isActive("heading", { level: 2 }), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { id: "heading-3", label: "Subheading", text: "H3", isActive: (e) => e.isActive("heading", { level: 3 }), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  ],
  [
    { id: "bold", label: "Bold", text: "B", isActive: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
    { id: "italic", label: "Italic", text: "I", isActive: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
    { id: "code", label: "Inline code", text: "</>", isActive: (e) => e.isActive("code"), run: (e) => e.chain().focus().toggleCode().run() },
  ],
  [
    { id: "bullet-list", label: "Bulleted list", text: "•", isActive: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
    { id: "ordered-list", label: "Numbered list", text: "1.", isActive: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: "task-list", label: "Checklist", text: "☐", isActive: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  ],
  [
    { id: "quote", label: "Quote", text: "❝", isActive: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: "code-block", label: "Code block", text: "{ }", isActive: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
  ],
];

export default function PlanningRichEditor({ label, value, readOnly = false, onChange, onSave }: PlanningRichEditorProps) {
  const baselineRef = useRef<MarkdownBaseline | null>(null);
  const emittedRef = useRef(value);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  const extensions = useMemo(() => [
    StarterKit.configure({ link: { openOnClick: false, autolink: false } }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown,
  ], []);

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editable: !readOnly,
    autofocus: "start",
    immediatelyRender: true,
    editorProps: {
      attributes: {
        "aria-label": `Edit ${label}`,
        "aria-multiline": "true",
        class: `${styles.previewView} ${styles.richDocument}`,
        "data-history-swipe-block": "",
        role: "textbox",
        spellcheck: "true",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          callbacks.current.onSave();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: created }) => {
      const codec = codecFor(created);
      baselineRef.current = codec ? createMarkdownBaseline(value, created.getJSON(), codec) : null;
    },
    onUpdate: ({ editor: updated }) => {
      const codec = codecFor(updated);
      const baseline = baselineRef.current;
      if (!codec || !baseline) return;
      const next = spliceMarkdown(baseline, updated.getJSON(), codec);
      if (next === emittedRef.current) return;
      emittedRef.current = next;
      callbacks.current.onChange(next);
    },
  }, []);

  // Load a draft that changed outside this editor, for example after a reload.
  useEffect(() => {
    if (!editor || value === emittedRef.current) return;
    emittedRef.current = value;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    const codec = codecFor(editor);
    baselineRef.current = codec ? createMarkdownBaseline(value, editor.getJSON(), codec) : null;
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => Object.fromEntries(
      TOOLBAR_GROUPS.flat().map((action) => [action.id, current ? action.isActive(current) : false]),
    ) as Record<string, boolean>,
  });

  const exactLayout = baselineRef.current?.ranges !== null;

  return (
    <div className={styles.richEditor}>
      {!readOnly && (
        <div
          aria-label="Formatting"
          className={styles.richToolbar}
          data-ui="planning.rich-toolbar"
          data-ui-label="Formatting toolbar"
          role="toolbar"
        >
          {TOOLBAR_GROUPS.map((group, index) => (
            <div className={styles.richToolbarGroup} key={index}>
              {group.map((action) => (
                <button
                  aria-label={action.label}
                  aria-pressed={active?.[action.id] ?? false}
                  className={styles.richToolbarButton}
                  data-action={action.id}
                  disabled={!editor}
                  key={action.id}
                  onClick={() => editor && action.run(editor)}
                  onMouseDown={(event) => event.preventDefault()}
                  title={action.label}
                  type="button"
                >
                  {action.text}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {!exactLayout && (
        <p className={styles.richNotice} role="note">
          This file has Markdown that the editor cannot map line by line. A save from this view writes the complete file again. Use Source to keep the exact layout.
        </p>
      )}
      <div className={styles.richScroll}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
