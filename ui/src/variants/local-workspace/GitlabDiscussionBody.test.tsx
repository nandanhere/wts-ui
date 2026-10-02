import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitlabDiscussionBody } from "./GitlabDiscussionBody";

describe("discussion and agent Markdown", () => {
  it("preserves exact code examples with JSX, generics, and HTML", () => {
    const code = 'const result: Promise<Result<Item>> = load();\nreturn <Button disabled={count < 3}>Retry</Button>;\n<!-- keep this comment -->';
    const { container } = render(<GitlabDiscussionBody body={`Suggested change:\n\n\`\`\`tsx\n${code}\n\`\`\``} />);
    expect(container.querySelector("pre code")?.textContent).toBe(`${code}\n`);
    expect(container.querySelector("button")).toBeNull();
  });

  it("preserves inline code and blank lines within code", () => {
    const code = "type Response<T> = { value: T };\n\n\nexport {};";
    const { container } = render(<GitlabDiscussionBody body={`Use \`Promise<Result<T>>\`.\n\n\`\`\`ts\n${code}\n\`\`\``} />);
    expect(screen.getByText("Promise<Result<T>>").tagName).toBe("CODE");
    expect(container.querySelector("pre code")?.textContent).toBe(`${code}\n`);
  });

  it("shows provider summary text and Markdown without executing HTML", () => {
    const { container } = render(<GitlabDiscussionBody body={'<details><summary>Review summary</summary>\n\n## Finding\n\nUse **three** attempts.\n\n</details>\n\n<script>alert("unsafe")</script>\n\n[Unsafe](javascript:alert(1))'} />);
    expect(screen.getByText("Review summary")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Finding" })).toBeVisible();
    expect(screen.getByText("three").tagName).toBe("STRONG");
    expect(container.querySelector("script, details, summary")).toBeNull();
    expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
  });
});
