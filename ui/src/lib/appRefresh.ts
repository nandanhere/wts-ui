import type { WorkspaceClient } from "./wtsClient";
const EVENT = "wts:refresh";
export function requestAppRefresh(client: WorkspaceClient) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: client }));
}
export function subscribeAppRefresh(client: WorkspaceClient, refresh: () => void) {
  const listener = (event: Event) => {
    if ((event as CustomEvent<WorkspaceClient>).detail === client) refresh();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
