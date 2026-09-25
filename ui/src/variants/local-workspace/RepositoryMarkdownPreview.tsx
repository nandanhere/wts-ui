import { useEffect, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PatchReviewFeedbackIdentity } from "./RepositoryPatchViewer";
import { MermaidCodeBlock } from "./PlanningDocumentsPanel";
import styles from "./RepositoryPatchViewer.module.css";

export function RepositoryMarkdownPreview({ file, feedback }: {
  file: FileDiffMetadata;
  feedback?: PatchReviewFeedbackIdentity;
}) {
  const [result, setResult] = useState<{ content?: string; error?: string }>({});
  const deleted = file.type === "deleted";
  const { client, workspaceId, repositoryId, baseCommitOid, headCommitOid, patchSha256 } = feedback ?? {};

  useEffect(() => {
    if (!client || !workspaceId || !repositoryId || !patchSha256) return;
    let active = true;
    setResult({});
    void client.getWorkspaceRepositoryFileReview(workspaceId, repositoryId, file.name, patchSha256)
      .then((response) => {
        if (!active) return;
        if (response.workspaceId !== workspaceId || response.repositoryId !== repositoryId ||
            response.baseCommitOid !== baseCommitOid || response.headCommitOid !== headCommitOid ||
            response.patchSha256 !== patchSha256 || response.filePath !== file.name) {
          throw new Error("The repository changed. Reload the changes and try again.");
        }
        const complete = parsePatchFiles(response.fullPatch).flatMap((patch) => patch.files)
          .find((entry) => entry.name === file.name);
        if (!complete) throw new Error("WTS could not display the complete file.");
        setResult({ content: (deleted ? complete.deletionLines : complete.additionLines).join("") });
      })
      .catch((error: unknown) => {
        if (active) setResult({ error: error instanceof Error ? error.message : "WTS could not read the complete file." });
      });
    return () => { active = false; };
  }, [client, workspaceId, repositoryId, baseCommitOid, headCommitOid, patchSha256, file.name, deleted]);

  const sections = result.content !== undefined ? [result.content] : file.hunks.map((hunk) => {
    const lines = deleted ? file.deletionLines : file.additionLines;
    const start = deleted ? hunk.deletionLineIndex : hunk.additionLineIndex;
    const count = deleted ? hunk.deletionCount : hunk.additionCount;
    return lines.slice(start, start + count).join("");
  });
  return (
    <section aria-label={`Markdown preview for ${file.name}`} className={styles.markdownPreview}>
      {feedback && result.content === undefined && !result.error ? <p role="status">WTS reads the complete file…</p> : <>
        {result.error && <p role="alert">{result.error}</p>}
        <p className={styles.previewNotice}>
          {deleted ? "Deleted file" : "Changed version"} · {result.content !== undefined ? "Complete file" : "Patch excerpts only. Unchanged sections can be absent."}
        </p>
        {sections.map((content, index) => <article key={index}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
            pre: MermaidCodeBlock,
            a: ({ href, children }) => /^https?:\/\//i.test(href ?? "")
              ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
              : <span>{children}</span>,
            img: ({ alt }) => <span>{alt ? `Image: ${alt}` : "Image"}</span>,
          }}>{content}</ReactMarkdown>
        </article>)}
      </>}
    </section>
  );
}
