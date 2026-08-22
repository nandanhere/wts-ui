import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button, Checkbox } from "react-aria-components";
import type {
  RemovalProtectedFilePreview,
  WorkspaceRemovalPreflight,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import type { Workspace } from "./LocalWorkspace";
import styles from "./LocalWorkspace.module.css";
import { ProtectedFilePreviewBoundary } from "./ProtectedFilePreviewBoundary";
import { canAssertDestructiveWorkspaceRemoval } from "./workspaceRemoval";

const ProtectedFileCodeView = lazy(() => import("./ProtectedFileCodeView"));

function splitDisplayPath(displayPath: string) {
  const separatorIndex = Math.max(
    displayPath.lastIndexOf("/"),
    displayPath.lastIndexOf("\\"),
  );
  return separatorIndex > 0
    ? {
        parentPath: displayPath.slice(0, separatorIndex),
        name: displayPath.slice(separatorIndex + 1),
      }
    : { parentPath: "", name: displayPath };
}

export interface WorkspaceRemovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace | undefined;
  preflight: WorkspaceRemovalPreflight | null;
  state: "loading" | "ready" | "removing" | "error";
  error: string;
  onRetry: () => void;
  onConfirm: (deleteProtectedPaths: boolean) => void;
}

export const WorkspaceRemovalDialog = memo(function WorkspaceRemovalDialog({
  open,
  onOpenChange,
  workspace,
  preflight,
  state,
  error,
  onRetry,
  onConfirm,
}: WorkspaceRemovalDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [protectedDeletionAcknowledged, setProtectedDeletionAcknowledged] =
    useState(false);
  const [selectedProtectedFile, setSelectedProtectedFile] =
    useState<RemovalProtectedFilePreview | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setConfirmed(false);
      setProtectedDeletionAcknowledged(false);
      setSelectedProtectedFile(null);
    }
  }, [open]);

  useEffect(() => {
    setConfirmed(false);
    setProtectedDeletionAcknowledged(false);
    setSelectedProtectedFile(null);
  }, [preflight?.effectDigest]);

  useEffect(() => {
    if (!open || state !== "removing") return;
    const frame = window.requestAnimationFrame(() => {
      progressRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, state]);

  if (!workspace) return null;
  const materialized = preflight?.kind === "materializedWorkspace";
  const ready = Boolean(preflight?.ready);
  const protectedPaths = preflight?.protectedPaths ?? [];
  const protectedFilePreviews = protectedPaths.flatMap(
    (protectedPath) => protectedPath.filePreviews,
  );
  const canAssertDestructiveDeletion =
    canAssertDestructiveWorkspaceRemoval(preflight);
  const destructiveDeletionConfirmed =
    canAssertDestructiveDeletion && protectedDeletionAcknowledged;
  const canRemove =
    state === "ready" &&
    ((ready && confirmed) || destructiveDeletionConfirmed);
  const hasWorktreeData = Boolean(
    preflight?.blockers.some(
      (blocker) =>
        blocker.code === "worktreeChanges" || blocker.code === "ignoredFiles",
    ),
  );
  const worktreeCount =
    preflight?.worktrees.filter((item) => item.present).length ?? 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && state === "removing") return;
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={`${styles.portalSurface} ${styles.removalDialog}`}
          aria-describedby="workspace-removal-description"
          data-ui="removal.dialog"
          data-ui-label="Workspace removal"
        >
          <header className={styles.removalHeader}>
            <span className={styles.removalIcon}>
              <Glyph name="trash" size={18} />
            </span>
            <div>
              <span className={styles.dialogEyebrow}>MANUAL COMMAND</span>
              <Dialog.Title>
                {materialized
                  ? `Remove ${workspace.key} from this Mac?`
                  : `Remove the ${workspace.key} plan?`}
              </Dialog.Title>
              <Dialog.Description id="workspace-removal-description">
                WTS checks the current local state again before removing
                anything. Repository branches are retained.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close removal dialog"
              className={styles.iconButton}
              disabled={state === "removing"}
            >
              <Glyph name="close" size={15} />
            </Dialog.Close>
          </header>

          <div className={styles.removalBody}>
            {state === "removing" && (
              <div
                className={styles.removalProgress}
                ref={progressRef}
                tabIndex={-1}
              >
                <Glyph name="refresh" size={16} />
                <span>
                  <b>Removing reviewed local effects</b>
                  <small>Branches and source checkouts remain in place.</small>
                </span>
              </div>
            )}
            {state === "loading" && (
              <div className={styles.removalLoading} role="status">
                <Glyph name="refresh" size={18} />
                <span>
                  <b>Reviewing removal effects</b>
                  <small>
                    Checking worktrees, local changes, generated files, and
                    retained branches…
                  </small>
                </span>
              </div>
            )}

            {preflight &&
              (selectedProtectedFile ? (
                <section
                  aria-label={`Preview ${selectedProtectedFile.relativePath}`}
                  className={styles.removalFileReader}
                  data-ui="removal.protected-file-preview"
                  data-ui-label="Protected file preview"
                >
                  <header>
                    <span>
                      <small>PROTECTED FILE</small>
                      <b>{selectedProtectedFile.relativePath}</b>
                    </span>
                    <span>
                      <Glyph name="code" size={14} />
                      Read only
                    </span>
                  </header>
                  <div className={styles.removalFileReaderLayout}>
                    <nav aria-label="Protected files">
                      <small>FILES</small>
                      {protectedFilePreviews.map((preview) => (
                        <button
                          aria-current={
                            selectedProtectedFile === preview
                              ? "page"
                              : undefined
                          }
                          key={preview.relativePath}
                          onClick={() => setSelectedProtectedFile(preview)}
                          type="button"
                        >
                          <Glyph name="file" size={13} />
                          <span>{preview.relativePath}</span>
                        </button>
                      ))}
                    </nav>
                    <div
                      className={styles.removalFileReaderCode}
                      data-ui="removal.protected-file-contents"
                      data-ui-label="Protected file contents"
                    >
                      <ProtectedFilePreviewBoundary
                        fallback={
                          <pre className={styles.removalFileReaderFallback}>
                            {selectedProtectedFile.contents}
                          </pre>
                        }
                        key={selectedProtectedFile.relativePath}
                      >
                        <Suspense
                          fallback={
                            <pre className={styles.removalFileReaderFallback}>
                              {selectedProtectedFile.contents}
                            </pre>
                          }
                        >
                          <ProtectedFileCodeView
                            preview={selectedProtectedFile}
                          />
                        </Suspense>
                      </ProtectedFilePreviewBoundary>
                    </div>
                  </div>
                </section>
              ) : (
                <>
                  <div
                    className={styles.removalSummary}
                    data-ui="removal.summary"
                    data-ui-label="Removal summary"
                  >
                  <span>
                    <small>WORKTREES</small>
                    <b>{worktreeCount}</b>
                    <em>
                      {materialized ? "removed after review" : "none created"}
                    </em>
                  </span>
                  <span>
                    <small>GENERATED DATA</small>
                    <b>{preflight.generatedPaths.length}</b>
                    <em>
                      {materialized ? "WTS-owned paths" : "no file effects"}
                    </em>
                  </span>
                  <span data-retained>
                    <small>BRANCHES</small>
                    <b>{preflight.retainedBranches.length}</b>
                    <em>always retained</em>
                  </span>
                  </div>

                {preflight.worktrees.length > 0 && (
                  <div className={styles.removalWorktrees}>
                    <h3>Local worktrees</h3>
                    {preflight.worktrees.map((worktree) => (
                      <div key={worktree.repositoryId}>
                        <span>
                          <Glyph name="folder" size={14} />
                          <b>{worktree.label}</b>
                        </span>
                        <code>{worktree.targetDisplayPath}</code>
                        <small>
                          {worktree.present
                            ? "Will be removed"
                            : "Already absent"}{" "}
                          · branch <code>{worktree.branchName}</code> stays
                        </small>
                      </div>
                    ))}
                  </div>
                )}

                {preflight.blockers.length > 0 && (
                  <section
                    className={styles.removalBlockers}
                    data-ui="removal.blockers"
                    data-ui-label="Removal blockers"
                    role="alert"
                  >
                    <h3>
                      <Glyph name="warning" size={15} />
                      {canAssertDestructiveDeletion
                        ? "Removal needs confirmation"
                        : "Removal is blocked"}
                    </h3>
                    <ul>
                      {preflight.blockers.map((blocker, index) => (
                        <li key={`${blocker.code}-${index}`}>
                          <b>{blocker.repositoryLabel ?? "Workspace"}</b>
                          <span>{blocker.message}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {protectedPaths.length > 0 && (
                  <section
                    className={styles.removalProtectedFiles}
                    data-ui="removal.protected-files"
                    data-ui-label="Protected planning files"
                  >
                    <header>
                      <span>
                        <Glyph name="folder" size={15} />
                        <b>Protected planning files</b>
                      </span>
                      <small>WTS did not create or own these files.</small>
                    </header>
                    {protectedPaths.map((protectedPath) => {
                      const path = splitDisplayPath(
                        protectedPath.displayPath,
                      );
                      return (
                        <details key={protectedPath.displayPath} open>
                        <summary>
                          <span className={styles.removalProtectedPath}>
                            <b>{path.name}</b>
                            {path.parentPath && (
                              <code>{path.parentPath}</code>
                            )}
                          </span>
                          <span>
                            {protectedPath.entries.length} shown
                            {protectedPath.entriesTruncated ? "+" : ""}
                          </span>
                        </summary>
                        {protectedPath.entries.length > 0 ? (
                          <ul>
                            {protectedPath.entries.map((entry) => {
                              const preview = protectedPath.filePreviews.find(
                                (candidate) =>
                                  candidate.relativePath === entry,
                              );
                              return (
                                <li key={entry}>
                                  <Glyph
                                    name={
                                      entry.endsWith("/") ? "folder" : "file"
                                    }
                                    size={13}
                                  />
                                  {preview ? (
                                    <button
                                      aria-label={`Read ${entry}`}
                                      onClick={() =>
                                        setSelectedProtectedFile(preview)
                                      }
                                      type="button"
                                    >
                                      <code>{entry}</code>
                                      <Glyph name="arrow" size={13} />
                                    </button>
                                  ) : (
                                    <code>{entry}</code>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <p>The folder is empty.</p>
                        )}
                        {protectedPath.entriesTruncated && (
                          <p>More entries exist. The review list is limited.</p>
                        )}
                        </details>
                      );
                    })}
                  </section>
                )}

                {canAssertDestructiveDeletion && (
                  <Checkbox
                    className={styles.removalAssertionCheck}
                    isDisabled={state === "removing"}
                    isSelected={protectedDeletionAcknowledged}
                    onChange={setProtectedDeletionAcknowledged}
                  >
                    <span className={styles.confirmationIndicator}>
                      <Glyph name="check" size={12} />
                    </span>
                    <span>
                      <b>
                        {hasWorktreeData && protectedPaths.length > 0
                          ? "Delete local changes, planning files, and this workspace"
                          : hasWorktreeData
                            ? "Delete local changes and this workspace"
                            : "Delete the listed planning files and this workspace"}
                      </b>
                      <small>
                        I understand that uncommitted, untracked, ignored, and
                        listed planning files are permanently deleted. Local
                        branches and committed work are retained.
                      </small>
                    </span>
                  </Checkbox>
                )}

                {preflight.warnings.length > 0 && (
                  <ul className={styles.removalWarnings}>
                    {preflight.warnings.map((warning) => (
                      <li key={warning}>
                        <Glyph name="warning" size={13} />
                        {warning}
                      </li>
                    ))}
                  </ul>
                )}

                {ready && (
                  <Checkbox
                    className={styles.confirmationCheck}
                    isSelected={confirmed}
                    onChange={setConfirmed}
                  >
                    <span className={styles.confirmationIndicator}>
                      <Glyph name="check" size={12} />
                    </span>
                    <span>
                      <b>
                        {materialized
                          ? "Remove these local worktrees and WTS artifacts"
                          : "Remove this saved plan from WTS"}
                      </b>
                      <small>
                        Source checkouts and local branches will not be deleted.
                      </small>
                    </span>
                  </Checkbox>
                )}
                  </>
              ))}

            {error && (
              <p className={styles.removalError} role="alert">
                <Glyph name="warning" size={14} />
                {error}
              </p>
            )}
          </div>

          <footer className={styles.removalFooter}>
            <span>
              {selectedProtectedFile
                ? "This preview is read only. No file changes are made."
                : "This command is explicit and can be cancelled before confirmation."}
            </span>
            <div>
              {selectedProtectedFile ? (
                <Button
                  className={styles.primaryButton}
                  onPress={() => setSelectedProtectedFile(null)}
                >
                  Back to removal review
                </Button>
              ) : (
                <>
                  {(state === "error" || (preflight && !preflight.ready)) && (
                    <Button
                      className={styles.secondaryButton}
                      onPress={onRetry}
                      isDisabled={state === "loading" || state === "removing"}
                    >
                      <Glyph name="refresh" size={14} />
                      Check again
                    </Button>
                  )}
                  <Dialog.Close
                    className={styles.secondaryButton}
                    disabled={state === "removing"}
                  >
                    Cancel
                  </Dialog.Close>
                  <Button
                    className={styles.dangerButton}
                    isDisabled={!canRemove}
                    onPress={() => onConfirm(canAssertDestructiveDeletion)}
                  >
                    {state === "removing" ? (
                      <>
                        <Glyph name="refresh" size={14} />
                        Removing…
                      </>
                    ) : (
                      <>
                        <Glyph name="trash" size={14} />
                        {canAssertDestructiveDeletion
                          ? "Delete local data and workspace"
                          : "Remove workspace"}
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});
