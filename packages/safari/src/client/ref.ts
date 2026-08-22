import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

/**
 * Refs for history items and bookmarks.
 *
 * ## Why the history ref carries the URL rather than the rowid
 *
 * `history_items.id` exists and is cheaper to look up. The URL wins for a
 * reason that holds regardless of anything unmeasured: docs/safari.md
 * establishes the URL as *the* identity on this surface. It is the only join
 * key between the two lanes — the thing a live tab is matched against, since
 * Safari offers no opaque id shared between them. A ref built on anything else
 * would mean this surface identified a page one way internally and another way
 * externally, and the two would have to be kept in agreement forever.
 *
 * There was a second argument, and it turned out not to apply. `packages/messages`
 * rejected rowids because SQLite reuses them — a deleted row's id goes to the
 * next insert — which would silently resolve a ref to a different page two
 * turns later. MEASURED, macOS 26.6: `history_items` is declared
 * `id INTEGER PRIMARY KEY AUTOINCREMENT`, so ids here are NOT reused.
 *
 * That is recorded rather than quietly dropped, because it is the more useful
 * fact: the reason above never depended on it. `history_items.url` is
 * `NOT NULL UNIQUE` (also measured), so the URL is a real key and not merely a
 * convenient one.
 *
 * The URL is also not a privacy cost: it is already in the result the ref
 * accompanies. A ref that is long is a smaller problem than a ref that is wrong.
 *
 * ## Why bookmarks get a real UUID
 *
 * `Bookmarks.plist` carries `WebBookmarkUUID` on every node, so the argument
 * above does not apply — there is a stable opaque id and it is used. Reading
 * List entries are bookmarks in that file, so one ref kind covers both.
 *
 * ## Why `s1:` and `sb1:`
 *
 * `c1:` is Calendar's, `r1:` Reminders', `k1:` Contacts', `m1:`/`mc1:`
 * Messages'. A ref that decodes under two surfaces is worse than one that
 * decodes under none, so each prefix is claimed once and the version digit
 * keeps a future scheme change additive rather than a silent reinterpretation
 * of refs already sitting in a conversation.
 */

export const HISTORY_REF_VERSION = "s1";
export const BOOKMARK_REF_VERSION = "sb1";

/**
 * Greedy tails. A URL contains `:`, `/`, `?`, `#` and anything else a site
 * chose to put there, so nothing inside the payload is parsed or validated —
 * the codec checks the envelope and refuses to invent structure within it.
 */
const HISTORY_PATTERN = /^s1:(.+)$/s;
const BOOKMARK_PATTERN = /^sb1:(.+)$/s;

const otherSurface = (raw: string): string => {
  if (raw.startsWith("c1:")) return " That one is a Calendar event ref.";
  if (raw.startsWith("r1:")) return " That one is a Reminders ref.";
  if (raw.startsWith("k1:")) return " That one is a Contacts ref.";
  if (raw.startsWith("mc1:")) return " That one is a Messages chat ref.";
  if (raw.startsWith("m1:")) return " That one is a Messages message ref.";
  if (raw.startsWith("sb1:")) return " That one is a BOOKMARK ref — this wants a history ref.";
  if (raw.startsWith("s1:")) return " That one is a HISTORY ref — this wants a bookmark ref.";
  return "";
};

export class InvalidSafariRefError extends AppleAutomationError {
  override readonly name = "InvalidSafariRefError";

  constructor(raw: string, want: "history" | "bookmark") {
    const shape = want === "history" ? '"s1:<url>"' : '"sb1:<uuid>"';
    super(
      `"${raw}" is not a ${want} ref. Refs come from apple_safari_* results and look like ` +
        `${shape} — they are opaque and must not be constructed by hand.${otherSurface(raw)}`,
      { ref: raw },
    );
  }
}

export const encodeHistoryRef = (url: string): string => `${HISTORY_REF_VERSION}:${url}`;
export const encodeBookmarkRef = (uuid: string): string => `${BOOKMARK_REF_VERSION}:${uuid}`;

export const decodeHistoryRef = (raw: string): string => {
  // Only the envelope is trimmed. Leading and trailing whitespace INSIDE a URL
  // is not something to invent an opinion about, but a ref pasted with a stray
  // newline around it is common enough to forgive.
  const m = HISTORY_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidSafariRefError(raw, "history");
  return m[1];
};

export const decodeBookmarkRef = (raw: string): string => {
  const m = BOOKMARK_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidSafariRefError(raw, "bookmark");
  return m[1];
};
