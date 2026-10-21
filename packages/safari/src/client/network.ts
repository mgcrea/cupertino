/**
 * Pure helpers for network capture: the pieces that have no Safari in them, so
 * they can be tested without one. The chunked body pull, the tool surface and
 * the content script are built on top of these.
 */

import { PreconditionError } from "./errors.js";

type PathResult = { ok: true; value: unknown } | { ok: false; error: string };

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

/**
 * Tokenise a path into keys and indices.
 *
 * Hand-rolled rather than a dependency because the grammar is four productions
 * (`$`, `.key`, `[n]`, `["quoted"]`) and because the error messages are the
 * product: this is what a model reads when it guessed the response shape wrong,
 * so each failure has to say where it stopped, not just that it did.
 */
function tokenize(path: string): Segment[] | string {
  const segments: Segment[] = [];
  let i = path.startsWith("$") ? 1 : 0;
  // A bare leading key ("data.x") is allowed; a dot is only a separator after
  // something, so "$.a" and "a" are both fine but "a..b" is not.
  let expectKey = i === 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === "[") {
      if (path[i + 1] === '"') {
        const end = path.indexOf('"]', i + 2);
        if (end < 0) return `Unterminated quoted key at position ${i} in "${path}".`;
        segments.push({ kind: "key", key: path.slice(i + 2, end) });
        i = end + 2;
      } else {
        const end = path.indexOf("]", i + 1);
        if (end < 0) return `Unterminated "[" at position ${i} in "${path}".`;
        const raw = path.slice(i + 1, end);
        if (!/^\d+$/.test(raw)) {
          return `Expected a number or a quoted key inside [] at position ${i} in "${path}", got "${raw}".`;
        }
        segments.push({ kind: "index", index: Number(raw) });
        i = end + 1;
      }
      expectKey = false;
    } else {
      if (ch === ".") {
        i += 1;
        expectKey = true;
      }
      if (!expectKey) return `Unexpected "${path[i]}" at position ${i} in "${path}".`;
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end += 1;
      if (end === i) return `Empty key at position ${i} in "${path}".`;
      segments.push({ kind: "key", key: path.slice(i, end) });
      i = end;
      expectKey = false;
    }
  }
  return segments;
}

const describeAt = (walked: string[]): string => (walked.length ? walked.join("") : "the root");

/**
 * Walk `path` through `root`. Never throws: a path that does not resolve is a
 * normal outcome of guessing at a response's shape, and the caller turns the
 * message into a tool error the model can correct itself from.
 */
export function resolveJsonPath(root: unknown, path: string): PathResult {
  const segments = tokenize(path);
  if (typeof segments === "string") return { ok: false, error: segments };

  let current = root;
  // Rendered as it is walked ("data.document", "items[0]") so a failure can
  // name its parent in the same notation the caller typed.
  const walked: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "index") {
      if (!Array.isArray(current)) {
        return {
          ok: false,
          error: `Cannot take index ${segment.index} of ${describeAt(walked)}: it is not an array.`,
        };
      }
      if (segment.index >= current.length) {
        return {
          ok: false,
          error: `No index ${segment.index} at ${describeAt(walked)}: it has length ${current.length}.`,
        };
      }
      current = current[segment.index];
      walked.push(`[${segment.index}]`);
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return {
          ok: false,
          error: `Cannot read key "${segment.key}" of ${describeAt(walked)}: it is not an object.`,
        };
      }
      // Own properties only: "constructor" or "toString" must not resolve
      // against the prototype chain of a parsed JSON object.
      if (!Object.hasOwn(current, segment.key)) {
        const keys = Object.keys(current);
        const shown = keys.slice(0, 20).join(", ") + (keys.length > 20 ? ", ..." : "");
        return {
          ok: false,
          error: `No key "${segment.key}" at ${describeAt(walked)}. Keys there: ${shown || "(none)"}.`,
        };
      }
      current = (current as Record<string, unknown>)[segment.key];
      walked.push(walked.length ? `.${segment.key}` : segment.key);
    }
  }
  return { ok: true, value: current };
}

/**
 * Decode base64 strictly.
 *
 * Node's `Buffer.from(s, "base64")` silently skips anything outside the
 * alphabet, so a truncated or mangled field decodes to a plausible but wrong
 * file with no signal. Validating first turns that into an error. Both the
 * standard and URL-safe alphabets are accepted (APIs return either), as is a
 * `data:*;base64,` prefix, since that is how a page often holds the same bytes.
 */
export function decodeBase64(text: string): Buffer {
  const stripped = text.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(stripped)) {
    const bad = stripped.search(/[^A-Za-z0-9+/_=-]/);
    throw new PreconditionError(
      `Not valid base64: unexpected character at position ${bad >= 0 ? bad : stripped.length} ` +
        `(standard and URL-safe alphabets are accepted).`,
    );
  }
  return Buffer.from(stripped, "base64");
}

/**
 * Name a file type from its first bytes, for a body whose Content-Type is
 * missing or lies (signing sites serve PDFs as octet-stream). Deliberately a
 * short list of unambiguous magic numbers; JSON is a guess from the first
 * character, so it is only reported for `{` and `[`.
 */
export function sniffType(bytes: Buffer): string | null {
  const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (starts(0x7b) || starts(0x5b)) return "application/json";
  return null;
}

/**
 * Header names whose values are never returned. Exact names for the standard
 * credentials, substrings for the custom ones every API invents (`x-csrf-token`,
 * `x-api-key`).
 *
 * The content script keeps a copy of this pattern because it is plain JS and
 * cannot import TypeScript; a test asserts the two sources agree. Keep it a
 * plain literal with only the `i` flag so that comparison stays trivial.
 */
export const REDACTED_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api-key|apikey/i;

/** Replace the value of every sensitive header with its length, keeping the name. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    out[name] = REDACTED_HEADER.test(name) ? `<redacted: ${value.length} chars>` : value;
  }
  return out;
}
