/**
 * Tests for the sanitizer — bounds, URL validation, block sanitization.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/integrations/__tests__/sanitizer.test.ts
 */

import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert";
import { sanitizeBlock, sanitizeBlocks, isValidSafeUrl } from "../sanitizer";
import type { UiBlock } from "../types";

/* ------------------------------------------------------------------ */
/*  URL validation                                                     */
/* ------------------------------------------------------------------ */

void describe("isValidSafeUrl", () => {
  void it("accepts http URLs", () => {
    ok(isValidSafeUrl("http://example.com/path"));
  });

  void it("accepts https URLs", () => {
    ok(isValidSafeUrl("https://example.com/path?q=1"));
  });

  void it("rejects empty string", () => {
    strictEqual(isValidSafeUrl(""), false);
  });

  void it("rejects file:// URLs", () => {
    strictEqual(isValidSafeUrl("file:///etc/passwd"), false);
  });

  void it("rejects javascript: URLs", () => {
    strictEqual(isValidSafeUrl("javascript:alert(1)"), false);
  });

  void it("rejects data: URLs", () => {
    strictEqual(isValidSafeUrl("data:text/plain,hello"), false);
  });

  void it("rejects blob: URLs", () => {
    strictEqual(isValidSafeUrl("blob:null/uuid"), false);
  });

  void it("rejects overly long URLs", () => {
    const long = "https://example.com/" + "x".repeat(2500);
    strictEqual(isValidSafeUrl(long), false);
  });

  void it("rejects URLs with embedded credentials", () => {
    strictEqual(isValidSafeUrl("https://user:pass@example.com"), false);
    strictEqual(isValidSafeUrl("http://admin:secret@evil.example/path"), false);
  });

  void it("rejects URLs with username only", () => {
    strictEqual(isValidSafeUrl("https://user@example.com"), false);
  });
});

/* ------------------------------------------------------------------ */
/*  Sanitize block                                                     */
/* ------------------------------------------------------------------ */

void describe("sanitizeBlock", () => {
  void it("bounds notice message", () => {
    const longMsg = "x".repeat(1000);
    const block: UiBlock = {
      type: "notice",
      id: "n1",
      title: "Notice",
      message: longMsg,
    };
    const result = sanitizeBlock(block);
    strictEqual(result.type, "notice");
    if (result.type === "notice") {
      ok(result.message.length <= 500);
    }
  });

  void it("bounds metric-list items to 20", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      label: `item-${i}`,
      value: String(i),
    }));
    const block: UiBlock = {
      type: "metric-list",
      id: "m1",
      title: "Metrics",
      items,
    };
    const result = sanitizeBlock(block);
    strictEqual(result.type, "metric-list");
    if (result.type === "metric-list") {
      strictEqual(result.items.length, 20);
    }
  });

  void it("bounds status-list items to 50", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      label: `status-${i}`,
      status: "ok" as const,
    }));
    const block: UiBlock = {
      type: "status-list",
      id: "s1",
      title: "Statuses",
      items,
    };
    const result = sanitizeBlock(block);
    strictEqual(result.type, "status-list");
    if (result.type === "status-list") {
      strictEqual(result.items.length, 50);
    }
  });

  void it("sanitizes metric item values to string and bounds", () => {
    const block: UiBlock = {
      type: "metric-list",
      id: "m1",
      title: "Metrics",
      items: [
        { label: "l1", value: "a".repeat(200) },
      ],
    };
    const result = sanitizeBlock(block);
    strictEqual(result.type, "metric-list");
    if (result.type === "metric-list") {
      ok(result.items[0].value.length <= 80);
    }
  });

  void it("filters unsafe link URLs", () => {
    const block: UiBlock = {
      type: "link-list",
      id: "ll1",
      title: "Links",
      items: [
        { label: "Safe", url: "https://example.com" },
        { label: "Unsafe", url: "file:///etc/passwd" },
        { label: "JS", url: "javascript:alert(1)" },
      ],
    };
    const result = sanitizeBlock(block);
    strictEqual(result.type, "link-list");
    if (result.type === "link-list") {
      strictEqual(result.items.length, 1);
      strictEqual(result.items[0].label, "Safe");
    }
  });

  void it("returns safe fallback for unknown block type", () => {
    const result = sanitizeBlock({
      type: "unknown-type" as never,
      id: "b1",
      title: "Bad",
    } as never);
    strictEqual(result.type, "notice");
  });

  void it("unknown block fallback ID is bounded and safe", () => {
    const result = sanitizeBlock({
      type: "nope" as never,
      id: "x".repeat(200),
      title: "Bad",
    } as never);
    strictEqual(result.type, "notice");
    if (result.type === "notice") {
      ok(result.id.length <= 80, `Fallback ID should be bounded, got ${result.id.length} chars`);
      ok(!result.id.includes("/"), "Fallback ID should not contain path separators");
    }
  });
});

void describe("sanitizeBlocks", () => {
  void it("handles non-array gracefully", () => {
    const result = sanitizeBlocks(undefined as never);
    strictEqual(Array.isArray(result), true);
    strictEqual(result.length, 0);
  });

  void it("sanitizes all blocks", () => {
    const blocks: UiBlock[] = [
      { type: "notice", id: "n1", title: "N", message: "Hello" },
      {
        type: "metric-list",
        id: "m1",
        title: "M",
        items: [{ label: "L", value: "V" }],
      },
    ];
    const result = sanitizeBlocks(blocks);
    strictEqual(result.length, 2);
  });

  void it("bounds the total number of blocks to 20", () => {
    const blocks: UiBlock[] = Array.from({ length: 25 }, (_, index) => ({
      type: "notice",
      id: `notice-${index}`,
      title: "Notice",
      message: "Bounded",
    }));
    strictEqual(sanitizeBlocks(blocks).length, 20);
  });
});
