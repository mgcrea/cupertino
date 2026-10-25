/**
 * Find-and-replace edits on a draft's own text, matched the way the app does.
 *
 * `applyEdits` is the TypeScript twin of the app's `MailComposerText.apply`
 * (`apps/apple/Cupertino/MailComposerText.swift`), with the same rules, so a
 * draft whose window is closed is edited exactly as an open one would be:
 *
 *   * every whitespace run, line breaks included, folds to one space on both
 *     sides, because the caller's idea of the text and Mail's disagree about
 *     line breaks;
 *   * each `find` must match exactly once, or nothing is changed;
 *   * matches may not overlap, and are applied right to left, so a replacement
 *     never shifts one still to come.
 *
 * A character is a grapheme cluster, as a Swift `Character` is, so a match
 * never splits an emoji or a letter from its accent.
 *
 * The HTML half (`htmlText`, `applyHtmlEdits`) is what a closed draft needs on
 * top: its own text is HTML, and an edit is applied to the TEXT of that HTML,
 * never to its tags or attributes. A match that would cross a tag is refused,
 * because which side of the formatting the new text belongs on cannot be known
 * without the window.
 */

export type Edit = { find: string; replace: string };

/** A range of UTF-16 offsets, `end` exclusive. */
export type Span = { start: number; end: number };

export type Matched =
  | { kind: "ok"; result: string; matches: Span[] }
  | { kind: "notFound"; find: string }
  | { kind: "ambiguous"; find: string; count: number }
  | { kind: "overlapping" };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Swift's `Character.isWhitespace`: the Unicode White_Space property. */
const WHITESPACE = /^\p{White_Space}+$/u;

/** The text with each whitespace run as one space, and where each folded character came from. */
type Folded = { chars: string[]; starts: number[]; ends: number[] };

const fold = (text: string): Folded => {
  const out: Folded = { chars: [], starts: [], ends: [] };
  for (const { segment, index } of graphemes.segment(text)) {
    const next = index + segment.length;
    if (WHITESPACE.test(segment)) {
      const last = out.ends.length - 1;
      if (out.chars[last] === " " && out.ends[last] === index) {
        out.ends[last] = next;
      } else {
        out.chars.push(" ");
        out.starts.push(index);
        out.ends.push(next);
      }
    } else {
      out.chars.push(segment);
      out.starts.push(index);
      out.ends.push(next);
    }
  }
  return out;
};

/** Overlapping hits are counted: "aa" in "aaa" is two places, not one. */
const occurrences = (needle: string[], haystack: string[]): number[] => {
  if (needle.length === 0 || needle.length > haystack.length) return [];
  const hits: number[] = [];
  for (let at = 0; at <= haystack.length - needle.length; at += 1) {
    let all = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (haystack[at + k] !== needle[k]) {
        all = false;
        break;
      }
    }
    if (all) hits.push(at);
  }
  return hits;
};

/**
 * Apply every edit to `own`, or none. `matches` index the original `own`, in
 * edit order.
 */
export const applyEdits = (edits: Edit[], own: string): Matched => {
  const folded = fold(own);
  const matches: Span[] = [];
  for (const edit of edits) {
    const needle = fold(edit.find).chars;
    const hits = occurrences(needle, folded.chars);
    if (hits.length === 0) return { kind: "notFound", find: edit.find };
    if (hits.length > 1) return { kind: "ambiguous", find: edit.find, count: hits.length };
    const first = hits[0] as number;
    matches.push({
      start: folded.starts[first] as number,
      end: folded.ends[first + needle.length - 1] as number,
    });
  }

  const ordered = matches.toSorted((a, b) => a.start - b.start);
  for (let at = 1; at < ordered.length; at += 1) {
    if ((ordered[at - 1] as Span).end > (ordered[at] as Span).start) return { kind: "overlapping" };
  }

  // Right to left, so a replacement never shifts a range still to be applied.
  let result = own;
  const order = edits.map((_, at) => at).toSorted((a, b) => matches[b]!.start - matches[a]!.start);
  for (const at of order) {
    const span = matches[at] as Span;
    result = result.slice(0, span.start) + (edits[at] as Edit).replace + result.slice(span.end);
  }
  return { kind: "ok", result, matches };
};

/** Two quotes are the same once every whitespace run is one space. */
export const sameQuote = (a: string, b: string): boolean =>
  fold(a).chars.join("") === fold(b).chars.join("");

// ─── HTML ────────────────────────────────────────────────────────────────────

/**
 * Tags that start a new line where they open or close. Inline tags (`b`, `a`,
 * `span`, `font`…) add nothing, so their text runs straight on.
 */
const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

type Token =
  /** Markup with no text of its own: a tag, a comment, a script or style block. */
  | { kind: "markup"; raw: string; block: boolean }
  /** A run of text between tags, with its entities decoded. */
  | { kind: "text"; raw: string; text: string };

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (raw: string): string =>
  raw.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });

const encodeText = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(" ", "&nbsp;");

const COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
const RAW_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/iy;
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/y;
const DECLARATION = /<[!?][^>]*>/y;

const tokenize = (html: string): Token[] => {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", raw: text, text: decodeEntities(text) });
    text = "";
  };
  let at = 0;
  while (at < html.length) {
    if (html[at] === "<") {
      let matched: RegExpExecArray | null = null;
      let block = false;
      for (const pattern of [COMMENT, RAW_BLOCK, DECLARATION, TAG]) {
        pattern.lastIndex = at;
        matched = pattern.exec(html);
        if (matched) {
          block = pattern === TAG && BLOCKS.has((matched[1] ?? "").toLowerCase());
          break;
        }
      }
      if (matched) {
        flush();
        tokens.push({ kind: "markup", raw: matched[0], block });
        at += matched[0].length;
        continue;
      }
    }
    text += html[at];
    at += 1;
  }
  flush();
  return tokens;
};

/** The text a token contributes, and which text token it came from (null for a line break). */
type Piece = { start: number; end: number; token: number | null };

const flatten = (tokens: Token[]): { text: string; pieces: Piece[] } => {
  let text = "";
  const pieces: Piece[] = [];
  tokens.forEach((token, at) => {
    const add = token.kind === "text" ? token.text : token.block ? "\n" : "";
    if (!add) return;
    pieces.push({
      start: text.length,
      end: text.length + add.length,
      token: token.kind === "text" ? at : null,
    });
    text += add;
  });
  return { text, pieces };
};

/**
 * The text an HTML fragment shows: tags dropped, a line break where a block
 * opens or closes, entities decoded. Whitespace is left as it is; every
 * comparison made with it folds whitespace first.
 */
export const htmlText = (html: string): string => flatten(tokenize(html)).text;

export type HtmlMatched =
  | { kind: "ok"; html: string; text: string }
  | Exclude<Matched, { kind: "ok" }>
  /** The match covers a tag: part of it is formatted differently from the rest. */
  | { kind: "spans"; find: string };

/**
 * Apply edits to the text of an HTML fragment, leaving every tag as it is.
 *
 * The edits are matched against `htmlText(html)` with `applyEdits`'s rules,
 * and each match must lie inside ONE run of text: a match that reaches across
 * a tag (a bold word, a link, a paragraph break) is refused as `spans`. The
 * edited runs are re-encoded; the rest of the HTML is kept byte for byte.
 */
export const applyHtmlEdits = (edits: Edit[], html: string): HtmlMatched => {
  const tokens = tokenize(html);
  const flat = flatten(tokens);
  const matched = applyEdits(edits, flat.text);
  if (matched.kind !== "ok") return matched;

  // Where each match lands: one text token, and offsets in its decoded text.
  const placed: { token: number; start: number; end: number; replace: string }[] = [];
  for (const [at, span] of matched.matches.entries()) {
    const covering = flat.pieces.filter((p) => p.start < span.end && span.start < p.end);
    const only = covering[0];
    if (covering.length !== 1 || !only || only.token === null) {
      return { kind: "spans", find: (edits[at] as Edit).find };
    }
    placed.push({
      token: only.token,
      start: span.start - only.start,
      end: span.end - only.start,
      replace: (edits[at] as Edit).replace,
    });
  }

  // Right to left within each run; runs are independent of each other.
  const edited = new Map<number, string>();
  for (const p of placed.toSorted((a, b) => b.start - a.start)) {
    const token = tokens[p.token] as Extract<Token, { kind: "text" }>;
    const current = edited.get(p.token) ?? token.text;
    edited.set(p.token, current.slice(0, p.start) + p.replace + current.slice(p.end));
  }
  const out = tokens
    .map((token, at) => {
      const text = edited.get(at);
      return text === undefined ? token.raw : encodeText(text);
    })
    .join("");
  return { kind: "ok", html: out, text: htmlText(out) };
};
