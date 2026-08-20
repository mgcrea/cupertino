import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
 * Why a lookup failed, so the caller can say something true.
 *
 * `permission` matters because the obvious probe lies: `existsSync` is
 * stat-based and SUCCEEDS on a TCC-protected path, while `readdirSync` and
 * `readFileSync` return EPERM. Without Full Disk Access we therefore get past
 * the directory check and die on the first read — which is a different problem
 * from a path that is simply not there, and needs a different sentence.
 */
export type EmlxLookup =
  | { found: true; path: string; partial: boolean }
  | {
      found: false;
      reason: "no-mailbox-dir" | "no-message-file" | "permission";
      /** The `.mbox` directories the mailbox name resolved to. */
      mailboxDirs: string[];
      /** Concrete paths we looked for the message file at. */
      probed: string[];
    };

/**
 * Find a message file. Derive first (a few `existsSync` calls, microseconds),
 * then scan the mailbox's `Messages/` directories, then give up so the caller
 * can fall back to asking Mail directly.
 *
 * The mailbox name is resolved to a directory rather than joined onto the
 * account root, because providers nest: a Gmail account keeps its special
 * mailboxes under `[Gmail].mbox/`, so `All Mail` is not at
 * `<account>/All Mail.mbox` and the flat join found nothing — which took the
 * whole message-file lane out on those accounts without ever saying so.
 */
export const lookupEmlx = (opts: LocateMessageOptions): EmlxLookup => {
  const search = new MailboxSearch(opts.rowid);

  // Fast path: the mailbox name spells its own directory. A flat `INBOX` costs
  // one stat and no walk at all, exactly as it did before nesting was handled.
  const derived = derivedMailboxDir(opts.accountDirectory, opts.mailbox);
  if (isDirectory(derived)) {
    const hit = search.in(derived);
    if (hit) return hit;
  }

  /*
   * Fallback: find the directory by name. A ref carries only a bare leaf, so
   * `All Mail` has to be located inside whatever container holds it, and more
   * than one container may hold that name. Try each; the one holding this rowid
   * is the answer, which settles the ambiguity against the message that
   * actually exists rather than by guessing at the name.
   */
  const mboxDirs = resolveMailboxDirs(opts.accountDirectory, opts.mailbox).filter(
    (d) => d !== derived,
  );
  for (const mboxDir of mboxDirs) {
    const hit = search.in(mboxDir);
    if (hit) return hit;
  }

  const searched = [...(isDirectory(derived) ? [derived] : []), ...mboxDirs];
  if (searched.length === 0) {
    // Nothing resolved, but "not there" and "not allowed to look" are different
    // answers: without Full Disk Access the walk's readdirs all fail silently.
    let reason: "no-mailbox-dir" | "permission" = "no-mailbox-dir";
    try {
      readdirSync(opts.accountDirectory);
    } catch (err) {
      if (isPermissionError(err)) reason = "permission";
    }
    return { found: false, reason, mailboxDirs: [], probed: [derived] };
  }

  return {
    found: false,
    reason: search.denied ? "permission" : "no-message-file",
    mailboxDirs: searched,
    probed: search.probed,
  };
};

/** Looks for one rowid inside a `.mbox` directory, remembering where it looked. */
class MailboxSearch {
  readonly probed: string[] = [];
  denied = false;
  readonly #relative: string;
  readonly #names: string[];

  constructor(rowid: number) {
    this.#relative = join("Data", shardPath(rowid), "Messages");
    this.#names = [`${rowid}.emlx`, `${rowid}.partial.emlx`];
  }

  in(mboxDir: string): Extract<EmlxLookup, { found: true }> | null {
    let inner: string[];
    try {
      inner = readdirSync(mboxDir).filter((d) => !d.startsWith("."));
    } catch (err) {
      if (isPermissionError(err)) this.denied = true;
      return null;
    }

    // Fast path: the derived shard.
    for (const uuid of inner) {
      for (const name of this.#names) {
        const candidate = join(mboxDir, uuid, this.#relative, name);
        this.probed.push(candidate);
        if (existsSync(candidate)) return foundAt(candidate, name);
      }
    }

    // Slow path. Kept even though the derivation hits reliably today, because it
    // is what stops a future layout change from taking the body lane out entirely.
    for (const uuid of inner) {
      const dataRoot = join(mboxDir, uuid, "Data");
      for (const dir of findMessagesDirs(dataRoot, 0)) {
        for (const name of this.#names) {
          const candidate = join(dir, name);
          if (existsSync(candidate)) return foundAt(candidate, name);
        }
      }
    }
    return null;
  }
}

const foundAt = (path: string, name: string): Extract<EmlxLookup, { found: true }> => ({
  found: true,
  path,
  partial: name.includes(".partial."),
});

/** The `path | null` shape most callers want. See `lookupEmlx` for the reason. */
export const locateEmlx = (
  opts: LocateMessageOptions,
): { path: string; partial: boolean } | null => {
  const found = lookupEmlx(opts);
  return found.found ? { path: found.path, partial: found.partial } : null;
};

// ─── mailbox name → on-disk directory ────────────────────────────────────────

/** Depth cap for the `.mbox` walk. Matches `findMessagesDirs`. */
const MAX_MBOX_DEPTH = 6;

/** `[Gmail]/All Mail` -> `<account>/[Gmail].mbox/All Mail.mbox`. */
const derivedMailboxDir = (accountDirectory: string, mailbox: string): string =>
  join(accountDirectory, ...mailbox.split("/").map((segment) => `${segment}.mbox`));

/**
 * Resolve a mailbox name to every `.mbox` directory that could be it.
 *
 * This is the inverse of the ladder `MailboxMap.resolveMailboxName` and the JXA
 * `resolveMailbox` walk (exact, `[Gmail]/`-stripped, final segment, then
 * case-insensitive): those take a path and find a mailbox Mail knows about,
 * this takes the bare leaf name that survives into a ref and finds the nested
 * container holding it.
 *
 * Deliberately generic rather than special-casing `[Gmail]`: Exchange and other
 * providers nest too, and a Gmail label `Work/Projects` lands two levels deep as
 * `Work.mbox/Projects.mbox`.
 */
export const resolveMailboxDirs = (accountDirectory: string, mailbox: string): string[] => {
  // The name may spell its own path: a flat `INBOX.mbox`, or an explicit
  // `[Gmail]/All Mail`. That goes first, but it does not end the search — a flat
  // `Archive.mbox` existing does not prove this message is in it rather than in
  // a nested one of the same name, and the caller settles that by rowid.
  const derived = derivedMailboxDir(accountDirectory, mailbox);
  const first = isDirectory(derived) ? [derived] : [];

  const candidates = mailboxNameCandidates(mailbox);
  const exact: string[] = [];
  const insensitive: string[] = [];
  const lowered = candidates.map((c) => c.toLowerCase());

  // Breadth-first so shallower matches are offered before deeper ones. Only
  // `.mbox` entries are ever opened, so the walk never descends into `Data/` —
  // that is what keeps this to tens of small readdirs instead of a scan over
  // every message shard in the account.
  let frontier = [accountDirectory];
  for (let depth = 0; depth < MAX_MBOX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      for (const entry of safeReaddir(dir)) {
        if (!entry.endsWith(".mbox") || entry.startsWith(".")) continue;
        const full = join(dir, entry);
        if (!isDirectory(full)) continue;
        const name = basename(entry, ".mbox");
        if (candidates.includes(name)) exact.push(full);
        else if (lowered.includes(name.toLowerCase())) insensitive.push(full);
        // Recurse regardless: a mailbox can be both a match and a container.
        next.push(full);
      }
    }
    frontier = next;
  }

  return [...new Set([...first, ...exact, ...insensitive])];
};

/** Exact, `[Gmail]/`-stripped, then final segment — the shared ladder's names. */
const mailboxNameCandidates = (mailbox: string): string[] => {
  const candidates = [mailbox];
  if (mailbox.startsWith("[Gmail]/")) candidates.push(mailbox.slice(8));
  if (mailbox.includes("/")) {
    const last = mailbox.split("/").pop();
    if (last) candidates.push(last);
  }
  return candidates;
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isPermissionError = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === "EPERM" || code === "EACCES";
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
