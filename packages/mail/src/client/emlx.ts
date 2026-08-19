import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { PreconditionError } from "./errors.js";
import {
  bestBody,
  listAttachments,
  parsePart,
  partBytes,
  summaryHeaders,
  type Attachment,
  type MimePart,
} from "./mime.js";

/**
 * Reading Apple's `.emlx` message files.
 *
 * The container is simple:
 *
 *     1255\n                       <- byte length of the MIME payload
 *     From: ...                    <- exactly that many bytes of RFC 5322
 *     <?xml ...><plist>...</plist> <- Apple's own metadata trailer
 *
 * `.partial.emlx` is the same container with attachment bodies stripped out
 * into a sibling `Attachments/` tree, which is why an attachment can be listed
 * with a name and type but no bytes.
 *
 * The hard part is not the format, it is finding the file. The directory layout
 * is undocumented, so we derive the path, verify it, and fall back to scanning
 * — the derivation is a fast path, not a promise.
 */

export type ParsedMessage = {
  headers: Record<string, string | null>;
  body: string;
  bodyFrom: "text/plain" | "text/html" | "none";
  /** `retrievable` says whether save_attachment can actually fetch the bytes. */
  attachments: (Attachment & { retrievable: boolean })[];
  truncated: boolean;
  sizeBytes: number;
  path: string;
  partial: boolean;
};

/** Hard ceiling, independent of the body budget: some mail is enormous. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The undocumented shard rule: take floor(id / 1000), then use its decimal
 * digits in REVERSE order as nested directory names. Message 198577 lands in
 * `Data/8/9/1/Messages/198577.emlx`. Confirmed 5/5 against a live mail store.
 */
export const shardPath = (rowid: number): string =>
  String(Math.floor(rowid / 1000))
    .split("")
    .toReversed()
    .join("/");

export type LocateMessageOptions = {
  accountDirectory: string;
  /** Mailbox name as Mail spells it, e.g. "INBOX" or "All Mail". */
  mailbox: string;
  rowid: number;
};

/**
 * Find a message file. Derive first (a few `existsSync` calls, microseconds),
 * then scan the mailbox's `Messages/` directories, then give up so the caller
 * can fall back to asking Mail directly.
 */
export const locateEmlx = (
  opts: LocateMessageOptions,
): { path: string; partial: boolean } | null => {
  const mboxDir = join(opts.accountDirectory, `${opts.mailbox}.mbox`);
  if (!existsSync(mboxDir)) return null;

  let inner: string[];
  try {
    inner = readdirSync(mboxDir).filter((d) => !d.startsWith("."));
  } catch {
    return null;
  }

  const relative = join("Data", shardPath(opts.rowid), "Messages");
  const names = [`${opts.rowid}.emlx`, `${opts.rowid}.partial.emlx`];

  // Fast path: the derived shard.
  for (const uuid of inner) {
    for (const name of names) {
      const candidate = join(mboxDir, uuid, relative, name);
      if (existsSync(candidate)) return { path: candidate, partial: name.includes(".partial.") };
    }
  }

  // Slow path. Kept even though the derivation hits reliably today, because it
  // is what stops a future layout change from taking the body lane out entirely.
  for (const uuid of inner) {
    const dataRoot = join(mboxDir, uuid, "Data");
    for (const dir of findMessagesDirs(dataRoot, 0)) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return { path: candidate, partial: name.includes(".partial.") };
      }
    }
  }
  return null;
};

/** Depth-limited walk for `Messages/` directories under a Data root. */
const findMessagesDirs = (root: string, depth: number): string[] => {
  if (depth > 6) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry === "Messages") found.push(full);
    else found.push(...findMessagesDirs(full, depth + 1));
  }
  return found;
};

/** Split the container into its MIME payload, using the length prefix. */
export const splitEmlx = (buf: Buffer): Buffer => {
  const newline = buf.indexOf(0x0a);
  if (newline === -1) return buf;
  const declared = Number.parseInt(buf.subarray(0, newline).toString("ascii").trim(), 10);
  const start = newline + 1;
  if (!Number.isFinite(declared) || declared <= 0) return buf.subarray(start);
  // Trust the prefix, but never read past the end of the file.
  return buf.subarray(start, Math.min(start + declared, buf.length));
};

export const readEmlx = (
  path: string,
  opts: { maxBodyBytes: number; partial?: boolean; rowid?: number },
): ParsedMessage => {
  const stat = statSync(path);
  if (stat.size > MAX_FILE_BYTES) {
    throw new PreconditionError(
      `Message file is ${stat.size} bytes, above the ${MAX_FILE_BYTES}-byte ceiling. ` +
        `Use apple_mail_list_attachments to see what is in it.`,
      { path, sizeBytes: stat.size },
    );
  }

  const mime = splitEmlx(readFileSync(path));
  const root: MimePart = parsePart(mime);
  const picked = bestBody(root);

  const encoded = Buffer.from(picked.text, "utf8");
  const truncated = encoded.length > opts.maxBodyBytes;
  const body = truncated
    ? `${encoded.subarray(0, opts.maxBodyBytes).toString("utf8")}\n\n[truncated: ${encoded.length} bytes total]`
    : picked.text;

  /*
   * Reconcile the parsed attachment list against the disk.
   *
   * Mail almost always moves attachment bodies out to a sidecar tree — on a
   * real store, none of the sampled attachments were inline — so the parse
   * alone cannot say how big an attachment is or whether it can be fetched.
   * `X-Apple-Content-Length` is not the answer either: it records the
   * BASE64-ENCODED length, so a 164156-byte PDF advertises 224634.
   *
   * Statting the sidecar gives the exact size and, more importantly, tells the
   * caller whether apple_mail_save_attachment will actually succeed.
   */
  const attachments = listAttachments(root).map((a) => {
    if (a.inline || !a.filename) return { ...a, retrievable: a.inline };
    const sidecar = locateSidecar(path, opts.rowid ?? -1, a.filename);
    if (!sidecar) return { ...a, sizeBytes: null, retrievable: false };
    try {
      return { ...a, sizeBytes: statSync(sidecar).size, retrievable: true };
    } catch {
      return { ...a, sizeBytes: null, retrievable: false };
    }
  });

  return {
    headers: summaryHeaders(root),
    body,
    bodyFrom: picked.from,
    attachments,
    truncated,
    sizeBytes: stat.size,
    path,
    partial: opts.partial ?? path.includes(".partial."),
  };
};

/** Raw RFC 5322 source, for header forensics. Capped and offsettable. */
export const readEmlxSource = (
  path: string,
  opts: { offset: number; maxBytes: number },
): { source: string; totalBytes: number; truncated: boolean } => {
  const mime = splitEmlx(readFileSync(path));
  const slice = mime.subarray(opts.offset, opts.offset + opts.maxBytes);
  return {
    source: slice.toString("utf8"),
    totalBytes: mime.length,
    truncated: opts.offset + slice.length < mime.length,
  };
};

// ─── attachment extraction ───────────────────────────────────────────────────

const walkParts = (part: MimePart, visit: (p: MimePart) => void): void => {
  visit(part);
  for (const child of part.parts) walkParts(child, visit);
};

/**
 * Pull one attachment's bytes out of a message.
 *
 * For a normal `.emlx` the bytes are in the MIME part. For a `.partial.emlx`
 * Apple has moved them into a sibling `Attachments/<rowid>/<part>/<filename>`
 * tree, so we go looking there instead — which is why an attachment can be
 * listed with a name and type but report a size of zero.
 */
export const extractAttachment = (
  emlxPath: string,
  filename: string,
  rowid: number,
): { bytes: Buffer; from: "inline" | "sidecar" } => {
  const root = parsePart(splitEmlx(readFileSync(emlxPath)));

  let match: MimePart | null = null;
  walkParts(root, (p) => {
    if (!match && p.filename === filename) match = p;
  });
  if (!match) {
    throw new PreconditionError(
      `No attachment named "${filename}" in this message. Use apple_mail_list_attachments to see what is there.`,
    );
  }

  const inline = partBytes(match);
  if (inline.length > 0) return { bytes: inline, from: "inline" };

  // The stripped case — which is the NORMAL one, not an edge case: on a real
  // mail store none of the sampled attachments were inline. Mail moves the
  // bytes to an `Attachments/<rowid>/<part>/<filename>` tree.
  //
  // We search for that tree rather than deriving its path. The message lives at
  // a variable depth (the shard is the digits of rowid/1000, so 5607 nests one
  // level and 198577 nests three), which is precisely what a fixed number of
  // `..` hops got wrong.
  const hit = locateSidecar(emlxPath, rowid, filename);
  if (hit) return { bytes: readFileSync(hit), from: "sidecar" };

  throw new PreconditionError(
    `The attachment "${filename}" is not stored locally. Either it was never downloaded, or ` +
      `this account caches headers only — apple_mail_diagnostics reports the caching policy ` +
      `per account. Opening the message in Mail fetches it.`,
    { emlxPath, rowid },
  );
};

/**
 * Find an attachment's sidecar file.
 *
 * We search for the `Attachments/<rowid>/` tree rather than deriving its path.
 * The message sits at a variable depth — the shard is the digits of rowid/1000,
 * so 5607 nests one level and 198577 nests three — which is exactly what a
 * fixed number of `..` hops got wrong.
 */
export const locateSidecar = (emlxPath: string, rowid: number, filename: string): string | null => {
  let dir = dirname(emlxPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const root = join(dir, "Attachments", String(rowid));
    if (existsSync(root)) {
      const found = findNamedFile(root, filename, 0);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/** Find a file by name anywhere under `root`. Depth-limited; the tree is shallow. */
const findNamedFile = (root: string, filename: string, depth: number): string | null => {
  if (depth > 4) return null;
  for (const entry of safeReaddir(root)) {
    const full = join(root, entry);
    if (entry === filename) return full;
    try {
      if (statSync(full).isDirectory()) {
        const hit = findNamedFile(full, filename, depth + 1);
        if (hit) return hit;
      }
    } catch {
      // Raced with Mail, or unreadable. Keep looking.
    }
  }
  return null;
};

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
