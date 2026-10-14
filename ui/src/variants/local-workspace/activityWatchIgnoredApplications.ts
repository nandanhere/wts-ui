const STORAGE_KEY = "wts.activity-watch.ignored-applications.v1";
const MAX_APPLICATIONS = 100;
const MAX_APPLICATION_LENGTH = 120;
const DEFAULT_IGNORED_APPLICATIONS = ["loginwindow"];

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

function validApplication(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_APPLICATION_LENGTH &&
    !value.includes("\0")
  );
}

export function loadIgnoredApplications(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
) {
  if (!storage) return new Set(DEFAULT_IGNORED_APPLICATIONS);
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (!stored) return new Set(DEFAULT_IGNORED_APPLICATIONS);
    const parsed: unknown = JSON.parse(stored);
    if (
      !Array.isArray(parsed) ||
      parsed.length > MAX_APPLICATIONS ||
      !parsed.every(validApplication)
    ) {
      return new Set(DEFAULT_IGNORED_APPLICATIONS);
    }
    return new Set(parsed.map(normalize));
  } catch {
    return new Set(DEFAULT_IGNORED_APPLICATIONS);
  }
}

export function saveIgnoredApplications(
  applications: ReadonlySet<string>,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
) {
  if (!storage || applications.size > MAX_APPLICATIONS) return false;
  const normalized = [...applications]
    .map(normalize)
    .filter(validApplication)
    .sort();
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function isApplicationIgnored(
  application: string | undefined,
  ignored: ReadonlySet<string>,
) {
  return application !== undefined && ignored.has(normalize(application));
}
