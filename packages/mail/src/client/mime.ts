/**
 * A small MIME reader, hand-rolled to keep the dependency count at two.
 *
 * It does the parts that actually come up when reading real mail — RFC 2047
 * headers, base64 and quoted-printable bodies, multipart walking, charset
 * decoding, and picking the part a human would want to read — and nothing else.
 * It is not a general-purpose MIME library and does not try to be.
 */

export type Header = { name: string; value: string };

export type MimePart = {
  headers: Header[];
  contentType: string;
  charset: string | null;
  encoding: string | null;
  disposition: string | null;
  filename: string | null;
  contentId: string | null;
  /** Raw (still-encoded) body for leaf parts. */
  raw: Buffer;
  parts: MimePart[];
};

export type Attachment = {
  filename: string | null;
  contentType: string;
  contentId: string | null;
  /**
   * Size in bytes, or null if genuinely unknowable.
   *
   * The DECODED length when the bytes are in this file, otherwise null — the
   * parser cannot know. `readEmlx` fills it in from the sidecar file on disk,
   * which is both exact and the only way to know if it can be fetched. Never 0,
   * which would read as a measurement rather than an absence.
   */
  sizeBytes: number | null;
  /** False when the bytes were stripped into a sidecar file (.partial.emlx). */
  inline: boolean;
};

// ─── headers ─────────────────────────────────────────────────────────────────

const decodeBase64 = (s: string): Buffer => Buffer.from(s, "base64");

const decodeQuotedPrintable = (s: string, forHeader = false): Buffer => {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === "=" && i + 1 < s.length) {
      const next = s.slice(i + 1, i + 3);
      if (next === "\r\n" || next[0] === "\n") {
        // Soft line break: the newline is not part of the content.
        i += next[0] === "\n" ? 1 : 2;
        continue;
      }
      if (/^[0-9A-Fa-f]{2}$/.test(next)) {
        bytes.push(Number.parseInt(next, 16));
        i += 2;
        continue;
      }
    }
    if (forHeader && ch === "_") {
      // In encoded words, underscore means space. Only there.
      bytes.push(0x20);
      continue;
    }
    bytes.push(ch.charCodeAt(0));
  }
  return Buffer.from(bytes);
};

export const decodeCharset = (buf: Buffer, charset: string | null): string => {
  const label = (charset ?? "utf-8").toLowerCase().replaceAll(/["']/g, "");
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    // An unknown or misspelled charset should not lose the message.
    return buf.toString("utf8");
  }
};

/**
 * Decode RFC 2047 encoded words, e.g. `=?UTF-8?Q?Facture_5753?=`.
 *
 * Adjacent encoded words separated only by whitespace are joined without it,
 * which is what the RFC requires and what makes multi-word subjects come out
 * right instead of gaining stray spaces.
 */
export const decodeEncodedWords = (input: string): string => {
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let result = "";
  let lastEnd = 0;
  let previousWasEncoded = false;

  for (const match of input.matchAll(pattern)) {
    const start = match.index;
    const between = input.slice(lastEnd, start);
    if (!(previousWasEncoded && between.trim() === "")) result += between;

    const [, charset, kind, payload] = match;
    const decoded =
      kind?.toLowerCase() === "b"
        ? decodeCharset(decodeBase64(payload ?? ""), charset ?? null)
        : decodeCharset(decodeQuotedPrintable(payload ?? "", true), charset ?? null);
    result += decoded;

    lastEnd = start + match[0].length;
    previousWasEncoded = true;
  }
  return result + input.slice(lastEnd);
};

/** Split a header block into unfolded name/value pairs. */
export const parseHeaders = (block: string): Header[] => {
  const headers: Header[] = [];
  // Continuation lines start with whitespace and belong to the previous header.
  const lines = block.split(/\r?\n/);
  let current: string | null = null;

  const flush = () => {
    if (current === null) return;
    const idx = current.indexOf(":");
    if (idx > 0) {
      headers.push({ name: current.slice(0, idx).trim(), value: current.slice(idx + 1).trim() });
    }
    current = null;
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== null) current += ` ${line.trim()}`;
    else {
      flush();
      current = line;
    }
  }
  flush();
  return headers;
};

export const headerValue = (headers: Header[], name: string): string | null =>
  headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

/** Pull a parameter out of a structured header, handling quotes. */
export const headerParam = (value: string | null, param: string): string | null => {
  if (!value) return null;
  const match = new RegExp(`${param}\\s*=\\s*"([^"]*)"|${param}\\s*=\\s*([^;\\s]+)`, "i").exec(
    value,
  );
  return match ? (match[1] ?? match[2] ?? null) : null;
};

/**
 * The filename a part actually carries, through both ways of spelling one.
 *
 * `headerParam` reads `filename="x"` and nothing else, which is fine for
 * `charset` and `boundary` — both plain ASCII tokens by definition — and wrong
 * for a filename, because a filename is the one parameter that routinely is not
 * ASCII. Two encodings exist for it and mail uses both:
 *
 *   RFC 2231  `filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`
 *             also split across `filename*0*=`, `filename*1*=` for long names
 *   RFC 2047  `name="=?utf-8?Q?r=C3=A9sum=C3=A9=2Epdf?="`
 *
 * Neither was handled. The first returned null, so an attachment with an
 * accented name was reported as having no filename at all — which
 * `list_attachments` shows as unretrievable and `save_attachment` cannot write.
 * The second came back verbatim, so saving it wrote a file literally named
 * `=?utf-8?Q?...?=` on disk.
 *
 * RFC 2231 is tried first because it is the one designed for this; the RFC 2047
 * form in a parameter is technically not allowed and is nonetheless everywhere.
 */
export const headerFilename = (
  disposition: string | null,
  contentType: string | null,
): string | null => {
  for (const [value, param] of [
    [disposition, "filename"],
    [contentType, "name"],
  ] as const) {
    if (!value) continue;
    const extended = extendedParam(value, param);
    if (extended !== null) return extended;
    const plain = headerParam(value, param);
    if (plain !== null) return decodeEncodedWords(plain);
  }
  return null;
};

/**
 * The RFC 2231 form, including the numbered continuations long names use.
 *
 * A continuation is only percent-decoded when its own segment is starred —
 * `filename*1=` is literal text and `filename*1*=` is encoded, and treating the
 * two alike turns a legitimate `%` in a filename into mojibake.
 */
const extendedParam = (value: string, param: string): string | null => {
  const single = new RegExp(`${param}\\*\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i").exec(value);
  if (single) return decodeExtended(single[1] ?? single[2] ?? "", true);

  const segments: { index: number; text: string; encoded: boolean }[] = [];
  const pattern = new RegExp(`${param}\\*(\\d+)(\\*)?\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "gi");
  for (const match of value.matchAll(pattern)) {
    segments.push({
      index: Number(match[1]),
      text: match[3] ?? match[4] ?? "",
      encoded: match[2] === "*",
    });
  }
  if (segments.length === 0) return null;
  segments.sort((a, b) => a.index - b.index);

  // The charset prefix rides on the first segment only.
  let charset: string | null = null;
  let out = "";
  for (const [position, segment] of segments.entries()) {
    if (!segment.encoded) {
      out += segment.text;
      continue;
    }
    if (position === 0) {
      const parts = segment.text.split("'");
      if (parts.length >= 3) {
        charset = parts[0] || null;
        out += percentDecode(parts.slice(2).join("'"), charset);
        continue;
      }
    }
    out += percentDecode(segment.text, charset);
  }
  return out;
};

const decodeExtended = (raw: string, hasCharsetPrefix: boolean): string => {
  if (!hasCharsetPrefix) return percentDecode(raw, null);
  const parts = raw.split("'");
  // charset'language'text — anything shorter is not the extended form.
  if (parts.length < 3) return percentDecode(raw, null);
  return percentDecode(parts.slice(2).join("'"), parts[0] || null);
};

/** Percent-decoded as BYTES, then read in the charset the header named. */
const percentDecode = (raw: string, charset: string | null): string => {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "%" && /^[0-9a-f]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(raw.charCodeAt(i) & 0xff);
    }
  }
  return decodeCharset(Buffer.from(bytes), charset);
};

// ─── body ────────────────────────────────────────────────────────────────────

const HEADER_BODY_SPLIT = /\r?\n\r?\n/;

export const parsePart = (buf: Buffer): MimePart => {
  const text = buf.toString("latin1"); // byte-preserving: real decoding happens per-part
  const split = HEADER_BODY_SPLIT.exec(text);
  const headerBlock = split ? text.slice(0, split.index) : text;
  const bodyStart = split ? split.index + split[0].length : text.length;

  const headers = parseHeaders(headerBlock);
  const contentTypeRaw = headerValue(headers, "content-type");
  const contentType = (contentTypeRaw?.split(";")[0] ?? "text/plain").trim().toLowerCase();
  const dispositionRaw = headerValue(headers, "content-disposition");

  const part: MimePart = {
    headers,
    contentType,
    charset: headerParam(contentTypeRaw, "charset"),
    encoding: headerValue(headers, "content-transfer-encoding")?.trim().toLowerCase() ?? null,
    disposition: dispositionRaw?.split(";")[0]?.trim().toLowerCase() ?? null,
    filename: headerFilename(dispositionRaw, contentTypeRaw),
    contentId: headerValue(headers, "content-id")?.replaceAll(/[<>]/g, "") ?? null,
    raw: Buffer.from(text.slice(bodyStart), "latin1"),
    parts: [],
  };

  if (contentType.startsWith("multipart/")) {
    const boundary = headerParam(contentTypeRaw, "boundary");
    if (boundary) part.parts = splitMultipart(part.raw, boundary);
  }
  return part;
};

const splitMultipart = (body: Buffer, boundary: string): MimePart[] => {
  const text = body.toString("latin1");
  const marker = `--${boundary}`;

  /**
   * RFC 2046: a delimiter starts a line, and nothing follows it but the closing
   * `--` or the end of that line. Both halves earn their keep. Without the
   * first, a body that merely quotes the delimiter splits the part it sits in.
   * Without the second, `--B` also matches inside `--B2`, which flattened a
   * nested multipart into its parent's sibling list — harmless while only one
   * part was ever read, and a doubled body the moment the parts are joined.
   */
  const isDelimiter = (at: number): boolean => {
    if (at !== 0 && text[at - 1] !== "\n") return false;
    const after = text[at + marker.length];
    return after === undefined || after === "\r" || after === "\n" || after === "-";
  };
  const find = (from: number): number => {
    let at = text.indexOf(marker, from);
    while (at !== -1 && !isDelimiter(at)) at = text.indexOf(marker, at + 1);
    return at;
  };

  const segments: string[] = [];
  let index = find(0);
  if (index === -1) return [];

  while (index !== -1) {
    const afterMarker = index + marker.length;
    if (text.startsWith("--", afterMarker)) break; // closing delimiter
    const next = find(afterMarker);
    segments.push(text.slice(afterMarker, next === -1 ? undefined : next).replace(/^\r?\n/, ""));
    if (next === -1) break;
    index = next;
  }
  return segments.map((s) => parsePart(Buffer.from(s, "latin1")));
};

/**
 * Decode one leaf part's body to raw bytes.
 *
 * Shared rather than duplicated: `emlx.ts` needs the same decoding to extract
 * attachment contents, and two copies of a transfer-encoding switch is how the
 * two ends up disagreeing about what a part contains.
 */
export const partBytes = (part: MimePart): Buffer => {
  if (part.encoding === "base64") return decodeBase64(part.raw.toString("latin1"));
  if (part.encoding === "quoted-printable")
    return decodeQuotedPrintable(part.raw.toString("latin1"));
  return part.raw;
};

/** Decode one leaf part's body into text. */
export const partText = (part: MimePart): string => decodeCharset(partBytes(part), part.charset);

/** Very small HTML-to-text pass: enough to read a marketing email, not a renderer. */
export const htmlToText = (html: string): string =>
  html
    .replaceAll(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    // The rule above needs a closing tag. The scan lane parses only the first
    // maxBytes of a file, so a style block routinely has none — and the tag
    // stripper then left the CSS behind as prose for a body search to match.
    .replaceAll(/<(script|style)[^>]*>[\s\S]*$/gi, "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replaceAll(/<li[^>]*>/gi, "- ")
    .replaceAll(/<[^>]+>/g, "")
    // A tag cut off mid-attribute. Anchored on a tag name so that prose using a
    // bare "<" as a less-than sign keeps it.
    .replaceAll(/<\/?[a-zA-Z][^>]*$/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replaceAll(/[ \t]+\n/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();

const walk = (part: MimePart, visit: (p: MimePart) => void): void => {
  visit(part);
  for (const child of part.parts) walk(child, visit);
};

type BodyFrom = "text/plain" | "text/html" | "none";

/**
 * Is this part a file rather than something to read?
 *
 * Deliberately shared with `listAttachments`. The two used to disagree — this
 * one excluded only `disposition: attachment`, that one also counted any
 * non-multipart part carrying a filename — and the disagreement was harmless
 * only because a single part was ever chosen as the body. Joining the parts
 * made it visible, as an attached notes.txt landing in the mail it came with.
 */
const isAttachmentPart = (p: MimePart): boolean =>
  p.disposition === "attachment" ||
  (p.filename !== null && !p.contentType.startsWith("multipart/"));

/**
 * A run of body text, or a note that a file sat between two of them.
 *
 * Markers cannot be resolved to text on the way up: inside a `related` part an
 * image is a trailing marker and would be dropped, while at the root the same
 * image sits between two runs and has to survive. So the tagging lasts until
 * `bestBody` collapses the whole thing, once.
 */
type Segment = { kind: "text" | "marker"; text: string };
type Resolved = { segments: Segment[]; from: BodyFrom };

const NOTHING: Resolved = { segments: [], from: "none" };

const hasText = (r: Resolved): boolean =>
  r.segments.some((s) => s.kind === "text" && s.text.trim() !== "");

/** `[image: shot.png]` — house style is the truncation marker's: label, colon, fact. */
const markerFor = (p: MimePart): Segment => ({
  kind: "marker",
  text: `[${p.contentType.startsWith("image/") ? "image" : "attachment"}: ${
    p.filename ?? p.contentType
  }]`,
});

/**
 * Resolve one subtree to the runs a person would read, in document order.
 *
 * The container decides. `multipart/alternative` children are competing
 * renderings of one thing, so exactly one is taken; every other multipart holds
 * sequential content, so the children are spliced in order. A flat walk that
 * gathered all the text parts would read the interleaved message correctly and
 * emit a plain+html alternative twice.
 */
const resolveBody = (part: MimePart, isFile: (p: MimePart) => boolean): Resolved => {
  if (part.contentType.startsWith("multipart/")) {
    // No children means the boundary never appeared. The whole body is still
    // sitting in `raw`, but it is delimiters and headers, not prose.
    if (part.parts.length === 0) return NOTHING;
    const children = part.parts.map((child) => resolveBody(child, isFile));

    if (part.contentType === "multipart/alternative") {
      // Only a rendering that actually says something can win. An empty
      // text/plain alternative used to, reporting an empty body with the real
      // content one part away.
      return (
        children.find((c) => c.from === "text/plain" && hasText(c)) ??
        children.find((c) => c.from === "text/html" && hasText(c)) ??
        NOTHING
      );
    }

    // mixed, related, signed, report, anything unknown. `related` is sequential
    // on purpose: Mail emits related{ html, file, html } for a reply carrying
    // one file, so reading it as RFC 2387's root-plus-resources drops half.
    const contributing = children.filter(hasText);
    return {
      segments: children.flatMap((c) => c.segments),
      from: contributing.some((c) => c.from === "text/html")
        ? "text/html"
        : contributing.some((c) => c.from === "text/plain")
          ? "text/plain"
          : "none",
    };
  }

  if (isFile(part)) return { segments: [markerFor(part)], from: "none" };
  if (part.contentType === "text/plain")
    return { segments: [{ kind: "text", text: partText(part).trim() }], from: "text/plain" };
  if (part.contentType === "text/html")
    return { segments: [{ kind: "text", text: htmlToText(partText(part)) }], from: "text/html" };
  // Not text and not flagged as a file — a cid image, a forwarded message.
  // Still worth marking: it is a thing the reader saw at this point.
  return { segments: [markerFor(part)], from: "none" };
};

/**
 * The body a person would want to read: every run of it, in order.
 *
 * `from` reports the worst provenance of the runs that contributed, not the
 * first. It is the caller's only warning that the text went through
 * `htmlToText`, and a concatenation that is half derived must not claim to be
 * text/plain just because its first run was.
 */
export const bestBody = (root: MimePart): { text: string; from: BodyFrom } => {
  const strict = resolveBody(root, isAttachmentPart);
  // The shared predicate is stricter than the disposition-only test this used
  // to apply, so a message whose ONLY text part carries a filename would go
  // from readable to empty. Losing a whole message to that is worse than the
  // notes.txt it was tightened for, so fall back rather than go silent.
  const resolved = hasText(strict)
    ? strict
    : resolveBody(root, (p) => p.disposition === "attachment");

  const kept = resolved.segments.filter((s) => s.kind === "marker" || s.text.trim() !== "");
  // A marker exists to deny an adjacency the message does not have. One at the
  // head or the tail separates nothing, and would append a line to every mail
  // that merely carries a file.
  let first = 0;
  let last = kept.length;
  while (first < last && kept[first]!.kind === "marker") first += 1;
  while (last > first && kept[last - 1]!.kind === "marker") last -= 1;

  const text = kept
    .slice(first, last)
    .map((s) => s.text)
    .join("\n\n")
    .trim();
  return { text, from: text === "" ? "none" : resolved.from };
};

/**
 * Does a decoded part carry actual content?
 *
 * Stripping an attachment out to the sidecar tree leaves the part's delimiter
 * whitespace behind, so `length > 0` is not the question — "is any of it not
 * whitespace" is. A size threshold would work too but would be a magic number,
 * and would misjudge a genuinely tiny attachment.
 */
const hasContent = (bytes: Buffer): boolean => {
  for (const byte of bytes) {
    // tab, LF, VT, FF, CR, space
    const isSpace =
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0b ||
      byte === 0x0c ||
      byte === 0x0d ||
      byte === 0x20;
    if (!isSpace) return true;
  }
  return false;
};

export const listAttachments = (root: MimePart): Attachment[] => {
  const found: Attachment[] = [];
  walk(root, (p) => {
    if (!isAttachmentPart(p) || p.contentType.startsWith("multipart/")) return;
    // Measure the DECODED payload. `raw` is still transfer-encoded, so a base64
    // part would otherwise report roughly 4/3 of its true size.
    const decoded = partBytes(p);

    // Apple strips attachment bodies out into a sidecar tree for .partial.emlx,
    // leaving only delimiter whitespace. Testing `> 0` therefore reported a
    // stripped 250 KB PDF as present with a size of 1 byte — telling callers
    // save_attachment would work when it could not.
    const present = hasContent(decoded);

    // Deliberately NOT falling back to X-Apple-Content-Length here: that header
    // records the base64-ENCODED length, so a 164156-byte PDF advertises 224634.
    // The exact size comes from statting the sidecar file, which the emlx layer
    // does because it is the part that knows where the message lives on disk.
    found.push({
      filename: p.filename,
      contentType: p.contentType,
      contentId: p.contentId,
      sizeBytes: present ? decoded.length : null,
      inline: present,
    });
  });
  return found;
};

/** The headers worth surfacing, decoded. */
export const summaryHeaders = (root: MimePart): Record<string, string | null> => {
  const pick = (name: string): string | null => {
    const value = headerValue(root.headers, name);
    return value === null ? null : decodeEncodedWords(value);
  };
  return {
    from: pick("from"),
    to: pick("to"),
    cc: pick("cc"),
    replyTo: pick("reply-to"),
    subject: pick("subject"),
    date: pick("date"),
    messageId: headerValue(root.headers, "message-id"),
  };
};
