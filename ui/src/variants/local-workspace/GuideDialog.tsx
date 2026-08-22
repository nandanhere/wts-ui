import { memo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Glyph } from "./Glyph";
import styles from "./LocalWorkspace.module.css";

export interface GuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateWorkspace: () => void;
}

export const GuideDialog = memo(function GuideDialog({
  open,
  onOpenChange,
  onCreateWorkspace,
}: GuideDialogProps) {
  const startWorkspace = () => {
    onOpenChange(false);
    onCreateWorkspace();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={`${styles.portalSurface} ${styles.guideDialog}`}
          aria-describedby="wts-guide-description"
          data-ui="guide.dialog"
          data-ui-label="WTS guide"
        >
          <header className={styles.guideHeader}>
            <div>
              <span className={styles.dialogEyebrow}>LOCAL WORKFLOW</span>
              <Dialog.Title>How to use WTS</Dialog.Title>
              <Dialog.Description id="wts-guide-description">
                One issue, its relevant repositories, and an isolated place to
                change them—without moving your primary checkouts.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className={styles.iconButton}
              aria-label="Close guide"
            >
              <Glyph name="close" size={15} />
            </Dialog.Close>
          </header>

          <div className={styles.guideBody}>
            <section
              className={styles.guidePath}
              aria-labelledby="guide-path-title"
              data-ui="guide.working-loop"
              data-ui-label="Working loop"
            >
              <div className={styles.guideSectionHeading}>
                <span>01–04</span>
                <div>
                  <h3 id="guide-path-title">The working loop</h3>
                  <p>Each effect is reviewed before WTS applies it.</p>
                </div>
              </div>
              <ol>
                <li>
                  <span>1</span>
                  <div>
                    <b>Check your local setup</b>
                    <p>
                      Open Environment &amp; integrations and confirm Git plus
                      the repository folder. Jira and agents are optional for
                      creating worktrees.
                    </p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <b>Save a workspace plan</b>
                    <p>
                      Import an issue, choose local repositories, or reuse the
                      repository setup from a saved workspace. Then review the
                      repositories and base branches.
                    </p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <b>Review, then create</b>
                    <p>
                      Review setup is read-only. Check the exact branches,
                      commits, and paths, then create the worktrees as one
                      recoverable operation.
                    </p>
                  </div>
                </li>
                <li>
                  <span>4</span>
                  <div>
                    <b>Open, verify, or delegate</b>
                    <p>
                      Open the workspace in your preferred editor or agent. Use
                      Verification for deterministic checks and local user
                      journeys, then prepare a brief when you want an agent to
                      investigate gaps. Graphify is optional context, not a
                      launch requirement. When the work is done, use More to
                      refresh, revise, or review safe removal.
                    </p>
                  </div>
                </li>
              </ol>
            </section>

            <aside
              className={styles.guideNotes}
              data-ui="guide.notes"
              data-ui-label="Guide notes"
            >
              <section className={styles.guideSafety}>
                <span>
                  <Glyph name="refresh" size={16} />
                </span>
                <div>
                  <h3>Retries are safe</h3>
                  <p>
                    Saving or creating again reuses the existing verified
                    result. After a restart, WTS reloads the manifest instead of
                    creating duplicate worktrees.
                  </p>
                </div>
              </section>
              <section>
                <h3>If something changed outside WTS</h3>
                <p>
                  WTS stops when a branch, worktree, or generated file no longer
                  matches its record. Resolve the drift before trying again; it
                  will not overwrite the unknown state.
                </p>
              </section>
              <section>
                <h3>Useful shortcuts</h3>
                <dl className={styles.guideShortcuts}>
                  <div>
                    <dt>Find a workspace</dt>
                    <dd>
                      <kbd>⌘</kbd>
                      <kbd>K</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>Open Environment &amp; integrations</dt>
                    <dd>
                      <kbd>⌘</kbd>
                      <kbd>,</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>Go back</dt>
                    <dd>
                      <kbd>⌘</kbd>
                      <kbd>[</kbd>
                    </dd>
                  </div>
                  <div>
                    <dt>Go forward</dt>
                    <dd>
                      <kbd>⌘</kbd>
                      <kbd>]</kbd>
                    </dd>
                  </div>
                </dl>
                <small>
                  On Linux, use Ctrl for commands. Use Alt with the left or
                  right arrow for history.
                </small>
              </section>
            </aside>
          </div>

          <footer className={styles.guideFooter}>
            <span>
              Runtime services, ports, terminals, and aggregated diffs are
              planned capabilities.
            </span>
            <div>
              <Dialog.Close className={styles.secondaryButton}>
                Close
              </Dialog.Close>
              <button
                className={styles.primaryButton}
                onClick={startWorkspace}
                type="button"
              >
                <Glyph name="plus" size={15} />
                New workspace
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

export const HowToGuide = GuideDialog;
