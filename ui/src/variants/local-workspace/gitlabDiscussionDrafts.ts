const drafts = new Map<string, string>();
const pending = new Set<string>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const MAX_DRAFTS = 128;
let revision = 0;

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

export const gitlabDiscussionDrafts = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getSnapshot: () => revision,
  read: (key: string) => drafts.get(key) ?? "",
  isPending: (key: string) => pending.has(key),
  error: (key: string) => errors.get(key) ?? "",
  failReply(key: string, message: string) {
    errors.set(key, message);
    notify();
  },
  write(key: string, body: string) {
    if (body && !drafts.has(key) && drafts.size >= MAX_DRAFTS) return false;
    if (body) drafts.set(key, body);
    else { drafts.delete(key); errors.delete(key); }
    notify();
    return true;
  },
  beginReply(key: string) {
    if (pending.has(key)) return false;
    pending.add(key);
    errors.delete(key);
    notify();
    return true;
  },
  finishReply(key: string, submittedBody: string, published: boolean) {
    pending.delete(key);
    if (published) {
      errors.delete(key);
      if (drafts.get(key) === submittedBody) drafts.delete(key);
    }
    notify();
  },
  clear() {
    drafts.clear();
    pending.clear();
    errors.clear();
    notify();
  },
};
