import { memo, type ReactNode } from "react";

export type GlyphName =
  | "arrow"
  | "branch"
  | "check"
  | "chevron"
  | "close"
  | "code"
  | "comment"
  | "command"
  | "copy"
  | "external"
  | "file"
  | "folder"
  | "help"
  | "issue"
  | "jira"
  | "openProject"
  | "more"
  | "pause"
  | "play"
  | "plug"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "moon"
  | "sun"
  | "stop"
  | "terminal"
  | "trash"
  | "warning";

export interface GlyphProps {
  name: GlyphName;
  size?: number;
}

export const Glyph = memo(function Glyph({
  name,
  size = 16,
}: GlyphProps) {
  const paths: Record<GlyphName, ReactNode> = {
    arrow: <path d="m9 18 6-6-6-6" />,
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="6" cy="19" r="2" />
        <path d="M6 7v10M8 12h4a6 6 0 0 0 6-6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    code: (
      <>
        <path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14" />
      </>
    ),
    comment: (
      <>
        <path d="M5 5h14v10H9l-4 4V5Z" />
        <path d="M8 9h8M8 12h5" />
      </>
    ),
    command: (
      <>
        <path d="M9 6V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V5" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="11" height="11" rx="2" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    ),
    external: (
      <>
        <path d="M14 5h5v5M19 5l-9 9" />
        <path d="M17 13v6H5V7h6" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6V3Z" />
        <path d="M14 3v5h5" />
      </>
    ),
    folder: <path d="M3 6h7l2 3h9v10H3V6Z" />,
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.8 9a2.4 2.4 0 0 1 4.6.9c0 1.8-2.4 2.1-2.4 3.8M12 17h.01" />
      </>
    ),
    issue: (
      <>
        <path d="M5 5h14v14H5z" />
        <path d="M8 9h8M8 13h5" />
      </>
    ),
    jira: (
      <>
        <path d="m12 3 4.7 4.7L12 12.4 7.3 7.7 12 3Z" />
        <path d="m7.2 9 3.6 3.6-3.6 3.6-3.6-3.6L7.2 9ZM16.8 9l3.6 3.6-3.6 3.6-3.6-3.6 3.6-3.6ZM12 13.7l3.6 3.6L12 21l-3.6-3.7 3.6-3.6Z" />
      </>
    ),
    openProject: (
      <>
        <path d="M5 5h6v6H5V5Zm8 0h6v6h-6V5ZM5 13h6v6H5v-6Z" />
        <path d="m14 16 2 2 4-5" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
    pause: (
      <>
        <path d="M9 5v14M15 5v14" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7V5Z" />,
    plug: (
      <>
        <path d="m8 12 8-8M14 4l6 6M4 14l6 6M7 17l-3 3M11 13l-4-4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <>
        <path d="M20 7v5h-5" />
        <path d="M4 17v-5h5" />
        <path d="M6.1 8.1A7 7 0 0 1 18.7 10M17.9 15.9A7 7 0 0 1 5.3 14" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 4.5 4.5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.4 6a8 8 0 0 0-1.5.9L6.5 6l-2 3.4 2 1.5a7 7 0 0 0 0 2.1l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.5.9l.3 2.6h4l.3-2.6a8 8 0 0 0 1.5-.9l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z" />
      </>
    ),
    moon: <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.6 8.6 0 1 0 11.2 11.2Z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </>
    ),
    stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
    terminal: <path d="m4 7 5 5-5 5M11 17h9" />,
    trash: (
      <>
        <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" />
        <path d="M10 11v5M14 11v5" />
      </>
    ),
    warning: (
      <>
        <path d="M12 3 2.8 20h18.4L12 3Z" />
        <path d="M12 9v5M12 17h.01" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
});
