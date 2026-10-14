import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./CodeReviewFeedbackPanel.module.css";

function safeDiscussionUrl(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch {
    return "";
  }
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function readableProviderHtml() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "html") { visit(child); return [child]; }
        const value = (child.value ?? "")
            .replace(/<\/?(?:details|summary)(?:\s[^>]*)?>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .trim();
        if (!value) return [];
        const text = { type: "text", value };
        return [(["root", "blockquote", "listItem"].includes(node.type)
          ? { type: "paragraph", children: [text] }
          : text)];
      });
    };
    visit(tree);
  };
}

export function GitlabDiscussionBody({ body, className }: { body: string; className?: string }) {
  return (
    <div className={[styles.discussionBody, className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        components={{
          a: ({ children, href }) => {
            const safeHref = href ? safeDiscussionUrl(href) : "";
            return safeHref ? (
              <a href={safeHref} rel="noreferrer" target="_blank">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
        remarkPlugins={[remarkGfm, readableProviderHtml]}
        skipHtml
        urlTransform={safeDiscussionUrl}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
