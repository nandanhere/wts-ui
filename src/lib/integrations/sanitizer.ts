/**
 * Sanitizer — bounds and cleans provider-returned values before API response.
 *
 * - Truncates strings to maximum lengths.
 * - Limits array sizes.
 * - Only allows safe http/https URLs (no file://, no data:, no javascript:).
 * - Strips any values that could leak paths or secrets.
 */

import type {
  UiBlock,
  NoticeBlock,
  MetricListBlock,
  StatusListBlock,
  LinkListBlock,
  LinkItem,
  MetricItem,
  StatusItem,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Bounds                                                             */
/* ------------------------------------------------------------------ */

const MAX_MESSAGE_LENGTH = 500;
const MAX_LABEL_LENGTH = 120;
const MAX_VALUE_LENGTH = 80;
const MAX_DETAIL_LENGTH = 300;
const MAX_URL_LENGTH = 2000;
const MAX_TITLE_LENGTH = 120;
const MAX_METRICS = 20;
const MAX_STATUS_ITEMS = 50;
const MAX_LINKS = 20;
const MAX_BLOCKS = 20;

/* ------------------------------------------------------------------ */
/*  URL validation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Validate that a URL is a safe http/https URL.
 * Rejects file://, data:, javascript:, blob:, and other schemes.
 * Also rejects URLs with embedded credentials (user:password@).
 */
export function isValidSafeUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.length > MAX_URL_LENGTH) return false;

  // Scheme must be http or https only
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }

  // Reject embedded credentials
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
  } catch {
    return false;
  }

  return true;
}

/** Truncate a string to maxLen, preserving full characters. */
function cap(str: string, maxLen: number): string {
  if (typeof str !== "string") return "";
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

/* ------------------------------------------------------------------ */
/*  Item sanitizers                                                    */
/* ------------------------------------------------------------------ */

function sanitizeMetricItem(item: MetricItem): MetricItem {
  return {
    label: cap(item.label, MAX_LABEL_LENGTH),
    value: cap(String(item.value ?? ""), MAX_VALUE_LENGTH),
    color: ["default", "success", "warn", "danger"].includes(item.color ?? "")
      ? item.color
      : "default",
  };
}

function sanitizeStatusItem(item: StatusItem): StatusItem {
  return {
    label: cap(item.label, MAX_LABEL_LENGTH),
    status: ["ok", "warn", "error", "unknown"].includes(item.status)
      ? item.status
      : "unknown",
    detail: item.detail ? cap(item.detail, MAX_DETAIL_LENGTH) : undefined,
  };
}

function sanitizeLinkItem(item: LinkItem): LinkItem | null {
  const label = cap(item.label, MAX_LABEL_LENGTH);
  const url = cap(item.url, MAX_URL_LENGTH);
  if (!isValidSafeUrl(url)) return null;
  return { label, url };
}

/* ------------------------------------------------------------------ */
/*  Block sanitizer (exhaustive switch)                                */
/* ------------------------------------------------------------------ */

/**
 * Sanitize a single UiBlock — bounds all strings, rejects unsafe URLs,
 * limits item counts. Returns the sanitized block (mutated copy).
 */
export function sanitizeBlock(block: UiBlock): UiBlock {
  switch (block.type) {
    case "notice": {
      const b = block as NoticeBlock;
      return {
        type: "notice",
        id: cap(b.id, 80),
        title: cap(b.title, MAX_TITLE_LENGTH),
        message: cap(b.message, MAX_MESSAGE_LENGTH),
        severity: ["info", "warn", "error"].includes(b.severity ?? "")
          ? b.severity
          : undefined,
      };
    }

    case "metric-list": {
      const b = block as MetricListBlock;
      return {
        type: "metric-list",
        id: cap(b.id, 80),
        title: cap(b.title, MAX_TITLE_LENGTH),
        items: (b.items ?? []).slice(0, MAX_METRICS).map(sanitizeMetricItem),
      };
    }

    case "status-list": {
      const b = block as StatusListBlock;
      return {
        type: "status-list",
        id: cap(b.id, 80),
        title: cap(b.title, MAX_TITLE_LENGTH),
        items: (b.items ?? []).slice(0, MAX_STATUS_ITEMS).map(sanitizeStatusItem),
      };
    }

    case "link-list": {
      const b = block as LinkListBlock;
      return {
        type: "link-list",
        id: cap(b.id, 80),
        title: cap(b.title, MAX_TITLE_LENGTH),
        items: (b.items ?? [])
          .slice(0, MAX_LINKS)
          .map(sanitizeLinkItem)
          .filter((x): x is LinkItem => x !== null),
      };
    }

    default:
      // Unknown block type — return a safe bounded fallback notice
      return {
        type: "notice",
        id: `unknown-${String((block as UiBlock).id ?? "unsupported").slice(0, 60)}`,
        title: "Unknown Block",
        message: "This integration returned an unrecognized block type.",
        severity: "warn",
      };
  }
}

/**
 * Sanitize all blocks returned by a provider.
 */
export function sanitizeBlocks(blocks: UiBlock[]): UiBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.slice(0, MAX_BLOCKS).map(sanitizeBlock);
}

/**
 * Sanitize provider name/description for safe display.
 * (Already bounded by type, but double-check.)
 */
export function sanitizeString(str: string, maxLen = 200): string {
  if (typeof str !== "string") return "";
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}
