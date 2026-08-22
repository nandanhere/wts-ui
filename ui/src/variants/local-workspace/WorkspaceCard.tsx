import { memo } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button, type ButtonProps } from "react-aria-components";
import { Glyph } from "./Glyph";
import type { GitlabMergeRequest } from "../../lib/wtsClient";
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
  agent?: WorkspaceAgentSnapshot;
  onOpen: (modified: boolean) => void;
  primaryActionLabel?: string;
  issueAction?: {
    label: string;
    onPress: () => void;
  };
  mergeRequests?: readonly GitlabMergeRequest[];
  moveActions?: Array<{
    label: string;
    onPress: () => void;
  }>;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  dragProps?: Omit<ButtonProps, "children" | "className" | "onPress">;
}

export const WorkspaceCard = memo(function WorkspaceCard({
  workspace,
  agent,
  onOpen,
  primaryActionLabel,
  issueAction,
  mergeRequests = [],
  moveActions = [],
  buttonRef,
  dragProps,
}: WorkspaceCardProps) {
  const observedIssueItems = workspace.observedWorkItems.filter(
    (item) => item.issueKey !== workspace.key,
  );
  const showsIdentity =
    workspace.kind !== "Repositories" || observedIssueItems.length > 0;
  const sourceLabel = agent?.observedLocally
    ? "VS Code session"
    : workspace.provider;
  const hasActions = moveActions.length > 0;
  const orderedMergeRequests = [...mergeRequests].sort((left, right) => {
    const statusPriority = { open: 0, merged: 1, closed: 2 } as const;
    return (
      statusPriority[left.status] - statusPriority[right.status] ||
      right.updatedAt.localeCompare(left.updatedAt)
    );
  });
  const primaryMergeRequest = orderedMergeRequests[0];
  const mergeRequestLabel = primaryMergeRequest
    ? `${primaryMergeRequest.draft ? "Draft " : ""}MR !${primaryMergeRequest.iid} · ${primaryMergeRequest.status[0]!.toUpperCase()}${primaryMergeRequest.status.slice(1)}`
    : "";
  const cardContents = (
    <>
      <span className={styles.cardHeader}>
        <strong className={styles.issueTitle}>{workspace.title}</strong>
        <span className={styles.cardTime}>{workspace.updated}</span>
      </span>
      {showsIdentity && (
        <span className={styles.cardIdentity}>
          {workspace.kind !== "Repositories" &&
            (issueAction ? (
              <Button
                aria-label={issueAction.label}
                className={styles.cardIssueLink}
                onPress={issueAction.onPress}
              >
                <span>{workspace.key}</span>
                <Glyph name="external" size={12} />
              </Button>
            ) : (
              <span className={styles.issueKey}>{workspace.key}</span>
            ))}
          {observedIssueItems.map((item) => (
            <InfoTooltip
              key={item.issueKey}
              content={`Observed in ${item.sourceFiles.join(", ")}`}
            >
              <span className={styles.issueKey} tabIndex={0} role="note">
                {item.issueKey}
              </span>
            </InfoTooltip>
          ))}
        </span>
      )}
      {primaryMergeRequest && (
        <span
          className={styles.cardDelivery}
          data-status={primaryMergeRequest.status}
        >
          <Glyph name="branch" size={13} />
          <b>{mergeRequestLabel}</b>
          {orderedMergeRequests.length > 1 && (
            <span>+{orderedMergeRequests.length - 1} more</span>
          )}
        </span>
      )}
      {agent && (
        <span className={styles.cardAgent} data-state={agent.state}>
          <span className={styles.cardAgentMain}>
            <span className={styles.cardAgentStatus}>
              <i aria-hidden="true" />
              <b>
                {agent.updateKind === "completion" && !agent.observedLocally
                  ? `${agentProviderLabels[agent.provider]} finished`
                  : agent.headline}
              </b>
            </span>
          </span>
          {agent.latestUpdate && (
            <span className={styles.cardAgentUpdate}>
              <span>{agent.latestUpdate}</span>
            </span>
          )}
          <span className={styles.cardAgentDetail}>
            {(agent.updateKind !== "completion" || agent.observedLocally) && (
              <span>{agent.activity}</span>
            )}
          </span>
        </span>
      )}
      {!agent && (
        <span className={styles.cardSummary}>
          <StateDot state={workspace.lane} />
          {workspace.summary}
        </span>
      )}
      <span className={styles.cardFooter}>
        <span className={styles.providerMeta}>{sourceLabel}</span>
        <span className={styles.cardArrow} aria-hidden="true">
          <Glyph name="arrow" size={15} />
        </span>
      </span>
    </>
  );

  return (
    <article
      className={styles.workspaceCardShell}
      data-has-actions={hasActions || undefined}
      data-lane={workspace.lane}
      data-delivery-status={primaryMergeRequest?.status}
    >
      {issueAction ? (
        <div className={styles.workspaceCard}>
          <Button
            {...dragProps}
            aria-label={
              primaryActionLabel ?? `Open ${workspace.key}: ${workspace.title}`
            }
            className={styles.workspaceCardHitArea}
            onPress={(event) => onOpen(event.metaKey || event.ctrlKey)}
            ref={buttonRef}
          />
          {cardContents}
        </div>
      ) : (
        <Button
          {...dragProps}
          aria-label={
            primaryActionLabel ?? `Open ${workspace.key}: ${workspace.title}`
          }
          className={styles.workspaceCard}
          onPress={(event) => onOpen(event.metaKey || event.ctrlKey)}
          ref={buttonRef}
        >
          {cardContents}
        </Button>
      )}
      {hasActions && (
        <div
          aria-label={`${workspace.key} actions`}
          className={styles.cardActions}
          role="group"
        >
          {moveActions.length > 0 && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button
                  aria-label={`Move ${workspace.key}`}
                  className={`${styles.cardActionButton} ${styles.cardMoveButton}`}
                >
                  Move
                  <Glyph name="chevron" size={12} />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="start"
                  className={`${styles.portalSurface} ${styles.menuContent}`}
                  sideOffset={5}
                >
                  <DropdownMenu.Label className={styles.menuLabel}>
                    Move workspace
                  </DropdownMenu.Label>
                  {moveActions.map((action) => (
                    <DropdownMenu.Item
                      className={styles.menuItem}
                      key={action.label}
                      onSelect={action.onPress}
                    >
                      {action.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
      )}
    </article>
  );
});
