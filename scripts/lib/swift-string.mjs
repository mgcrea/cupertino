/**
 * A Swift string literal for a string, for the generators that write Swift.
 *
 * They used to borrow `JSON.stringify`, on the strength of JSON and Swift
 * agreeing on `\"`, `\\` and `\n`. They agree on less than that. JSON writes a
 * C0 control as `\u001b`, and backspace and form feed as `\b` and `\f`, and
 * Swift accepts none of the three: its only Unicode escape is `\u{1b}`. A raw
 * DEL goes through JSON untouched, and Swift refuses an unprintable character
 * in source. So a control character pasted into a CHANGELOG bullet or a surface
 * description turned `make app` red, with the compiler pointing at a generated
 * file rather than at the line that caused it.
 *
 * Escaped here: the quote and the backslash, which a Swift literal needs, so an
 * `\(` in the text stays text; newline, return and tab by their short names;
 * every other C0 control, DEL and the two Unicode line separators as `\u{hex}`.
 * Everything else is written literally as UTF-8, which keeps em dashes, «» and
 * typographic quotes readable in the generated source, and keeps the output for
 * ordinary text exactly what `JSON.stringify` produced.
 *
 * A lone surrogate is refused rather than escaped: a Swift String holds Unicode
 * scalars, and `\u{d800}` is not one, so there is no literal to write.
 *
 * Only for Swift. A TypeScript region wants `JSON.stringify`, which is valid
 * there by definition.
 */
export const swiftString = (v) => {
  if (typeof v !== "string") throw new TypeError(`swiftString: not a string (${typeof v})`);
  if (!v.isWellFormed()) throw new Error(`swiftString: lone surrogate in ${JSON.stringify(v)}`);
  let out = '"';
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) {
      out += `\\u{${c.toString(16)}}`;
    } else out += ch;
  }
  return `${out}"`;
};
