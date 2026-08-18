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
  sizeBytes: number;
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
    filename:
      headerParam(dispositionRaw, "filename") ?? headerParam(contentTypeRaw, "name") ?? null,
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
  const segments: string[] = [];
  let index = text.indexOf(marker);
  if (index === -1) return [];

  while (index !== -1) {
    const afterMarker = index + marker.length;
    if (text.startsWith("--", afterMarker)) break; // closing delimiter
    const start = afterMarker;
    const next = text.indexOf(marker, start);
    segments.push(text.slice(start, next === -1 ? undefined : next).replace(/^\r?\n/, ""));
    if (next === -1) break;
    index = next;
  }
  return segments.map((s) => parsePart(Buffer.from(s, "latin1")));
};

/** Decode one leaf part's body into text. */
export const partText = (part: MimePart): string => {
  let bytes = part.raw;
  if (part.encoding === "base64") bytes = decodeBase64(part.raw.toString("latin1"));
  else if (part.encoding === "quoted-printable")
    bytes = decodeQuotedPrintable(part.raw.toString("latin1"));
  return decodeCharset(bytes, part.charset);
};

/** Very small HTML-to-text pass: enough to read a marketing email, not a renderer. */
export const htmlToText = (html: string): string =>
  html
    .replaceAll(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replaceAll(/<li[^>]*>/gi, "- ")
    .replaceAll(/<[^>]+>/g, "")
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

/**
 * Pick the body a person would want to read: the first text/plain that is not
 * an attachment, else the first text/html converted to text.
 */
export const bestBody = (
  root: MimePart,
): { text: string; from: "text/plain" | "text/html" | "none" } => {
  let plain: MimePart | null = null;
  let html: MimePart | null = null;

  walk(root, (p) => {
    if (p.disposition === "attachment") return;
    if (!plain && p.contentType === "text/plain") plain = p;
    if (!html && p.contentType === "text/html") html = p;
  });

  if (plain) return { text: partText(plain).trim(), from: "text/plain" };
  if (html) return { text: htmlToText(partText(html)), from: "text/html" };
  return { text: "", from: "none" };
};

export const listAttachments = (root: MimePart): Attachment[] => {
  const found: Attachment[] = [];
  walk(root, (p) => {
    const isAttachment =
      p.disposition === "attachment" ||
      (p.filename !== null && !p.contentType.startsWith("multipart/"));
    if (!isAttachment || p.contentType.startsWith("multipart/")) return;
    found.push({
      filename: p.filename,
      contentType: p.contentType,
      contentId: p.contentId,
      sizeBytes: p.raw.length,
      // Apple strips attachment bodies out of .partial.emlx; an empty leaf with
      // a filename means the bytes live in the sidecar Attachments tree.
      inline: p.raw.length > 0,
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
