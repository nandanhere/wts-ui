/**
 * Minimal JSON-with-comments parser.
 *
 * Strips C-style comments (// and /* * /) and trailing commas, then parses
 * with the built-in JSON parser.  Zero dependencies.  Sufficient for
 * reading VS Code .code-workspace files.
 *
 * Not suitable for streaming — the entire string is processed in memory.
 */

/** Strip C-style comments from a JSONC string, respecting string boundaries. */
function stripComments(raw: string): string {
  const len = raw.length;
  const out: string[] = [];
  let i = 0;

  while (i < len) {
    const c = raw[i];

    // Track string boundaries so // and /* inside strings are preserved
    if (c === '"') {
      out.push(c);
      i++;
      while (i < len) {
        const sc = raw[i];
        out.push(sc);
        if (sc === '\\') {
          // escaped char — skip next
          i++;
          if (i < len) {
            out.push(raw[i]);
            i++;
          }
          continue;
        }
        if (sc === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Line comment — only outside strings
    if (c === '/' && raw[i + 1] === '/') {
      i += 2;
      while (i < len && raw[i] !== '\n') i++;
      continue;
    }

    // Block comment — only outside strings
    if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < len && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2; // skip */
      continue;
    }

    out.push(c);
    i++;
  }

  return out.join('');
}

/** Strip trailing commas before closing ] } and end of input. */
function stripTrailingCommas(stripped: string): string {
  // Strip trailing comma before ]
  stripped = stripped.replace(/,(\s*)\]/g, '$1]');
  // Strip trailing comma before }
  stripped = stripped.replace(/,(\s*)\}/g, '$1}');
  return stripped;
}

/**
 * Parse a JSONC string into an unknown value.
 * Throws if the JSON is invalid after comment/comma removal.
 */
export function parseJSONC<T = unknown>(raw: string): T {
  const noComments = stripComments(raw);
  const clean = stripTrailingCommas(noComments);
  return JSON.parse(clean) as T;
}
