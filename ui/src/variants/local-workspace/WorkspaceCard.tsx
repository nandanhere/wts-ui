import { memo, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button, ToggleButton, type ButtonProps } from "react-aria-components";
import { Glyph } from "./Glyph";
import type { GitlabMergeRequest, GitlabReview } from "../../lib/wtsClient";
import {
  type Workspace,
  type WorkspaceAgentSnapshot,
  agentProviderLabels,
  InfoTooltip,
  StateDot,
} from "./LocalWorkspace";
import styles from "./LocalWorkspace.module.css";

export interface WorkspaceCardProps {
  workspace: Workspace;
  /** Compact aggregate badges, such as failed checks or unread comments. */
  attention?: ReactNode;
  agent?: WorkspaceAgentSnapshot;
  /** The primary action. It opens the workspace or its configured tool. */
  onOpen: (modified: boolean) => void;
  /** A click on the card surface opens the inspector. Without it, the surface uses onOpen. */
  onPreview?: () => void;
  onOpenWorkspace?: () => void;
  primaryActionLabel?: string;
  issueAction?: {
    label: string;
    onPress: () => void;
  };
  mergeRequests?: readonly GitlabMergeRequest[];
  gitlabReview?: GitlabReview;
  onOpenMergeRequest?: (mergeRequest: GitlabMergeRequest) => void;
  moveActions?: Array<{
    label: string;
    onPress: () => void;
  }>;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  dragProps?: Omit<ButtonProps, "children" | "className" | "onPress">;
  /** Pinned cards keep their lane and position. Agent and GitLab activity do not move them. */
  pin?: {
    pinned: boolean;
    disabled?: boolean;
    onToggle: () => void;
  };
}

export interface WorkspaceNextStep {
  label: string;
  tone: "action" | "wait" | "done";
}

/** The one thing the user can do next on this card. The label is an instruction or an agent status. */
export function workspaceNextStep(
  workspace: Pick<Workspace, "lane">,
  agent?: Pick<WorkspaceAgentSnapshot, "state" | "needsInput" | "updateKind" | "observedLocally">,
  gitlabReview?: Pick<GitlabReview, "status" | "reviewState">,
  mergeRequest?: Pick<GitlabMergeRequest, "status">,
): WorkspaceNextStep | undefined {
  if (agent?.needsInput === "question") return { label: "Answer the agent", tone: "action" };
  if (agent?.needsInput === "access") return { label: "Give the agent access", tone: "action" };
  if (agent?.state === "attention") return { label: "Review the agent session", tone: "action" };
  if (gitlabReview?.status === "open" && gitlabReview.reviewState === "changesAfterApproval") return { label: "Review the new changes", tone: "action" };
  if (gitlabReview?.status === "open" && gitlabReview.reviewState !== "approved") return { label: "Review the MR", tone: "action" };
  if (agent?.state === "working") return { label: "View progress", tone: "wait" };
  if (agent?.updateKind === "completion" && !agent.observedLocally) return { label: "Check the agent result", tone: "action" };
  if (mergeRequest?.status === "merged" || gitlabReview?.status === "merged") return { label: "Park or remove", tone: "done" };
  if (workspace.lane === "planned") return { label: "Start the work", tone: "action" };
  return undefined;
}

export type AgentStatusTone = "working" | "attention" | "done" | "idle";

/** A short agent status for the card pill: provider and state. */
export function agentStatus(agent: WorkspaceAgentSnapshot): { label: string; tone: AgentStatusTone } {
  const provider = agentProviderLabels[agent.provider];
  if (agent.needsInput === "question") return { label: provider + ": Needs your answer", tone: "attention" };
  if (agent.needsInput === "access") return { label: provider + ": Needs access", tone: "attention" };
  if (agent.state === "attention") return { label: provider + ": Needs attention", tone: "attention" };
  if (agent.state === "working") return { label: provider + ": Working", tone: "working" };
  if (agent.updateKind === "completion" && !agent.observedLocally) return { label: provider + ": Finished", tone: "done" };
  if (agent.observedLocally) return { label: provider + ": Open in VS Code", tone: "idle" };
  return { label: provider + ": Idle", tone: "idle" };
}

/** Sorts open merge requests first, then by the latest update. */
export function orderedMergeRequests(mergeRequests: readonly GitlabMergeRequest[]) {
  const statusPriority = { open: 0, merged: 1, closed: 2 } as const;
  return [...mergeRequests].sort((left, right) =>
    statusPriority[left.status] - statusPriority[right.status] ||
    right.updatedAt.localeCompare(left.updatedAt));
}

export function mergeRequestStatusLabel(mergeRequest: GitlabMergeRequest, gitlabReview?: GitlabReview) {
  if (mergeRequest.status === "merged") return "Merged";
  if (mergeRequest.status === "closed") return "Closed";
  if (gitlabReview?.reviewState === "changesAfterApproval") return "New changes";
  if (gitlabReview?.reviewState === "approved") return "Approved";
  return mergeRequest.draft ? "Draft" : "Open";
}

export const WorkspaceCard = memo(function WorkspaceCard({
  workspace,
  attention,
  agent,
  onOpen,
  onPreview,
  onOpenWorkspace,
  primaryActionLabel,
  issueAction,
  mergeRequests = [],
  gitlabReview,
  onOpenMergeRequest,
  moveActions = [],
  buttonRef,
  dragProps,
  pin,
}: WorkspaceCardProps) {
  const ordered = orderedMergeRequests(mergeRequests);
  const primaryMergeRequest = ordered[0];
  const nextStep = workspaceNextStep(workspace, agent, gitlabReview, primaryMergeRequest);
  const status = agent ? agentStatus(agent) : undefined;
  const openLabel = primaryActionLabel ?? "Open " + workspace.key + ": " + workspace.title;
  const ctaText = nextStep && nextStep.tone !== "done" ? nextStep.label : "Open workspace";
  const repository = workspace.repositoryPlans[0];
  const hasMenu = Boolean(onOpenWorkspace || issueAction || moveActions.length);

  return (
    <article
      className={styles.workspaceCardShell}
      data-has-actions="true"
      data-pinnable={pin ? true : undefined}
      data-pinned={pin?.pinned || undefined}
      data-lane={workspace.lane}
      data-delivery-status={primaryMergeRequest?.status}
    >
      <Button
        {...dragProps}
        aria-label={onPreview ? "Preview " + workspace.key + ": " + workspace.title : openLabel}
        className={styles.workspaceCardHitArea}
        onPress={(event) => (onPreview ? onPreview() : onOpen(event.metaKey || event.ctrlKey))}
        ref={onPreview ? undefined : buttonRef}
      />
      <div className={styles.workspaceCard}>
        <header className={styles.cardHeader}>
          <strong className={styles.issueTitle}>{workspace.title}</strong>
          <span className={styles.cardTime}>{workspace.updated}</span>
          {pin && (
            <InfoTooltip
              align="end"
              content={pin.pinned
                ? "Pinned. The card stays in this position. Click to unpin."
                : "Pin the card to keep it in this position."}
            >
              <ToggleButton
                aria-label={"Pin " + workspace.key}
                className={styles.cardPinToggle}
                data-ui={"spaces.pin." + workspace.id}
                data-ui-label={workspace.key + " pin"}
                isDisabled={pin.disabled}
                isSelected={pin.pinned}
                onChange={pin.onToggle}
              >
                <Glyph name="pin" size={14} />
              </ToggleButton>
            </InfoTooltip>
          )}
        </header>

        <div className={styles.cardContext}>
          {primaryMergeRequest ? (
            <span className={styles.cardDelivery} data-status={primaryMergeRequest.status}>
              <Glyph name="branch" size={13} />
              {onOpenMergeRequest ? (
                <a
                  aria-label={"Open merge request !" + primaryMergeRequest.iid + " in GitLab"}
                  className={styles.cardMergeRequestLink}
                  href={primaryMergeRequest.webUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenMergeRequest(primaryMergeRequest);
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  MR !{primaryMergeRequest.iid}
                </a>
              ) : (
                <b>MR !{primaryMergeRequest.iid}</b>
              )}
              <b className={styles.cardMergeRequestStatus}>
                {mergeRequestStatusLabel(primaryMergeRequest, gitlabReview)}
              </b>
              {ordered.length > 1 && <span>+{ordered.length - 1}</span>}
            </span>
          ) : workspace.kind !== "Repositories" ? (
            issueAction ? (
              <Button aria-label={issueAction.label} className={styles.cardIssueLink} onPress={issueAction.onPress}>
                <span>{workspace.key}</span>
                <Glyph name="external" size={11} />
              </Button>
            ) : (
              <span className={styles.issueKey}>{workspace.key}</span>
            )
          ) : repository ? (
            <span className={styles.cardBranch}>
              <Glyph name="branch" size={13} />
              <code>{repository.label}</code>
              {workspace.repositoryPlans.length > 1 && <span>+{workspace.repositoryPlans.length - 1}</span>}
            </span>
          ) : null}
        </div>

        <div className={styles.cardSignals}>
          {status ? (
            <span className={styles.cardAgentPill} data-tone={status.tone}>
              <i aria-hidden="true" />
              {status.label}
            </span>
          ) : (
            <span className={styles.cardSummary}>
              <StateDot state={workspace.lane} />
              {workspace.summary}
            </span>
          )}
          {attention}
        </div>
      </div>

      <footer aria-label={workspace.key + " actions"} className={styles.cardActions} role="group">
        <Button
          aria-label={openLabel}
          className={styles.cardPrimaryAction}
          data-tone={nextStep?.tone === "action" ? "action" : "quiet"}
          onPress={(event) => onOpen(event.metaKey || event.ctrlKey)}
          ref={onPreview ? buttonRef : undefined}
        >
          {ctaText}
          <Glyph name="arrow" size={13} />
        </Button>
        {hasMenu && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button aria-label={"More actions for " + workspace.key} className={styles.cardMenuButton}>
                <Glyph name="more" size={16} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                className={styles.portalSurface + " " + styles.menuContent}
                sideOffset={5}
              >
                {onOpenWorkspace && (
                  <DropdownMenu.Item className={styles.menuItem} onSelect={onOpenWorkspace}>
                    <Glyph name="code" size={14} /> Open in VS Code
                  </DropdownMenu.Item>
                )}
                {issueAction && (
                  <DropdownMenu.Item className={styles.menuItem} onSelect={issueAction.onPress}>
                    <Glyph name="external" size={14} /> {issueAction.label}
                  </DropdownMenu.Item>
                )}
                {moveActions.length > 0 && (onOpenWorkspace || issueAction) && (
                  <DropdownMenu.Separator className={styles.menuSeparator} />
                )}
                {moveActions.length > 0 && (
                  <DropdownMenu.Label className={styles.menuLabel}>Move workspace</DropdownMenu.Label>
                )}
                {moveActions.map((action) => (
                  <DropdownMenu.Item className={styles.menuItem} key={action.label} onSelect={action.onPress}>
                    {action.label}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </footer>
    </article>
  );
});
