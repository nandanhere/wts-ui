import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { WorkspaceClientError } from "../../lib/wtsClient";
import type {
  JiraCreateProposal,
  WorkspaceClient,
  WorkspaceWorkItemLink,
  WorkspaceWorkItemLinkPreview,
  WorkspaceWorkItemRole,
} from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import styles from "./WorkspaceWorkItemsPanel.module.css";

type LoadState = "loading" | "ready" | "error";
type ActionState = "idle" | "working" | "error";

export interface WorkspaceWorkItemsPanelProps {
  client: WorkspaceClient;
  workspaceId: string;
  workspaceKey: string;
  deliveryLabel?: string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  onOpenIntegrations?: () => void;
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function safeJiraBrowserUrl(value: string | undefined, issueKey: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const expectedIssueKey = issueKey.trim().toUpperCase();
    if (
      url.protocol !== "https:" ||
      !url.hostname.includes(".") ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      pathSegments.length < 2 ||
      pathSegments.at(-2) !== "browse" ||
      pathSegments.at(-1) !== expectedIssueKey
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function roleLabel(role: WorkspaceWorkItemRole) {
  if (role === "primary") return "Primary";
  if (role === "createdFromWorkspace") return "Created from workspace";
  return "Related";
}

function LinkSummary({
  link,
  deliveryLabel,
  onOpen,
}: {
  link: WorkspaceWorkItemLink;
  deliveryLabel?: string;
  onOpen: () => void;
}) {
  const browserUrl = safeJiraBrowserUrl(
    link.snapshot.browserUrl,
    link.snapshot.issueKey,
  );
  return (
    <>
      <span className={styles.issueCell} role="cell">
        <span className={styles.jiraBadge}>Jira</span>
        <span className={styles.issueCopy}>
          <strong>{link.snapshot.issueKey}</strong>
          {browserUrl ? (
            <a
              aria-label={`Open Jira issue ${link.snapshot.issueKey}: ${link.snapshot.summary ?? link.snapshot.issueKey}`}
              className={styles.issueTitle}
              href={browserUrl}
              onClick={(event) => {
                event.preventDefault();
                onOpen();
              }}
            >
              {link.snapshot.summary ?? link.snapshot.issueKey}
              <Glyph name="external" size={11} />
            </a>
          ) : (
            <span className={styles.issueSummary}>
              {link.snapshot.summary ?? "No summary available"}
            </span>
          )}
        </span>
      </span>
      <span className={styles.statusCell} role="cell">
        <span>{link.snapshot.status ?? "Status unavailable"}</span>
        {deliveryLabel && (
          <small className={styles.deliveryStatus}>{deliveryLabel}</small>
        )}
      </span>
      <span className={styles.roleCell} role="cell">
        {roleLabel(link.role)}
      </span>
    </>
  );
}

export function WorkspaceWorkItemsPanel({
  client,
  workspaceId,
  workspaceKey,
  deliveryLabel,
  onNotice,
  onOpenIntegrations,
}: WorkspaceWorkItemsPanelProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [links, setLinks] = useState<WorkspaceWorkItemLink[]>([]);
  const [adding, setAdding] = useState(false);
  const [issueKey, setIssueKey] = useState("");
  const [role, setRole] = useState<WorkspaceWorkItemRole>("primary");
  const [preview, setPreview] = useState<WorkspaceWorkItemLinkPreview | null>(null);
  const [previewState, setPreviewState] = useState<ActionState>("idle");
  const [previewError, setPreviewError] = useState("");
  const [linkState, setLinkState] = useState<ActionState>("idle");
  const [linkError, setLinkError] = useState("");
  const [linkErrorCode, setLinkErrorCode] = useState("");
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [unlinkChecked, setUnlinkChecked] = useState(false);
  const [unlinkState, setUnlinkState] = useState<ActionState>("idle");
  const [unlinkError, setUnlinkError] = useState("");
  const [proposal, setProposal] = useState<JiraCreateProposal | null>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalState, setProposalState] = useState<ActionState>("idle");
  const [proposalError, setProposalError] = useState("");
  const [openError, setOpenError] = useState("");
  const [openErrorSource, setOpenErrorSource] = useState<"linked" | "preview">("linked");
  const inputRef = useRef<HTMLInputElement>(null);
  const listGeneration = useRef(0);
  const proposalGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const workspaceGeneration = useRef(0);
  const linkIdempotencyKey = useRef<string | null>(null);

  const reloadLinks = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoadState("loading");
    setLoadError("");
    try {
      const result = await client.listWorkspaceWorkItemLinks(workspaceId);
      if (generation !== listGeneration.current) return;
      setLinks(result.links);
      setLoadState("ready");
    } catch (error) {
      if (generation !== listGeneration.current) return;
      setLoadError(messageFor(error, "WTS could not load the linked work items."));
      setLoadState("error");
    }
  }, [client, workspaceId]);

  useEffect(() => {
    workspaceGeneration.current += 1;
    setLinks([]);
    setAdding(false);
    setIssueKey("");
    setPreview(null);
    setPreviewState("idle");
    setPreviewError("");
    setLinkState("idle");
    setLinkError("");
    setLinkErrorCode("");
    setUnlinkingId(null);
    setUnlinkChecked(false);
    setUnlinkState("idle");
    setUnlinkError("");
    setProposal(null);
    setProposalOpen(false);
    setProposalState("idle");
    setProposalError("");
    setOpenError("");
    void reloadLinks();
    return () => {
      workspaceGeneration.current += 1;
      listGeneration.current += 1;
      proposalGeneration.current += 1;
      previewGeneration.current += 1;
      linkIdempotencyKey.current = null;
    };
  }, [reloadLinks, workspaceKey]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const resetPreview = useCallback(() => {
    previewGeneration.current += 1;
    setPreview(null);
    setPreviewState("idle");
    setPreviewError("");
    setLinkState("idle");
    setLinkError("");
    linkIdempotencyKey.current = null;
  }, []);

  const openAdd = () => {
    setAdding(true);
    setIssueKey("");
    setRole(links.some((link) => link.role === "primary") ? "related" : "primary");
    resetPreview();
  };

  const requestPreview = async () => {
    const generation = ++previewGeneration.current;
    const workspaceRequestGeneration = workspaceGeneration.current;
    setPreviewState("working");
    setPreviewError("");
    setPreview(null);
    setLinkError("");
    setLinkErrorCode("");
    setLinkState("idle");
    linkIdempotencyKey.current = null;
    try {
      const result = await client.previewWorkspaceJiraLink(workspaceId, issueKey, role);
      if (
        generation !== previewGeneration.current ||
        workspaceRequestGeneration !== workspaceGeneration.current
      ) return;
      setPreview(result);
      setIssueKey(result.snapshot.issueKey);
      setPreviewState("idle");
    } catch (error) {
      if (
        generation !== previewGeneration.current ||
        workspaceRequestGeneration !== workspaceGeneration.current
      ) return;
      setPreviewError(messageFor(error, "WTS could not preview this Jira issue."));
      setPreviewState("error");
    }
  };

  const confirmLink = async () => {
    if (!preview || linkState === "working") return;
    setLinkState("working");
    setLinkError("");
    const workspaceRequestGeneration = workspaceGeneration.current;
    try {
      if (typeof globalThis.crypto?.randomUUID !== "function") {
        throw new Error("WTS could not create a safe retry key.");
      }
      linkIdempotencyKey.current ??= globalThis.crypto.randomUUID();
      const result = await client.confirmWorkspaceJiraLink(
        workspaceId,
        preview.snapshot.issueKey,
        preview.role,
        preview.previewDigest,
        linkIdempotencyKey.current,
      );
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setLinks((current) => [
        result.link,
        ...current.filter((link) => link.linkId !== result.link.linkId),
      ]);
      setAdding(false);
      setPreview(null);
      setLinkState("idle");
      linkIdempotencyKey.current = null;
      onNotice?.(`${result.link.snapshot.issueKey} linked to ${workspaceKey}`);
    } catch (error) {
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setLinkError(messageFor(error, "WTS could not link this Jira issue."));
      setLinkErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setLinkState("error");
    }
  };

  const confirmUnlink = async (link: WorkspaceWorkItemLink) => {
    if (!unlinkChecked || unlinkState === "working") return;
    setUnlinkState("working");
    setUnlinkError("");
    const workspaceRequestGeneration = workspaceGeneration.current;
    try {
      await client.unlinkWorkspaceWorkItem(workspaceId, link.linkId, link.revision);
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setLinks((current) => current.filter((item) => item.linkId !== link.linkId));
      setUnlinkingId(null);
      setUnlinkChecked(false);
      setUnlinkState("idle");
      onNotice?.(`${link.snapshot.issueKey} unlinked from ${workspaceKey}`);
    } catch (error) {
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setUnlinkError(messageFor(error, "WTS could not unlink this work item."));
      setUnlinkState("error");
      onNotice?.("The work item was not unlinked", "error");
    }
  };

  const loadProposal = async () => {
    const generation = ++proposalGeneration.current;
    const workspaceRequestGeneration = workspaceGeneration.current;
    setProposalState("working");
    setProposalError("");
    try {
      const result = await client.proposeWorkspaceJiraIssue(workspaceId);
      if (
        generation !== proposalGeneration.current ||
        workspaceRequestGeneration !== workspaceGeneration.current
      ) return;
      setProposal(result);
      setProposalState("idle");
    } catch (error) {
      if (
        generation !== proposalGeneration.current ||
        workspaceRequestGeneration !== workspaceGeneration.current
      ) return;
      setProposalError(messageFor(error, "WTS could not prepare the Jira proposal."));
      setProposalState("error");
    }
  };

  const copyProposal = async () => {
    if (!proposal) return;
    setProposalError("");
    try {
      await navigator.clipboard.writeText(`${proposal.summary}\n\n${proposal.description}`);
      onNotice?.("Jira draft copied");
    } catch {
      setProposalError("Clipboard access failed. Select and copy the summary and description below.");
      onNotice?.("The Jira proposal was not copied", "error");
    }
  };

  const openLinkedJira = async (link: WorkspaceWorkItemLink) => {
    const workspaceRequestGeneration = workspaceGeneration.current;
    setOpenError("");
    setOpenErrorSource("linked");
    try {
      await client.openWorkspaceWorkItem(workspaceId, link.linkId, link.revision);
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
    } catch (error) {
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setOpenError(messageFor(error, "WTS could not open this Jira issue."));
    }
  };

  const openPreviewJira = async (item: WorkspaceWorkItemLinkPreview) => {
    const workspaceRequestGeneration = workspaceGeneration.current;
    setOpenError("");
    setOpenErrorSource("preview");
    try {
      await client.openWorkspaceJiraPreview(
        workspaceId,
        item.snapshot.issueKey,
        item.role,
        item.previewDigest,
      );
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
    } catch (error) {
      if (workspaceRequestGeneration !== workspaceGeneration.current) return;
      setOpenError(messageFor(error, "WTS could not open this Jira issue."));
    }
  };

  const hasNoLinkedItems = loadState === "ready" && links.length === 0;
  const compact = !adding && !proposalOpen && unlinkingId === null;

  return (
    <section
      className={styles.panel}
      aria-labelledby="work-items-heading"
      data-compact={compact || undefined}
      data-ui="work-items.panel"
      data-ui-label="Work items panel"
    >
      <header
        className={styles.header}
        data-ui="work-items.header"
        data-ui-label="Work items header"
      >
        <div>
          <p className={styles.eyebrow}>Work items</p>
          <h2 id="work-items-heading">Linked Jira issues</h2>
        </div>
        <div className={styles.headerActions}>
          {links.length > 0 ? (
            <span className={styles.linkCount}>{links.length} linked</span>
          ) : null}
          <button className={styles.primaryButton} type="button" onClick={openAdd}>
            Add Jira
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                aria-label="More work item actions"
                className={styles.moreButton}
                type="button"
              >
                <Glyph name="more" size={16} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                className={styles.menuContent}
                sideOffset={6}
              >
                <DropdownMenu.Item
                  className={styles.menuItem}
                  onSelect={() => setProposalOpen(true)}
                >
                  <Glyph name="copy" size={14} />
                  Draft a Jira issue…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>

      {loadState === "loading" ? <p className={styles.state}>Loading work items…</p> : null}
      {loadState === "error" ? (
        <div className={styles.error} role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={() => void reloadLinks()}>Try again</button>
        </div>
      ) : null}
      {links.length > 0 ? (
        <div
          className={styles.linkList}
          aria-label="Linked work items"
          data-ui="work-items.linked-list"
          data-ui-label="Linked work items"
          role="table"
        >
          <div className={styles.linkTableHeader} role="row">
            <span role="columnheader">Issue</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Relationship</span>
            <span aria-label="Actions" role="columnheader" />
          </div>
          {links.map((link) => (
            <div className={styles.linkGroup} key={link.linkId} role="rowgroup">
              <div
                className={styles.linkRow}
                data-testid={`work-item-${link.linkId}`}
                role="row"
              >
                <LinkSummary
                  deliveryLabel={deliveryLabel}
                  link={link}
                  onOpen={() => void openLinkedJira(link)}
                />
                <span className={styles.rowActions} role="cell">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        aria-label={`More actions for ${link.snapshot.issueKey}`}
                        className={styles.rowMoreButton}
                        type="button"
                      >
                        <Glyph name="more" size={15} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        className={styles.menuContent}
                        sideOffset={6}
                      >
                        <DropdownMenu.Item
                          className={styles.menuItem}
                          onSelect={() => {
                            setUnlinkingId(link.linkId);
                            setUnlinkChecked(false);
                            setUnlinkError("");
                          }}
                        >
                          Unlink Jira issue…
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </span>
              </div>
              {unlinkingId === link.linkId ? (
                <div className={styles.unlinkConfirm} role="group" aria-label={`Unlink ${link.snapshot.issueKey}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={unlinkChecked}
                      onChange={(event) => setUnlinkChecked(event.currentTarget.checked)}
                    />
                    I understand that this removes only the link.
                  </label>
                  {unlinkError ? <div role="alert"><p>{unlinkError}</p><button onClick={() => { setUnlinkingId(null); setUnlinkChecked(false); void reloadLinks(); }} type="button">Refresh linked issues</button></div> : null}
                  <div className={styles.actionRow}>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      disabled={!unlinkChecked || unlinkState === "working"}
                      onClick={() => void confirmUnlink(link)}
                    >
                      {unlinkState === "working" ? "Unlinking…" : "Unlink Jira"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUnlinkingId(null);
                        setUnlinkChecked(false);
                        setUnlinkError("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : hasNoLinkedItems ? (
        <p className={styles.empty}>No Jira issue is linked to this workspace.</p>
      ) : null}
      {openError ? <div className={styles.errorText} role="alert">
        <p>{openError}</p>
        <button type="button" onClick={() => { setOpenError(""); if (openErrorSource === "preview") void requestPreview(); else void reloadLinks(); }}>
          {openErrorSource === "preview" ? "Refresh Jira preview" : "Refresh linked issues"}
        </button>
        {onOpenIntegrations && <button type="button" onClick={onOpenIntegrations}>Check Jira connection</button>}
      </div> : null}

      {adding ? (
        <div
          className={styles.addPanel}
          aria-labelledby="add-jira-heading"
          data-ui="work-items.link-form"
          data-ui-label="Jira link form"
        >
          <div className={styles.subhead}>
            <div>
              <h3 id="add-jira-heading">Link a Jira issue</h3>
              <p>Preview the imported issue before you link it.</p>
            </div>
            <button type="button" aria-label="Close Jira link form" onClick={() => setAdding(false)}>Close</button>
          </div>
          <div className={styles.formGrid}>
            <label>
              Jira issue key
              <input
                ref={inputRef}
                value={issueKey}
                placeholder="PLATFORM-42"
                autoComplete="off"
                onChange={(event) => {
                  setIssueKey(event.currentTarget.value);
                  resetPreview();
                }}
              />
            </label>
            <fieldset>
              <legend>Relationship</legend>
              <label>
                <input
                  type="radio"
                  name="work-item-role"
                  value="primary"
                  checked={role === "primary"}
                  disabled={links.some((link) => link.role === "primary")}
                  onChange={() => {
                    setRole("primary");
                    resetPreview();
                  }}
                />
                Primary
              </label>
              <label>
                <input
                  type="radio"
                  name="work-item-role"
                  value="related"
                  checked={role === "related"}
                  onChange={() => {
                    setRole("related");
                    resetPreview();
                  }}
                />
                Related
              </label>
            </fieldset>
          </div>
          <button
            className={styles.secondaryButton}
            type="button"
            disabled={!issueKey.trim() || previewState === "working" || linkState === "working"}
            onClick={() => void requestPreview()}
          >
            {previewState === "working" ? "Loading preview…" : "Preview Jira issue"}
          </button>
          {previewError ? <div className={styles.errorText} role="alert"><p>{previewError}</p>{onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check Jira connection</button>}</div> : null}

          {preview ? (
            <article
              className={styles.preview}
              aria-labelledby="jira-preview-heading"
              data-ui="work-items.jira-preview"
              data-ui-label="Jira issue preview"
            >
              <header>
                <div>
                  <span className={styles.jiraBadge}>Jira</span>
                  <h4 id="jira-preview-heading">{preview.snapshot.issueKey}</h4>
                </div>
                {safeJiraBrowserUrl(
                  preview.snapshot.browserUrl,
                  preview.snapshot.issueKey,
                ) ? (
                  <a
                    className={styles.linkButton}
                    href={preview.snapshot.browserUrl}
                    onClick={(event) => {
                      event.preventDefault();
                      void openPreviewJira(preview);
                    }}
                  >
                    Open Jira
                  </a>
                ) : null}
              </header>
              {preview.snapshot.summary ? <h5>{preview.snapshot.summary}</h5> : null}
              {preview.snapshot.status ? <p className={styles.status}>{preview.snapshot.status}</p> : null}
              <pre>{preview.snapshot.content}</pre>
              {linkError ? <div className={styles.errorText} role="alert"><p>{linkError}</p>
                {linkErrorCode === "stale_work_item_link_preview" || linkErrorCode === "work_item_link_idempotency_conflict" ? <button onClick={() => void requestPreview()} type="button">Refresh Jira preview</button> : <button onClick={() => void reloadLinks()} type="button">Refresh linked issues</button>}
                {onOpenIntegrations && <button onClick={onOpenIntegrations} type="button">Check Jira connection</button>}
              </div> : null}
              <div className={styles.actionRow}>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={linkState === "working" || ["stale_work_item_link_preview", "work_item_link_idempotency_conflict", "work_item_link_exists", "primary_work_item_link_exists"].includes(linkErrorCode)}
                  onClick={() => void confirmLink()}
                >
                  {linkState === "working" ? "Linking…" : "Link Jira issue"}
                </button>
                <span>This adds a link. It does not change the workspace intent.</span>
              </div>
            </article>
          ) : null}
        </div>
      ) : null}

      {proposalOpen ? (
        <div
          className={styles.proposalSection}
          aria-labelledby="jira-proposal-heading"
          data-ui="work-items.jira-draft"
          data-ui-label="Jira issue draft"
        >
          <div className={styles.subhead}>
            <div>
              <h3 id="jira-proposal-heading">Draft a Jira issue</h3>
              <p>Copy a draft from the workspace plan.</p>
            </div>
            <button
              type="button"
              aria-label="Close Jira issue draft"
              onClick={() => setProposalOpen(false)}
            >
              Close
            </button>
          </div>
          {!proposal ? (
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={proposalState === "working"}
              onClick={() => void loadProposal()}
            >
              {proposalState === "working" ? "Preparing draft…" : "Prepare draft"}
            </button>
          ) : null}
          {proposalError ? <p className={styles.errorText} role="alert">{proposalError}</p> : null}
          {proposal ? (
            <div className={styles.proposal}>
              {!proposal.canExecute ? (
                <p className={styles.proposalNote} role="status">
                  WTS cannot create this issue. {proposal.detail}
                </p>
              ) : null}
              <label>
                Summary
                <input readOnly value={proposal.summary} />
              </label>
              <label>
                Description
                <textarea readOnly rows={6} value={proposal.description} />
              </label>
              <button className={styles.secondaryButton} type="button" onClick={() => void copyProposal()}>
                Copy draft
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
