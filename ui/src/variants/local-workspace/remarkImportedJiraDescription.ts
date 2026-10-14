interface MarkdownNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function importedDescription(source: string, issueKey: string): string | undefined {
  if (new TextEncoder().encode(source).length > 512 * 1024) return undefined;
  let value: unknown;
  try { value = JSON.parse(source); } catch { return undefined; }
  if (!record(value) || (value.key ?? value.issue_key) !== issueKey) return undefined;
  if (["key", "issue_key"].some((key) => Object.hasOwn(value, key) && value[key] !== issueKey)) return undefined;
  const description = record(value.fields) && Object.hasOwn(value.fields, "description")
    ? value.fields.description : value.description;
  if (description === null || (typeof description === "string" && !description.trim())) {
    return "No Jira description was available when this planning home was created.";
  }
  return typeof description === "string" ? description : undefined;
}

function heading(node: MarkdownNode, depth: number, label: string) {
  return node.type === "heading" && node.depth === depth && node.children?.length === 1
    && node.children[0].type === "text" && node.children[0].value === label;
}

// Only preview nodes change. Source lines and saved file digests keep their original identity.
export function remarkImportedJiraDescription(this: { parse(source: string): MarkdownNode }) {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const nodes = tree.children;
    if (!nodes) return;
    const source = String(file.value);
    let inJiraContext = false;
    let issueKeys: string[] = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.type === "heading" && (node.depth ?? 7) <= 2) {
        inJiraContext = heading(node, 2, "Jira context");
        issueKeys = [];
        continue;
      }
      if (!inJiraContext) continue;
      if (node.type === "list") {
        for (const item of node.children ?? []) {
          const paragraph = item.children?.[0];
          const parts = paragraph?.children;
          if (paragraph?.type === "paragraph" && parts?.length === 2
            && parts[0].type === "text" && parts[0].value === "Issue: "
            && parts[1].type === "inlineCode" && parts[1].value) {
            issueKeys.push(parts[1].value);
          }
        }
      }
      if (!heading(node, 3, "Imported description") || issueKeys.length !== 1) continue;
      let end = index + 1;
      while (end < nodes.length && !(nodes[end].type === "heading" && (nodes[end].depth ?? 7) <= 3)) end += 1;
      const startOffset = node.position?.end.offset;
      const endOffset = end < nodes.length ? nodes[end].position?.start.offset : source.length;
      if (startOffset === undefined || endOffset === undefined) continue;
      const description = importedDescription(source.slice(startOffset, endOffset).trim(), issueKeys[0]);
      if (description === undefined) continue;
      const previewNodes = this.parse(description).children ?? [];
      nodes.splice(index + 1, end - index - 1, ...previewNodes);
      index += previewNodes.length;
    }
  };
}
