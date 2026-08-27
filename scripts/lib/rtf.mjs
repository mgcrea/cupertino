/**
 * RTF reader — enough of it to pull the plain text out of a Stickies note.
 *
 * ## Why this has to exist
 *
 * Stickies has no scripting dictionary, so there is no Apple Events lane to ask
 * for a note's text. The file lane is the only lane, and what it finds on disk is
 * not a database: each note is an RTFD package whose `TXT.rtf` holds the content.
 * Getting the text out means reading RTF.
 *
 * The alternative was `NSAttributedString` through osascript, which is what
 * `packages/safari/src/client/jxa/bookmarks.ts` does for `Bookmarks.plist`. It is
 * rejected here for one reason: `search_notes` reads EVERY note, and that shape
 * costs one subprocess per note. A reader costs none. This repo already decodes
 * two Apple formats in JS rather than shelling out for them — `typedstream.mjs`
 * for Messages and `note-protobuf.mjs` for Notes — so this is the third instance
 * of a settled pattern rather than a new one.
 *
 * `NSAttributedString` is still what makes it defensible: `scripts/probe-stickies.mjs`
 * decodes every note BOTH ways and fails on any disagreement, so this reader is
 * checked against Cocoa's own answer rather than against expectation.
 *
 * ## Scope
 *
 * Stickies writes its RTF through Cocoa, so the input is always of the shape
 * `{\rtf1\ansi\ansicpg1252\cocoartf…}`. This reader handles that dialect and
 * degrades quietly on anything else: an unknown control word is dropped, not
 * thrown on. It extracts TEXT — not fonts, colours, tables or styling, none of
 * which a tool result needs.
 *
 * ## The three traps, each of which produces plausible wrong output
 *
 * 1. **`\ucN` sets how many characters to skip after `\uN`.** RTF emits a
 *    Unicode character as `\u233` followed by an ANSI approximation for readers
 *    that cannot handle it — typically `\'e9`. Ignoring `\uc` means emitting
 *    BOTH, so every accented character silently doubles. The count is per-group
 *    and inherited by nested groups, so it lives on the group stack.
 *
 * 2. **`\'hh` is a byte in the document's codepage, not Latin-1.** Reading
 *    `\'92` as Latin-1 gives U+0092, an unassigned control character; in
 *    windows-1252 it is a right single quote. Every apostrophe Stickies writes
 *    goes through this path. Consecutive escapes are accumulated and decoded as
 *    one run, so a multi-byte codepage would also come out right.
 *
 * 3. **`\*` destinations must be skipped WHOLE.** `{\*\expandedcolortbl;;}` and
 *    `{\fonttbl…}` are metadata. Descending into them spills font names and
 *    colour tables into the note text. Skipping is inherited down the group
 *    stack, which is why `ignore` is part of the saved state rather than a
 *    single flag.
 *
 * The input MUST be bytes, or a string already decoded as latin1/binary. Handing
 * this a UTF-8-decoded string destroys the byte values trap 2 depends on.
 */

/**
 * Destination groups whose contents are metadata rather than text.
 *
 * `\*` marks an ignorable destination explicitly and is handled separately —
 * this list is for the ones that are NOT marked, because a reader is expected to
 * know them. `NeXTGraphic` is NOT in this list even though it is a destination:
 * an RTFD attachment is not merely metadata to drop, it is one CHARACTER in the
 * text, so it is handled on its own below.
 */
const DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "expandedcolortbl",
  "stylesheet",
  "listtable",
  "listoverridetable",
  "revtbl",
  "rsidtbl",
  "filetbl",
  "info",
  "pict",
  "object",
  "themedata",
  "colorschememapping",
  "datastore",
  "generator",
  "xmlnstbl",
]);

/** Control words that stand for a literal character. */
const LITERALS = new Map([
  ["par", "\n"],
  ["line", "\n"],
  ["sect", "\n"],
  ["page", "\n"],
  ["tab", "\t"],
  ["cell", "\t"],
  ["row", "\n"],
  ["emdash", "—"],
  ["endash", "–"],
  ["emspace", " "],
  ["enspace", " "],
  ["lquote", "‘"],
  ["rquote", "’"],
  ["ldblquote", "“"],
  ["rdblquote", "”"],
  ["bullet", "•"],
]);

/** Control SYMBOLS (a backslash and one non-letter) that stand for a character. */
const SYMBOLS = new Map([
  ["\\", "\\"],
  ["{", "{"],
  ["}", "}"],
  ["~", " "],
  ["_", "‑"],
  ["\n", "\n"],
  ["\r", "\n"],
]);

const decoderFor = (codepage) => {
  // `windows-1252` is the one that matters — it is what Cocoa writes. The rest
  // are here so that a note typed on a machine with a different default does not
  // silently come back as mojibake.
  const label = codepage === 0 || codepage === 1252 ? "windows-1252" : `windows-${codepage}`;
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("windows-1252");
  }
};

/**
 * Decode an RTF document to plain text.
 *
 * @param {Uint8Array | Buffer | string} input bytes, or a latin1-decoded string
 * @returns {string}
 */
export const rtfToText = (input) => {
  // `Buffer.from(input)` COPIES THE CONTENTS. `Buffer.from(input.buffer)` would
  // hand back the whole shared allocation pool a small Buffer is carved out of —
  // which decodes as several kilobytes of unrelated memory that happens to start
  // with the right bytes, and reads as a wildly corrupted note rather than as an
  // error.
  const src = typeof input === "string" ? input : Buffer.from(input).toString("latin1");

  /** @type {string[]} */
  const out = [];
  /** @type {number[]} */
  let bytes = [];
  let codepage = 1252;

  // The group stack. `uc` and `ignore` are both inherited by nested groups, which
  // is the whole reason they are saved and restored rather than kept as globals.
  let state = { uc: 1, ignore: false };
  /** @type {{uc: number, ignore: boolean}[]} */
  const stack = [];

  // How many more characters to swallow after a `\uN`. See trap 1.
  let skip = 0;
  // Set to 1 by an RTFD attachment cell, to swallow its placeholder byte. See
  // the `NeXTGraphic` branch.
  let dropPlaceholder = 0;

  const flush = () => {
    if (!bytes.length) return;
    if (!state.ignore) out.push(decoderFor(codepage).decode(Uint8Array.from(bytes)));
    bytes = [];
  };
  const emit = (text) => {
    flush();
    if (!state.ignore) out.push(text);
  };

  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === "{") {
      flush();
      stack.push({ ...state });
      i += 1;
      continue;
    }

    if (ch === "}") {
      flush();
      state = stack.pop() ?? { uc: 1, ignore: false };
      i += 1;
      continue;
    }

    if (ch === "\\") {
      const next = src[i + 1];

      // A control WORD: letters, an optional signed parameter, and an optional
      // single trailing space that is a delimiter rather than content.
      if (next !== undefined && /[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(src[j])) j += 1;
        const word = src.slice(i + 1, j);

        let param = null;
        if (src[j] === "-" || /[0-9]/.test(src[j] ?? "")) {
          let k = src[j] === "-" ? j + 1 : j;
          while (k < n && /[0-9]/.test(src[k])) k += 1;
          param = Number.parseInt(src.slice(j, k), 10);
          j = k;
        }
        if (src[j] === " ") j += 1;
        i = j;

        // `\bin N` is followed by N raw bytes that are not RTF at all.
        if (word === "bin") {
          i += Math.max(0, param ?? 0);
          continue;
        }

        if (word === "u") {
          // Negative parameters are the 16-bit wrap-around older writers use.
          let code = param ?? 0;
          if (code < 0) code += 0x10000;
          if (skip > 0) skip -= 1;
          else emit(String.fromCodePoint(code));
          skip = state.uc;
          continue;
        }

        // Every other control word counts as one skippable character after `\u`.
        if (skip > 0) {
          skip -= 1;
          continue;
        }

        if (word === "uc") {
          state.uc = param ?? 1;
          continue;
        }
        if (word === "ansicpg") {
          codepage = param ?? 1252;
          continue;
        }
        if (word === "NeXTGraphic") {
          // An RTFD attachment, which arrives as
          //     {{\NeXTGraphic name.jpg \width... }<placeholder>}
          // Cocoa represents the whole construct as ONE character, U+FFFC OBJECT
          // REPLACEMENT CHARACTER. The byte after the inner group is that
          // placeholder written in the document's codepage — 0xAC, "¬", in
          // cp1252 — so a reader that skips the destination and then takes the
          // next literal emits a stray "¬" of exactly the right length. That is
          // why the probe's length check could not see this and its hash could.
          emit("\uFFFC");
          state.ignore = true;
          dropPlaceholder = 1;
          continue;
        }
        if (DESTINATIONS.has(word)) {
          flush();
          state.ignore = true;
          continue;
        }
        const literal = LITERALS.get(word);
        if (literal !== undefined) emit(literal);
        continue;
      }

      // A control SYMBOL: the backslash and exactly one character.
      if (next === "'") {
        const hex = src.slice(i + 2, i + 4);
        i += 4;
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        const byte = Number.parseInt(hex, 16);
        if (!Number.isNaN(byte) && !state.ignore) bytes.push(byte);
        continue;
      }

      i += 2;
      if (next === "*") {
        // The explicit ignorable-destination marker. Everything to the matching
        // brace is metadata — see trap 3.
        flush();
        state.ignore = true;
        continue;
      }
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      const symbol = SYMBOLS.get(next);
      if (symbol !== undefined) emit(symbol);
      continue;
    }

    // Literal text. Line breaks in the SOURCE are formatting, not content — a
    // paragraph is `\par`, never a newline in the file.
    i += 1;
    if (ch === "\n" || ch === "\r") continue;
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    if (dropPlaceholder > 0 && !state.ignore) {
      dropPlaceholder -= 1;
      continue;
    }
    if (!state.ignore) bytes.push(ch.charCodeAt(0) & 0xff);
  }

  flush();
  return out.join("");
};

/**
 * The text of a note, trimmed the way a caller wants to see it.
 *
 * Cocoa ends the document with a trailing `\par` more often than not, so the raw
 * decode usually carries a final newline that is an artefact of the writer rather
 * than something the user typed.
 */
export const rtfToPlainText = (input) => rtfToText(input).replace(/\s+$/, "");

/**
 * The first non-empty line, which is what every Apple notes-shaped app uses as a
 * title. Notes derives `ZTITLE1` the same way, so a Stickies note and a Notes
 * note title by the same rule.
 */
export const titleOf = (text, max = 120) => {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};
