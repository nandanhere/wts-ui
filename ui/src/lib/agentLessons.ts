/** Local ratings for agent results and lessons that later agent requests include. */

const RATINGS_KEY = "wts.agent-result-ratings.v1";
const LESSONS_KEY = "wts.agent-lessons.v1";
const MAX_RATINGS = 500;
export const MAX_LESSONS = 20;
export const MAX_LESSON_LENGTH = 600;
/** The lesson block must leave room for the request itself. */
export const MAX_LESSON_BLOCK_LENGTH = 4_000;
export const AGENT_LESSONS_CHANGED_EVENT = "wts:agent-lessons-changed";

export interface AgentResultRating {
  thumb: "up" | "down" | null;
  stars: number | null;
  correction: string;
  savedAsLesson: boolean;
  updatedAtUnixMs: number;
}

export interface AgentLesson {
  id: string;
  text: string;
  createdAtUnixMs: number;
  sourceLabel: string;
}

function deviceStorage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

type Store = Pick<Storage, "getItem" | "setItem">;

function read<T>(key: string, storage: Store | undefined, valid: (value: unknown) => value is T, fallback: T): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const value: unknown = JSON.parse(raw);
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function isRating(value: unknown): value is AgentResultRating {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (item.thumb === "up" || item.thumb === "down" || item.thumb === null) &&
    (item.stars === null || (typeof item.stars === "number" && Number.isInteger(item.stars) && item.stars >= 1 && item.stars <= 5)) &&
    typeof item.correction === "string" && item.correction.length <= MAX_LESSON_LENGTH && typeof item.savedAsLesson === "boolean" &&
    typeof item.updatedAtUnixMs === "number" && Number.isSafeInteger(item.updatedAtUnixMs);
}

function isRatings(value: unknown): value is Record<string, AgentResultRating> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isRating);
}

function isLessons(value: unknown): value is AgentLesson[] {
  return Array.isArray(value) && value.length <= MAX_LESSONS && value.every((item) =>
    item && typeof item === "object" && typeof item.id === "string" && typeof item.text === "string" &&
    item.text.length <= MAX_LESSON_LENGTH && typeof item.createdAtUnixMs === "number" && typeof item.sourceLabel === "string");
}

export function ratingKey(conversationId: string, messageId: string) {
  return conversationId + "/" + messageId;
}

export function loadAgentResultRating(key: string, storage: Store | undefined = deviceStorage()): AgentResultRating | null {
  return read(RATINGS_KEY, storage, isRatings, {})[key] ?? null;
}

export function saveAgentResultRating(key: string, rating: AgentResultRating, storage: Store | undefined = deviceStorage()) {
  if (!storage || !isRating(rating)) return false;
  const current = read(RATINGS_KEY, storage, isRatings, {});
  const entries = Object.entries({ ...current, [key]: rating })
    .sort((left, right) => right[1].updatedAtUnixMs - left[1].updatedAtUnixMs)
    .slice(0, MAX_RATINGS);
  try {
    storage.setItem(RATINGS_KEY, JSON.stringify(Object.fromEntries(entries)));
    return true;
  } catch {
    return false;
  }
}

export function loadAgentLessons(storage: Store | undefined = deviceStorage()): AgentLesson[] {
  return read(LESSONS_KEY, storage, isLessons, []);
}

function writeLessons(lessons: AgentLesson[], storage: Store | undefined) {
  if (!storage) return false;
  try {
    storage.setItem(LESSONS_KEY, JSON.stringify(lessons));
    globalThis.dispatchEvent?.(new Event(AGENT_LESSONS_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

/** Adds a lesson. The newest lessons stay when the list is full. */
export function addAgentLesson(text: string, sourceLabel: string, storage: Store | undefined = deviceStorage(), now = Date.now()): AgentLesson | null {
  const clean = text.trim().replace(/\s+/g, " ").slice(0, MAX_LESSON_LENGTH);
  if (!clean) return null;
  const lessons = loadAgentLessons(storage).filter((item) => item.text !== clean);
  const lesson: AgentLesson = { id: crypto.randomUUID(), text: clean, createdAtUnixMs: now, sourceLabel: sourceLabel.slice(0, 200) };
  return writeLessons([lesson, ...lessons].slice(0, MAX_LESSONS), storage) ? lesson : null;
}

export function removeAgentLesson(id: string, storage: Store | undefined = deviceStorage()) {
  return writeLessons(loadAgentLessons(storage).filter((item) => item.id !== id), storage);
}

/**
 * Adds the saved lessons to a request. The lessons come after the request so the
 * agent reads the task first. The result never exceeds the message limit.
 */
export function withAgentLessons(body: string, lessons: readonly AgentLesson[], maxLength = 16_384): string {
  if (!lessons.length) return body;
  let block = "Lessons from my earlier feedback. Apply them to this task:";
  for (const lesson of lessons) {
    const line = "\n- " + lesson.text;
    if (block.length + line.length > MAX_LESSON_BLOCK_LENGTH) break;
    block += line;
  }
  const combined = body + "\n\n" + block;
  return [...combined].length <= maxLength ? combined : body;
}

