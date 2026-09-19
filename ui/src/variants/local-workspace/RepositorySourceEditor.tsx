import { isNativePreviewReadOnlyCode, nativePreviewAllowsCommand, NATIVE_PREVIEW_READ_ONLY_MESSAGE } from "../../lib/nativePreview";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { WorkspaceClientError, type WorkspaceClient, type WorkspaceRepositorySource } from "../../lib/wtsClient";
import styles from "./RepositorySourceEditor.module.css";

interface Draft {
  token: object;
  reading: boolean;
  source?: WorkspaceRepositorySource;
  newer?: WorkspaceRepositorySource;
  text: string;
  editing: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  errorCode: string;
  saved: boolean;
  request: number;
  mutation: number;
}
interface Store {
  drafts: Map<string, Draft>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => number;
  update: (key: string, update: (draft: Draft) => Draft) => void;
}
const stores = new WeakMap<WorkspaceClient, Store>();
const blank = (): Draft => ({ token: {}, reading: false, text: "", editing: false, loading: false, saving: false, error: "", errorCode: "", saved: false, request: 0, mutation: 0 });
function storeFor(client: WorkspaceClient): Store {
  const previous = stores.get(client);
  if (previous) return previous;
  const listeners = new Set<() => void>();
  let revision = 0;
  const store: Store = {
    drafts: new Map(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    update(key, update) {
      store.drafts.set(key, update(store.drafts.get(key) ?? blank()));
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
  stores.set(client, store);
  return store;
}
function sourceMatches(source: WorkspaceRepositorySource, workspaceId: string, repositoryId: string, filePath: string) {
  return source.workspaceId === workspaceId && source.repositoryId === repositoryId && source.filePath === filePath;
}

export function RepositorySourceEditor({ client, workspaceId, repositoryId, filePath, refreshToken, active, onSaved, embedded = false, onClose }: {
  client: WorkspaceClient;
  workspaceId: string;
  repositoryId: string;
  filePath: string;
  refreshToken: number;
  active: boolean;
  onSaved: () => void;
  embedded?: boolean;
  onClose?: () => void;
}) {
  const store = useMemo(() => storeFor(client), [client]);
  const key = JSON.stringify([workspaceId, repositoryId, filePath]);
  useSyncExternalStore(store.subscribe, store.snapshot);
  const [compare, setCompare] = useState(false);
  const [retry, setRetry] = useState(0);
  const [openError, setOpenError] = useState("");
  const [opening, setOpening] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const contextRef = useRef({ client, key });
  contextRef.current = { client, key };
  const record = store.drafts.get(key);
  const previewReadOnly = !nativePreviewAllowsCommand("save_workspace_repository_source") || isNativePreviewReadOnlyCode(record?.errorCode);
  const capacity = Boolean(record || store.drafts.size < 64 || [...store.drafts.values()].some((item) => !item.saving && !item.reading && (!item.source || item.text === item.source.content)));
  const dirty = Boolean(record?.source && record.text !== record.source.content);
  const externalEditorRequired = ["invalid_repository_file_path", "repository_file_unavailable", "repository_file_not_text", "repository_file_too_large", "repository_not_found"].includes(record?.errorCode ?? "");

  useEffect(() => { setOpenError(""); setOpening(false); setCopyState("idle"); }, [client, key]);
  const openWorkspace = async () => {
    setOpening(true);
    setOpenError("");
    try {
      const result = await client.openWorkspaceInVscode(workspaceId);
      if (!result.accepted || result.workspaceId !== workspaceId) throw new Error("WTS could not open this workspace in VS Code.");
    } catch (error) {
      if (contextRef.current.client === client && contextRef.current.key === key) setOpenError(error instanceof Error ? error.message : "Open VS Code, then open the saved workspace file.");
    } finally {
      if (contextRef.current.client === client && contextRef.current.key === key) setOpening(false);
    }
  };
  const copyDraft = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(record?.text ?? "");
      if (contextRef.current.client === client && contextRef.current.key === key) setCopyState("copied");
    } catch {
      if (contextRef.current.client === client && contextRef.current.key === key) setCopyState("error");
    }
  };

  useEffect(() => {
    setCompare(false);
  }, [client, key]);

  useEffect(() => {
    if (!capacity || !active) return;
    if (!store.drafts.has(key) && store.drafts.size >= 64) {
      const oldest = [...store.drafts].find(([, item]) => !item.saving && !item.reading && (!item.source || item.text === item.source.content));
      if (oldest) store.drafts.delete(oldest[0]);
    }
    if (!store.drafts.has(key)) store.update(key, () => ({ ...blank(), editing: embedded && nativePreviewAllowsCommand("save_workspace_repository_source") }));
    else if (embedded && nativePreviewAllowsCommand("save_workspace_repository_source") && !isNativePreviewReadOnlyCode(store.drafts.get(key)?.errorCode) && !store.drafts.get(key)!.editing) store.update(key, (draft) => ({ ...draft, editing: true }));
    const current = store.drafts.get(key)!;
    const token = current.token;
    const request = current.request + 1;
    const mutation = current.mutation;
    store.update(key, (draft) => ({ ...draft, request, reading: true, loading: !draft.source, error: draft.saving ? draft.error : "" }));
    void client.getWorkspaceRepositorySource(workspaceId, repositoryId, filePath).then((source) => {
      if (!sourceMatches(source, workspaceId, repositoryId, filePath)) throw new Error("WTS returned a different local file.");
      if (store.drafts.get(key)?.token !== token) return;
      store.update(key, (draft) => {
        if (draft.request !== request || draft.mutation !== mutation) return draft;
        if (draft.source && draft.text !== draft.source.content) {
          return { ...draft, reading: false, loading: false, newer: source.revision === draft.source.revision ? undefined : source };
        }
        return { ...draft, source, text: source.content, newer: undefined, reading: false, loading: false };
      });
    }).catch((error) => {
      if (store.drafts.get(key)?.token !== token) return;
      store.update(key, (draft) => draft.request !== request || draft.mutation !== mutation ? draft : { ...draft, reading: false, loading: false, error: error instanceof Error ? error.message : "WTS could not read the local file.", errorCode: error instanceof WorkspaceClientError ? error.code : "" });
    });
  }, [active, capacity, client, embedded, filePath, key, refreshToken, repositoryId, retry, store, workspaceId]);

  const save = async () => {
    const current = store.drafts.get(key);
    if (!nativePreviewAllowsCommand("save_workspace_repository_source") || isNativePreviewReadOnlyCode(current?.errorCode)) return;
    if (!current?.source || current.saving || current.text === current.source.content) return;
    const content = current.text;
    store.update(key, (draft) => ({ ...draft, reading: false, saving: true, saved: false, error: "", mutation: draft.mutation + 1 }));
    try {
      const source = await client.saveWorkspaceRepositorySource(workspaceId, repositoryId, { filePath, content, expectedRevision: current.source.revision });
      if (!sourceMatches(source, workspaceId, repositoryId, filePath)) throw new Error("WTS returned a different saved file.");
      store.update(key, (draft) => ({ ...draft, source, text: draft.text === content ? source.content : draft.text, newer: undefined, reading: false, loading: false, saving: false, saved: true, mutation: draft.mutation + 1 }));
      onSaved();
    } catch (error) {
      store.update(key, (draft) => ({ ...draft, saving: false, error: error instanceof Error ? error.message : "WTS could not save the local file.", errorCode: error instanceof WorkspaceClientError ? error.code : "" }));
      if (error instanceof WorkspaceClientError && error.code === "repository_file_conflict") {
        const recovery = store.drafts.get(key)!;
        try {
          const newer = await client.getWorkspaceRepositorySource(workspaceId, repositoryId, filePath);
          if (sourceMatches(newer, workspaceId, repositoryId, filePath) && store.drafts.get(key)?.token === recovery.token && store.drafts.get(key)?.mutation === recovery.mutation) store.update(key, (draft) => ({ ...draft, newer }));
        } catch { /* Keep the draft and the save error when the newer file is unavailable. */ }
      }
    }
  };

  return <section className={`${styles.editor} ${embedded ? styles.embedded : ""}`} aria-label="Latest local file" data-ui="changes.local-editor" data-ui-label="Local file editor">
    <header><div><strong>{embedded && !previewReadOnly ? "Edit local file" : "Latest local file"}</strong><span title={filePath}>{filePath}</span></div>
      {!previewReadOnly && !embedded && record?.source && !record.editing && <button onClick={() => store.update(key, (draft) => ({ ...draft, editing: true, saved: false }))} type="button">Edit locally</button>}
      {(record?.editing || embedded) && <>{!previewReadOnly && <button disabled={record?.saving || !dirty} onClick={() => void save()} type="button">{record?.saving ? "WTS saves the file" : "Save local file"}</button>}<button disabled={record?.saving} onClick={() => { if (onClose) onClose(); else store.update(key, (draft) => ({ ...draft, editing: false })); }} type="button">Close editor</button></>}
    </header>
    {!capacity && <p role="alert">Save an open draft before you edit another file. WTS retained your drafts.</p>}
    {record?.loading && <p role="status">WTS reads the local file.</p>}
    {previewReadOnly && !record?.error && <p role="status">{NATIVE_PREVIEW_READ_ONLY_MESSAGE}</p>}
    {record?.error && <div className={styles.error} role="alert">{previewReadOnly ? NATIVE_PREVIEW_READ_ONLY_MESSAGE : record.error}
      {!previewReadOnly && (externalEditorRequired ? <><p>Open the workspace in VS Code to inspect this file, or select another file.</p><button disabled={opening} onClick={() => void openWorkspace()} type="button">Open workspace in VS Code</button></> : <button onClick={() => setRetry((value) => value + 1)} type="button">Read file again</button>)}
    </div>}
    {dirty && (record?.error || previewReadOnly) && <button onClick={() => void copyDraft()} type="button">Copy draft</button>}
    {openError && <p role="alert">{openError} Open VS Code, then open the saved workspace file.</p>}
    {copyState !== "idle" && <p role="status">{copyState === "copied" ? "Draft copied." : "Clipboard access failed. Select the draft text below, then copy it."}</p>}
    {record?.newer && <div className={styles.notice}><p>The local file changed while you edited it. Your draft is unchanged.</p><button onClick={() => setCompare((value) => !value)} type="button">{compare ? "Hide newer file" : "Compare newer file"}</button><button disabled={record.saving} onClick={() => { store.update(key, (draft) => draft.newer ? { ...draft, source: draft.newer, text: draft.newer.content, newer: undefined, reading: false, loading: false, error: "", saved: false, mutation: draft.mutation + 1, request: draft.request + 1 } : draft); setCompare(false); }} type="button">Use newer file</button></div>}
    {compare && record?.newer && <pre aria-label="Newer local file">{record.newer.content}</pre>}
    {record?.editing && record.source ? <><textarea autoFocus={embedded} aria-label="Local file editor" readOnly={previewReadOnly} disabled={record.saving} spellCheck={false} value={record.text} onChange={(event) => { if (previewReadOnly) return; const text = event.currentTarget.value; store.update(key, (draft) => ({ ...draft, text, saved: false })); }} />{!previewReadOnly && <p>Save changes only in this local file. WTS does not commit or push.</p>}</> : (!embedded || previewReadOnly) && record?.source && <pre aria-label="Current local file">{record.source.content}</pre>}
    {record?.saved && <p role="status">Local file saved. The MR is unchanged.</p>}
  </section>;
}
