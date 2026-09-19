export const NATIVE_PREVIEW_READ_ONLY_MESSAGE =
  "This preview is read-only. Use the main WTS window to make changes.";

/** Native permissions remain the authority. This marker supplies preview guidance. */
export function nativePreviewAllowsCommand(command: string): boolean {
  if (typeof window === "undefined") return true;
  const marker: unknown = Reflect.get(window, "__WTS_NATIVE_PREVIEW__");
  if (marker === undefined) return true;
  if (!marker || typeof marker !== "object") return false;
  const value = marker as { schemaVersion?: unknown; allowedCommands?: unknown };
  return value.schemaVersion === 1
    && Array.isArray(value.allowedCommands)
    && value.allowedCommands.includes(command);
}

export function isNativePreviewReadOnlyCode(code: string | undefined): boolean {
  return code === "preview_read_only" || code === "native_preview_read_only";
}
