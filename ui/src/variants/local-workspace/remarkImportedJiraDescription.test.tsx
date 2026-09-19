import { render, screen, within } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkImportedJiraDescription } from "./remarkImportedJiraDescription";

const context = "## Jira context\n\n- Issue: `PLATFORM-42`\n- Summary: Retry rule\n- Status: Open\n\n### Imported description\n\n";

function preview(source: string) {
  render(<article aria-label="Preview"><ReactMarkdown remarkPlugins={[remarkGfm, remarkImportedJiraDescription]} skipHtml>{source}</ReactMarkdown></article>);
  return screen.getByRole("article", { name: "Preview" });
}

describe("imported Jira description preview", () => {
  it.each([null, "", " \n\t"])("explains an explicitly empty description: %j", (description) => {
    const rendered = preview(context + JSON.stringify({ key: "PLATFORM-42", fields: { description } }));
    expect(within(rendered).getByText("No Jira description was available when this planning home was created.").tagName).toBe("P");
  });

  it.each([
    { key: "OTHER-42", description: "Keep this evidence." },
    { key: "PLATFORM-42", issue_key: "OTHER-42", description: "Keep this evidence." },
    { key: null, issue_key: "PLATFORM-42", description: "Keep this evidence." },
    { key: "PLATFORM-42", fields: { description: { type: "doc", content: [] } } },
    { key: "PLATFORM-42", fields: {} },
  ])("preserves an unknown or mismatched envelope: %j", (envelope) => {
    const raw = JSON.stringify(envelope);
    expect(preview(context + raw)).toHaveTextContent(raw);
  });

  it("decodes pretty JSON once and keeps code, tables, and adjacent planning sections", () => {
    const description = "Use `<Result<T>>`.\n\n```tsx\nconst node = <Result<T> />;\n```\n\n| Step | State |\n| --- | --- |\n| Retry | Ready |";
    const rendered = preview(context + JSON.stringify({ key: "PLATFORM-42", fields: { description }, description: "Wrong fallback" }, null, 2) + "\n\n## Objective\n\nKeep this objective.");
    expect(within(rendered).getByText("<Result<T>>").tagName).toBe("CODE");
    expect(within(rendered).getByText("const node = <Result<T> />;").tagName).toBe("CODE");
    expect(within(rendered).getByRole("table")).toHaveTextContent("RetryReady");
    expect(within(rendered).getByText("Keep this objective.")).toBeVisible();
    expect(rendered).not.toHaveTextContent("Wrong fallback");
  });

  it.each([
    (raw: string) => `### Imported description\n\n${raw}`,
    (raw: string) => `## User notes\n\n- Issue: \`PLATFORM-42\`\n\n### Imported description\n\n${raw}`,
    (raw: string) => `${context}${raw}\n\nKeep this user note.`,
    (raw: string) => `\`\`\`markdown\n${context}${raw}\n\`\`\``,
    (raw: string) => `${context}\`\`\`json\n${raw}\n\`\`\``,
  ])("leaves user text and fenced examples intact outside the generated block %#", (source) => {
    const raw = JSON.stringify({ key: "PLATFORM-42", description: "Keep this evidence." });
    expect(preview(source(raw))).toHaveTextContent(raw);
  });

  it("keeps a second JSON string as description text instead of unwrapping it again", () => {
    const inner = JSON.stringify({ key: "PLATFORM-42", description: "Nested evidence" });
    expect(preview(context + JSON.stringify({ key: "PLATFORM-42", description: inner }))).toHaveTextContent(inner);
  });
});
