import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import type { Config } from "../config.js";
import { scanBodies } from "./body-scan.js";
import {
  extractAttachment,
  lookupEmlx,
  readEmlx,
  readEmlxSource,
  type EmlxLookup,
  type ParsedMessage,
} from "./emlx.js";
import { EnvelopeIndex, openIndex, type MessageRow, type SearchFilters } from "./envelope.js";
import { MAIL_SURFACE, MessageNotFoundError, PreconditionError } from "./errors.js";
import { COUNT_MAILBOX, GET_MESSAGES, LIST_MAILBOXES, LIST_RECENT } from "./jxa/read.js";
import {
  COMPOSER_ACCESS,
  CHECK_FOR_NEW_MAIL,
  CREATE_MAILBOX,
  DELETE_MESSAGES,
  MOVE_MESSAGES,
  REPLY_OR_FORWARD,
  SEND_MESSAGE,
  SET_FLAGS,
  UPDATE_DRAFT,
} from "./jxa/write.js";
import { locateEnvelopeIndex, type LocateResult } from "./locate.js";
import { MailboxMap, type MailAccount } from "./mailbox-map.js";
import {
  createOsascriptRunner,
  type Logger,
  type OsascriptRunner,
  withBusyRetry,
} from "./osascript.js";
import { decodeRef, encodeRef, groupRefsByMailbox, type MessageRef } from "./ref.js";

/**
 * The facade every tool talks to. It owns three things the tools should not
 * each re-decide: which lane answers a question, what to say when a lane is
 * unavailable, and the read-after-write rule.
 */

export type MessageSummary = {
  ref: string;
  id: number;
  accountUuid: string;
  mailbox: string;
  subject: string | null;
  sender: string | null;
  dateReceived: string | null;
  dateSent?: string | null;
  messageId?: string | null;
  read: boolean | null;
  flagged?: boolean | null;
  junk?: boolean | null;
  size?: number | null;
  content?: string | null;
  source?: string | null;
  allHeaders?: string | null;
};

export type LaneStatus = {
  applescript: "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexReason: string | null;
  indexMode?: string;
  schemaFingerprint?: string;
};

/**
 * What a body search actually did, reported alongside the results.
 *
 * The bound is declared rather than hidden. A scan that silently stopped at the
 * newest N messages would answer "not found" for older mail indistinguishably
 * from a real absence, and the model has no way to tell the two apart — so when
 * the candidate set is too wide this says so, with both numbers, and returns
 * nothing rather than a partial answer dressed as a complete one.
 */
export type BodyScanReport =
  | {
      status: "ok";
      candidates: number;
      scanned: number;
      matched: number;
      /** Candidates with no readable message file. Usually a missing grant. */
      unreadable: number;
      elapsedMs: number;
      bound: number;
    }
  | { status: "over-bound"; candidates: number; bound: number };

/** What `#lookupMessageFile` found, and — when it found nothing — why. */
type MessageFileLookup =
  | { found: true; path: string; partial: boolean }
  | { found: false; lookup?: Extract<EmlxLookup, { found: false }>; explain: string };

/** The FDA sentence, kept verbatim for the case where FDA really is the problem. */
const FDA_HINT =
  "The message file could not be read. Grant Full Disk Access to the app running this server " +
  "and restart it.";

export type AppleMailClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  osascript?: OsascriptRunner | undefined;
};

export class AppleMailClient {
  readonly config: Config;
  readonly runner: OsascriptRunner;
  readonly mailboxes: MailboxMap;
  readonly #logger: Logger | undefined;

  #located: LocateResult | null = null;
  #index: EnvelopeIndex | null = null;
  #indexError: string | null = null;
  #indexTried = false;

  constructor(opts: AppleMailClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        surface: MAIL_SURFACE,
        logger: opts.logger,
      });
    this.mailboxes = new MailboxMap({
      runner: this.runner,
      allowlist: opts.config.accounts,
      ttlMs: opts.config.mailboxCacheTtlMs,
    });
  }

  accounts(force = false): Promise<MailAccount[]> {
    return this.mailboxes.accounts(force);
  }

  /**
   * Where the Envelope Index is and whether we may read it. Resolved lazily and
   * cached: it needs an Apple Event to ask Mail for its own directory, and that
   * answer does not change while the process lives.
   */
  async locate(force = false): Promise<LocateResult> {
    if (this.#located && !force) return this.#located;

    let accountDirectory: string | undefined;
    try {
      const accounts = await this.accounts();
      accountDirectory = accounts.find((a) => a.directory)?.directory ?? undefined;
    } catch (err) {
      this.#logger?.debug?.("locate: could not ask Mail for its account directory", err);
    }

    this.#located = locateEnvelopeIndex({
      envelopeIndexPath: this.config.envelopeIndexPath,
      mailRoot: this.config.mailRoot,
      accountDirectory,
    });
    return this.#located;
  }

  /**
   * Whether the composer can be reached, and which grant is missing if not.
   *
   * Reported by diagnostics rather than only discovered on a failed reply.
   * Automation-to-Mail and Full Disk Access being granted says nothing about
   * either of these, and every read tool works without them — so the only
   * signal used to be a `COMPOSER_NOT_FOUND` on a window that was
   * demonstrably on screen, with no way to tell which permission was at fault.
   *
   * Never throws. A probe that cannot answer must not be the reason
   * diagnostics fails, and "unknown" is an honest third state.
   */
  async composerAccess(): Promise<{
    accessibility: "granted" | "denied" | "unknown";
    systemEvents: "granted" | "denied" | "notDetermined" | "error" | "unknown";
    /**
     * Whether Mail's UI could actually be read, which is the only one of these
     * three that is evidence rather than a claim. The flag above answers for an
     * identity and has been caught disagreeing with what the same process can
     * do; `inconclusive` is Mail with no windows open, where nothing can be
     * concluded either way.
     */
    uiRead: "granted" | "denied" | "inconclusive" | "unknown";
    windows: (string | null)[] | null;
  }> {
    try {
      return await this.runner.run(COMPOSER_ACCESS);
    } catch {
      return {
        accessibility: "unknown",
        systemEvents: "unknown",
        uiRead: "unknown",
        windows: null,
      };
    }
  }

  async lanes(): Promise<LaneStatus> {
    /**
     * Probe twice before declaring the lane dead.
     *
     * The FIRST Apple Event a fresh process sends is what triggers the macOS
     * Automation prompt, and osascript can come back failed while the user is
     * still deciding. Reporting "denied" off that one attempt produced a
     * diagnostic that said automation was denied in the same breath as listing
     * four accounts it had just read over automation — which sends people to
     * fix a permission that was never the problem.
     */
    let applescript: LaneStatus["applescript"] = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.accounts();
        applescript = "live";
        break;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (this.config.indexMode === "off") {
      return { applescript, index: "disabled", indexReason: "APPLE_MAIL_INDEX_MODE=off" };
    }
    const index = await this.index();
    return {
      applescript,
      index: index ? "live" : "unavailable",
      indexReason: index ? null : (this.#indexError ?? (await this.locate()).reason),
      ...(index ? { indexMode: index.mode, schemaFingerprint: index.caps.fingerprint } : {}),
    };
  }

  async listMailboxes(opts: {
    accountUuids?: string[];
    withCounts: boolean;
  }): Promise<
    { accountUuid: string; accountName: string; name: string; unread?: number; total?: number }[]
  > {
    const accounts = await this.accounts();
    const allowed = opts.accountUuids?.length
      ? accounts.filter((a) => opts.accountUuids?.includes(a.id)).map((a) => a.id)
      : accounts.map((a) => a.id);
    return withBusyRetry(() =>
      this.runner.run(LIST_MAILBOXES, { accountUuids: allowed, withCounts: opts.withCounts }),
    );
  }

  async countMailbox(account: MailAccount, mailbox: string) {
    const name = this.mailboxes.resolveMailboxName(account, mailbox);
    return withBusyRetry(() =>
      this.runner.run<{
        accountUuid: string;
        mailbox: string;
        total: number | null;
        unread: number | null;
      }>(COUNT_MAILBOX, { accountUuid: account.id, mailbox: name }),
    );
  }

  /**
   * The degraded listing lane. Capped rather than paginated on purpose: each
   * extra message costs another ~42ms per property, so a "just fetch 500" call
   * is a 20-second call, and a limit the model can see beats a timeout it cannot.
   */
  async listRecent(
    account: MailAccount,
    mailbox: string,
    limit: number,
  ): Promise<{ mailbox: string; total: number; messages: MessageSummary[] }> {
    const name = this.mailboxes.resolveMailboxName(account, mailbox);
    const capped = Math.min(limit, this.config.degradedMaxMessages);
    const raw = await withBusyRetry(() =>
      this.runner.run<{
        mailbox: string;
        total: number;
        messages: Omit<MessageSummary, "ref">[];
      }>(LIST_RECENT, { accountUuid: account.id, mailbox: name, limit: capped }),
    );
    return { ...raw, messages: raw.messages.map((m) => this.#withRef(m)) };
  }

  /** Resolve message ids inside one mailbox. This is the search-to-action bridge. */
  async getMessages(
    ref: { accountUuid: string; mailbox: string },
    ids: number[],
    opts: { withContent?: boolean; withSource?: boolean; withHeaders?: boolean } = {},
  ): Promise<MessageSummary[]> {
    const raw = await withBusyRetry(() =>
      this.runner.run<(Omit<MessageSummary, "ref"> & { found?: boolean })[]>(GET_MESSAGES, {
        accountUuid: ref.accountUuid,
        mailbox: ref.mailbox,
        ids,
        withContent: opts.withContent ?? false,
        withSource: opts.withSource ?? false,
        withHeaders: opts.withHeaders ?? false,
      }),
    );
    return raw.filter((m) => m.found !== false).map((m) => this.#withRef(m));
  }

  // ── index lane ─────────────────────────────────────────────────────────────

  /**
   * Open the index on first use, once. A failure is remembered rather than
   * retried on every call: the usual cause is a missing permission, which will
   * not change until the user restarts the host app anyway.
   */
  async index(): Promise<EnvelopeIndex | null> {
    if (this.#indexTried) return this.#index;
    this.#indexTried = true;

    if (this.config.indexMode === "off") {
      this.#indexError = "APPLE_MAIL_INDEX_MODE=off";
      return null;
    }
    const located = await this.locate();
    if (!located.envelopeIndexPath) {
      this.#indexError = located.reason;
      return null;
    }
    try {
      this.#index = new EnvelopeIndex(
        openIndex(located.envelopeIndexPath, this.config.indexMode, this.#logger),
      );
    } catch (err) {
      this.#indexError = err instanceof Error ? err.message : String(err);
      this.#index = null;
    }
    return this.#index;
  }

  get indexError(): string | null {
    return this.#indexError;
  }

  /** How stale the index file is, so callers can see when they are reading history. */
  async indexAgeSeconds(): Promise<number | null> {
    const located = await this.locate();
    if (!located.mtime) return null;
    return Math.max(0, Math.round((Date.now() - Date.parse(located.mtime)) / 1000));
  }

  /**
   * Map index mailbox rows onto scriptable account/mailbox names.
   *
   * Three of the mailbox URLs on a real machine are `local://` (On My Mac) with
   * no account UUID in the host position, so entries that do not resolve are
   * dropped rather than guessed at.
   */
  async #mailboxLookup(): Promise<
    Map<number, { accountUuid: string; mailbox: string; url: string }>
  > {
    const index = await this.index();
    const map = new Map<number, { accountUuid: string; mailbox: string; url: string }>();
    if (!index) return map;
    for (const row of index.mailboxes()) {
      const resolved = await this.mailboxes.resolveIndexUrl(row.url);
      if (!resolved) continue;
      map.set(row.rowid, {
        accountUuid: resolved.account.id,
        mailbox: resolved.mailbox,
        url: row.url,
      });
    }
    return map;
  }

  /** Resolve account/mailbox filters down to the index rowids they cover. */
  async #targetMailboxRowids(opts: {
    account?: string | undefined;
    mailbox?: string | undefined;
  }): Promise<number[] | undefined> {
    if (!opts.account && !opts.mailbox) return undefined;
    const lookup = await this.#mailboxLookup();
    const account = opts.account ? await this.mailboxes.resolveAccount(opts.account) : null;
    const wanted = opts.mailbox
      ? account
        ? this.mailboxes.resolveMailboxName(account, opts.mailbox)
        : opts.mailbox
      : null;

    const rowids: number[] = [];
    for (const [rowid, entry] of lookup) {
      if (account && entry.accountUuid !== account.id) continue;
      if (wanted && entry.mailbox.toLowerCase() !== wanted.toLowerCase()) continue;
      rowids.push(rowid);
    }
    return rowids;
  }

  async searchMessages(
    opts: Omit<SearchFilters, "mailboxRowids"> & {
      account?: string | undefined;
      mailbox?: string | undefined;
      /** Free text matched against message BODIES. See body-scan.ts. */
      body?: string | undefined;
    },
  ): Promise<{
    messages: MessageSummary[];
    source: "index" | "index+body-scan";
    indexMode: string;
    indexAgeSeconds: number | null;
    walBlind: boolean;
    bodyScan?: BodyScanReport;
  } | null> {
    const index = await this.index();
    if (!index) return null;

    const mailboxRowids = await this.#targetMailboxRowids(opts);
    const lookup = await this.#mailboxLookup();
    const scoped = { ...opts, ...(mailboxRowids ? { mailboxRowids } : {}) };

    const common = {
      indexMode: index.mode,
      indexAgeSeconds: await this.indexAgeSeconds(),
      // immutable=1 cannot see the -wal, so results may lag reality.
      walBlind: index.mode === "immutable",
    };

    if (!opts.body) {
      const rows = index.search(scoped);
      return {
        messages: rows
          .map((r) => this.#rowToSummary(r, lookup))
          .filter((m): m is MessageSummary => m !== null),
        source: "index" as const,
        ...common,
      };
    }

    /*
     * The body lane. The index narrows, the scan reads only the survivors.
     *
     * Candidates are fetched WITHOUT the caller's limit and offset, because
     * those bound the answer and this needs to bound the work: paging into
     * results that have not been filtered yet would silently drop matches
     * sitting past the first page. One row over the ceiling is enough to know
     * the set is too wide, so ask for exactly that many.
     */
    const bound = this.config.bodyScanMax;
    const candidateRows = index.search({ ...scoped, limit: bound + 1, offset: 0 });

    const byUrl = new Map([...lookup.values()].map((e) => [e.url, e]));
    const accounts = await this.mailboxes.accounts();
    const dirOf = new Map(accounts.map((a) => [a.id, a.directory]));
    const placeOf = new Map<number, { accountUuid: string; mailbox: string }>();
    for (const row of candidateRows) {
      const entry = byUrl.get(row.mailboxUrl);
      if (entry) placeOf.set(row.rowid, entry);
    }

    const outcome = scanBodies({
      candidates: candidateRows.map((r) => r.rowid),
      term: opts.body,
      bound,
      maxBytes: this.config.bodyScanBytes,
      locate: (rowid) => {
        const place = placeOf.get(rowid);
        const directory = place ? dirOf.get(place.accountUuid) : null;
        if (!place || !directory) return null;
        try {
          const found = lookupEmlx({
            accountDirectory: directory,
            mailbox: place.mailbox,
            rowid,
          });
          return found.found ? found.path : null;
        } catch {
          // lookupEmlx swallows its own I/O errors; anything reaching here is
          // one bad candidate, and one bad candidate must not take out a query
          // over two thousand of them.
          return null;
        }
      },
    });

    if (outcome.status === "over-bound") {
      return {
        messages: [],
        source: "index+body-scan" as const,
        ...common,
        bodyScan: {
          status: "over-bound",
          candidates: outcome.candidates,
          bound: outcome.bound,
        },
      };
    }

    const hits = new Set(outcome.matched);
    const matchedRows = candidateRows.filter((r) => hits.has(r.rowid));
    const paged = matchedRows.slice(opts.offset, opts.offset + opts.limit);

    return {
      messages: paged
        .map((r) => this.#rowToSummary(r, lookup))
        .filter((m): m is MessageSummary => m !== null),
      source: "index+body-scan" as const,
      ...common,
      bodyScan: {
        status: "ok",
        candidates: outcome.candidates,
        scanned: outcome.scanned,
        matched: matchedRows.length,
        unreadable: outcome.unreadable,
        elapsedMs: outcome.elapsedMs,
        bound,
      },
    };
  }

  async threadOf(ref: string, limit: number): Promise<MessageSummary[] | null> {
    const index = await this.index();
    if (!index) return null;
    const decoded = decodeRef(ref);
    const conversationId = index.conversationOf(decoded.id);
    if (conversationId === null) return [];
    const lookup = await this.#mailboxLookup();
    return index
      .thread(conversationId, limit)
      .map((r) => this.#rowToSummary(r, lookup))
      .filter((m): m is MessageSummary => m !== null);
  }

  async countViaIndex(opts: {
    account?: string | undefined;
    mailbox?: string | undefined;
  }): Promise<{ total: number; unread: number } | null> {
    const index = await this.index();
    if (!index) return null;
    const mailboxRowids = await this.#targetMailboxRowids(opts);
    return index.count(mailboxRowids ? { mailboxRowids } : {});
  }

  #rowToSummary(
    row: MessageRow,
    lookup: Map<number, { accountUuid: string; mailbox: string; url: string }>,
  ): MessageSummary | null {
    const entry = [...lookup.values()].find((e) => e.url === row.mailboxUrl);
    if (!entry) return null;
    const sender = row.senderName
      ? `${row.senderName} <${row.senderAddress ?? ""}>`
      : (row.senderAddress ?? null);
    return {
      ref: encodeRef({ accountUuid: entry.accountUuid, mailbox: entry.mailbox, id: row.rowid }),
      id: row.rowid,
      accountUuid: entry.accountUuid,
      mailbox: entry.mailbox,
      subject: row.subject,
      sender,
      dateReceived: row.dateReceived,
      dateSent: row.dateSent,
      read: row.read,
      flagged: row.flagged,
      size: row.size,
    };
  }

  // ── body lane ──────────────────────────────────────────────────────────────

  /**
   * Read a message body.
   *
   * Preferred path is the `.emlx` file on disk, which is instant and gives us
   * the real MIME structure. Falls back to asking Mail for `content` (~250ms),
   * which also covers accounts whose message caching keeps headers only — so a
   * missing file is a slow answer, not a failure.
   */
  async getMessageBody(
    ref: string,
    opts: { maxBodyBytes?: number } = {},
  ): Promise<{
    message: MessageSummary;
    parsed: ParsedMessage | null;
    source: "emlx" | "applescript";
    /** Why the file lane was not used. Present only when it was not. */
    fallbackReason?: string;
  }> {
    const decoded = decodeRef(ref);
    const located = await this.#lookupMessageFile(decoded);

    if (located.found) {
      const parsed = readEmlx(located.path, {
        maxBodyBytes: opts.maxBodyBytes ?? this.config.bodyMaxBytes,
        partial: located.partial,
        rowid: decoded.id,
      });
      const [summary] = await this.getMessages(decoded, [decoded.id]);
      if (summary) return { message: summary, parsed, source: "emlx" };
    }

    const [summary] = await this.getMessages(decoded, [decoded.id], { withContent: true });
    if (!summary) throw new MessageNotFoundError(ref);
    return {
      message: summary,
      parsed: null,
      source: "applescript",
      fallbackReason: located.found
        ? "The message file was read, but Mail did not return a summary for it."
        : located.explain,
    };
  }

  async getMessageSource(
    ref: string,
    opts: { offset: number; maxBytes: number },
  ): Promise<{
    source: string;
    totalBytes: number | null;
    truncated: boolean;
    via: "emlx" | "applescript";
    fallbackReason?: string;
  }> {
    const decoded = decodeRef(ref);
    const located = await this.#lookupMessageFile(decoded);
    if (located.found) {
      return { ...readEmlxSource(located.path, opts), via: "emlx" };
    }
    const [summary] = await this.getMessages(decoded, [decoded.id], { withSource: true });
    if (!summary) throw new MessageNotFoundError(ref);
    const full = summary.source ?? "";
    const slice = full.slice(opts.offset, opts.offset + opts.maxBytes);
    return {
      source: slice,
      totalBytes: full.length,
      truncated: opts.offset + slice.length < full.length,
      via: "applescript",
      ...(located.found ? {} : { fallbackReason: located.explain }),
    };
  }

  /**
   * Look for a message's `.emlx`, keeping the reason it was not found.
   *
   * The reason is the point. This lane degrades silently by design — the
   * AppleScript fallback answers most questions — so a lookup that fails for
   * the WRONG reason (a mailbox path we derived incorrectly, say) is invisible
   * and stays invisible. Every caller that reports a degraded read now has the
   * evidence to say which of "no permission", "not cached", and "no such path"
   * it actually was.
   */
  async #lookupMessageFile(ref: MessageRef): Promise<MessageFileLookup> {
    const accounts = await this.accounts();
    const account = accounts.find((a) => a.id === ref.accountUuid);
    if (!account) {
      return { found: false, explain: `No account with id ${ref.accountUuid} is visible.` };
    }
    if (!account.directory) {
      return {
        found: false,
        explain: `Mail did not report an on-disk directory for account "${account.name}".`,
      };
    }
    let lookup: EmlxLookup;
    try {
      lookup = lookupEmlx({
        accountDirectory: account.directory,
        mailbox: ref.mailbox,
        rowid: ref.id,
      });
    } catch (err) {
      // Unexpected: lookupEmlx swallows its own I/O errors. The AppleScript
      // fallback still works, so this is not worth failing the call over.
      return { found: false, explain: err instanceof Error ? err.message : String(err) };
    }
    if (lookup.found) return { found: true, path: lookup.path, partial: lookup.partial };
    return {
      found: false,
      lookup,
      explain: await this.#explainMissingFile(account, ref, lookup),
    };
  }

  /**
   * One truthful sentence about why there is no message file.
   *
   * Written because the old text said "Grant Full Disk Access and restart the
   * host app" unconditionally, which sent people to fix a permission that was
   * already granted while the real cause — a mailbox nested under
   * `[Gmail].mbox/` that the flat path join never found — went unmentioned.
   */
  async #explainMissingFile(
    account: MailAccount,
    ref: MessageRef,
    lookup: Extract<EmlxLookup, { found: false }>,
  ): Promise<string> {
    if (lookup.reason === "permission") return FDA_HINT;

    const probed = lookup.probed.slice(0, 3).join(", ");

    if (lookup.reason === "no-mailbox-dir") {
      // Nothing resolved and no EPERM. If we also cannot read the index, a
      // blanket TCC denial is still the likeliest story; otherwise the path is
      // simply wrong, and saying "grant Full Disk Access" would be a lie.
      if (!(await this.locate()).readable) return FDA_HINT;
      return (
        `Full Disk Access is granted, but no mailbox directory for "${ref.mailbox}" was found ` +
        `under ${account.directory}. Probed: ${probed}.`
      );
    }

    /*
     * `no-message-file` means the mailbox directory was listed successfully, so
     * we demonstrably have read access to the mail store. Permission is settled
     * by that evidence and must not be blamed here — not even when the Envelope
     * Index is unreadable for its own reasons.
     */
    const cachesBodies = /all messages/i.test(account.messageCaching ?? "");
    if (!cachesBodies) {
      return (
        `The mailbox directory was found, but message ${ref.id} has no file on disk. Account ` +
        `"${account.name}" caches "${account.messageCaching ?? "unknown"}", so bodies may not be ` +
        `stored locally. Opening the message in Mail downloads it.`
      );
    }
    return (
      `The mailbox directory was found and is readable, but no file for message ${ref.id} exists ` +
      `under ${lookup.mailboxDirs.slice(0, 2).join(", ")}. Probed: ${probed}.`
    );
  }

  /**
   * Walk the message-file lane end to end, per account, and report what broke.
   *
   * This exists because the lane fails silently by construction: every reader
   * falls back to AppleScript, so a lane that has been dead for months looks
   * like a lane that is merely slow. Diagnostics reporting
   * `fullDiskAccess: granted` beside a lane where every file read fails is the
   * misleading part, and this is what replaces the guess with a probe.
   *
   * Deliberately per-account: the failure that motivated it was an account-level
   * layout difference (Gmail nesting its mailboxes under `[Gmail].mbox/`), so a
   * single-account probe would have reported a healthy lane.
   */
  async probeMessageFile(): Promise<
    {
      account: string;
      accountUuid: string;
      status: "ok" | "unreachable" | "headers-only" | "not-probed";
      mailbox?: string;
      rowid?: number;
      path?: string;
      reason?: string;
      probed?: string[];
    }[]
  > {
    let accounts: MailAccount[];
    try {
      accounts = await this.accounts();
    } catch (err) {
      this.#logger?.debug?.("probeMessageFile: no account list", err);
      return [];
    }

    const index = await this.index();
    // No index means no cheap way to name a real message. Firing an Apple Event
    // per account to find one would make diagnostics slower precisely when the
    // index lane is already telling the user what to fix, so we say so instead.
    const noIndex = index
      ? null
      : (this.#indexError ?? (await this.locate()).reason ?? "the search index is unavailable");

    const results = [];
    for (const account of accounts) {
      const base = { account: account.name, accountUuid: account.id };
      if (!account.directory) {
        results.push({
          ...base,
          status: "not-probed" as const,
          reason: "Mail did not report an on-disk directory for this account.",
        });
        continue;
      }
      if (!index) {
        results.push({ ...base, status: "not-probed" as const, reason: noIndex ?? undefined });
        continue;
      }

      const sample = this.#sampleMessage(index, account);
      if (!sample) {
        results.push({
          ...base,
          status: "not-probed" as const,
          reason: "The search index holds no message for this account.",
        });
        continue;
      }

      const lookup = lookupEmlx({
        accountDirectory: account.directory,
        mailbox: sample.mailbox,
        rowid: sample.rowid,
      });
      const located = { ...base, mailbox: sample.mailbox, rowid: sample.rowid };

      if (lookup.found) {
        // Stat is not enough: it SUCCEEDS on a TCC-protected file, so a lane
        // with no read permission would report `ok`. Read a byte instead.
        try {
          const fd = openSync(lookup.path, "r");
          try {
            readSync(fd, Buffer.alloc(1), 0, 1, 0);
          } finally {
            closeSync(fd);
          }
          results.push({ ...located, status: "ok" as const, path: lookup.path });
        } catch (err) {
          results.push({
            ...located,
            status: "unreachable" as const,
            path: lookup.path,
            reason: `The message file exists but could not be read: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
        }
        continue;
      }

      const cachesBodies = /all messages/i.test(account.messageCaching ?? "");
      results.push({
        ...located,
        status:
          lookup.reason === "no-message-file" && !cachesBodies
            ? ("headers-only" as const)
            : ("unreachable" as const),
        reason: lookup.reason,
        probed: lookup.probed.slice(0, 3),
      });
    }
    return results;
  }

  /** Cheapest real (mailbox, rowid) pair for an account, straight from the index. */
  #sampleMessage(
    index: EnvelopeIndex,
    account: MailAccount,
  ): { mailbox: string; rowid: number } | null {
    const owned = index.mailboxes().filter((m) => {
      const host = /^[a-z-]+:\/\/([^/]*)/i.exec(m.url)?.[1];
      return host && decodeURIComponent(host) === account.id;
    });
    if (owned.length === 0) return null;

    const [row] = index.search({ mailboxRowids: owned.map((m) => m.rowid), limit: 1, offset: 0 });
    if (!row) return null;

    const path = decodeURIComponent(/^[a-z-]+:\/\/[^/]*\/?(.*)$/i.exec(row.mailboxUrl)?.[1] ?? "");
    if (!path) return null;
    try {
      return { mailbox: this.mailboxes.resolveMailboxName(account, path), rowid: row.rowid };
    } catch {
      // The index knows a mailbox Mail does not list. Probe the raw path — that
      // is exactly the sort of mismatch this probe should surface, not hide.
      return { mailbox: path, rowid: row.rowid };
    }
  }

  /**
   * Save one attachment into the configured directory.
   *
   * The destination is resolved and then checked to be inside
   * `APPLE_MAIL_ATTACHMENT_DIR`, so a filename of `../../.ssh/authorized_keys`
   * lands nowhere. Existing files are never overwritten.
   */
  async saveAttachment(
    ref: string,
    filename: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<{ path: string; bytes: number; from: "inline" | "sidecar" }> {
    const decoded = decodeRef(ref);
    const located = await this.#lookupMessageFile(decoded);
    if (!located.found) {
      throw new PreconditionError(
        `The message file was not found, so its attachments are not reachable. ${located.explain}`,
        { probed: located.lookup?.probed.slice(0, 3) ?? [] },
      );
    }

    const { bytes, from } = extractAttachment(located.path, filename, decoded.id);

    const root = resolve(this.config.attachmentDir);
    // basename() first: the filename comes from message content, which is
    // attacker-controlled in exactly the way path traversal needs.
    const target = resolve(join(root, basename(filename)));
    if (target !== join(root, basename(filename)) || !target.startsWith(root + sep)) {
      throw new PreconditionError(
        `Refusing to write outside ${root}. Set APPLE_MAIL_ATTACHMENT_DIR to change the destination.`,
      );
    }
    if (existsSync(target) && !opts.overwrite) {
      throw new PreconditionError(`${target} already exists; refusing to overwrite it.`);
    }

    mkdirSync(root, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: target, bytes: bytes.length, from };
  }

  // ── write lane ─────────────────────────────────────────────────────────────
  // Every mutation reports the state Mail re-read after the change. Verifying a
  // write against the search index instead would race Mail's own update of it.

  /** Set flags across refs, one Apple Event per distinct mailbox. */
  async setFlags(
    refs: string[],
    flags: { read?: boolean; flagged?: boolean; flagIndex?: number; junk?: boolean },
  ): Promise<{ changed: number; failed: number; results: unknown[] }> {
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let changed = 0;
    let failed = 0;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{ mailbox: string; results: { id: number; ok: boolean }[] }>(SET_FLAGS, {
          accountUuid: first.accountUuid,
          mailbox: first.mailbox,
          ids: group.map((r) => r.id),
          ...flags,
        }),
      );
      for (const r of res.results) {
        if (r.ok) changed += 1;
        else failed += 1;
        results.push({
          ref: encodeRef({ accountUuid: first.accountUuid, mailbox: first.mailbox, id: r.id }),
          ...r,
        });
      }
    }
    return { changed, failed, results };
  }

  async moveMessages(
    refs: string[],
    opts: { destinationMailbox: string; destinationAccount?: string },
  ): Promise<{ moved: number; failed: number; destination: string; results: unknown[] }> {
    const destAccount = opts.destinationAccount
      ? await this.mailboxes.resolveAccount(opts.destinationAccount)
      : null;
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let moved = 0;
    let failed = 0;
    let destination = opts.destinationMailbox;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{
          destination: string;
          destinationAccountUuid: string;
          results: { id: number; ok: boolean; newId: number | null }[];
        }>(MOVE_MESSAGES, {
          accountUuid: first.accountUuid,
          mailbox: first.mailbox,
          ids: group.map((r) => r.id),
          destMailbox: opts.destinationMailbox,
          destAccountUuid: destAccount?.id ?? null,
        }),
      );
      destination = res.destination;
      for (const r of res.results) {
        if (r.ok) moved += 1;
        else failed += 1;
        results.push({
          previousRef: encodeRef({
            accountUuid: first.accountUuid,
            mailbox: first.mailbox,
            id: r.id,
          }),
          // A moved message has a new row id, so the old ref is dead. Null here
          // means Mail moved it but we could not re-locate it by Message-ID.
          ref:
            r.ok && r.newId
              ? encodeRef({
                  accountUuid: res.destinationAccountUuid || first.accountUuid,
                  mailbox: res.destination,
                  id: r.newId,
                })
              : null,
          ...r,
        });
      }
    }
    return { moved, failed, destination, results };
  }

  async deleteMessages(refs: string[]): Promise<{
    deleted: number;
    failed: number;
    movedToTrash: boolean | null;
    results: unknown[];
  }> {
    const groups = groupRefsByMailbox(refs.map((r) => decodeRef(r)));
    const results: unknown[] = [];
    let deleted = 0;
    let failed = 0;
    let movedToTrash: boolean | null = null;

    for (const [, group] of groups) {
      const first = group[0];
      if (!first) continue;
      const res = await withBusyRetry(() =>
        this.runner.run<{ movedToTrash: boolean | null; results: { id: number; ok: boolean }[] }>(
          DELETE_MESSAGES,
          { accountUuid: first.accountUuid, mailbox: first.mailbox, ids: group.map((r) => r.id) },
        ),
      );
      movedToTrash = res.movedToTrash;
      for (const r of res.results) {
        if (r.ok) deleted += 1;
        else failed += 1;
        results.push(r);
      }
    }
    return { deleted, failed, movedToTrash, results };
  }

  /**
   * Create a mailbox.
   *
   * ## Why the cache is dropped afterwards
   *
   * `MailboxMap` caches each account together with its mailbox NAMES, and
   * `resolveMailboxName` answers out of that cache. A mailbox created here and
   * used as a move destination in the next call would resolve against a list
   * taken before it existed, so the move would fail with "no destination
   * mailbox" naming a mailbox this server had just made. Invalidating is not an
   * optimisation detail; it is what makes create-then-move work.
   */
  async createMailbox(
    name: string,
    account?: string,
  ): Promise<{
    created: boolean;
    name: string;
    account: string | null;
    accountUuid: string | null;
    note?: string;
  }> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new PreconditionError("A mailbox name cannot be empty or only whitespace.");
    }
    /*
     * Mail reads "/" as the hierarchy separator, so an empty segment asks for a
     * mailbox with no name somewhere in the path. Mail's own answer to that is
     * inconsistent across account types — sometimes a silent no-op, sometimes a
     * mailbox that cannot be selected — and neither is something the caller can
     * clean up from here.
     */
    if (trimmed.split("/").some((segment) => segment.trim() === "")) {
      throw new PreconditionError(
        `"${name}" has an empty path segment. "/" separates levels, so a name may not start or ` +
          'end with it, e.g. "Projects/Cupertino".',
      );
    }

    const resolved = account ? await this.mailboxes.resolveAccount(account) : null;
    const result = await withBusyRetry(() =>
      this.runner.run<{
        created: boolean;
        name: string;
        account: string | null;
        accountUuid: string | null;
        note?: string;
      }>(CREATE_MAILBOX, {
        name: trimmed,
        accountUuid: resolved?.id ?? null,
      }),
    );
    this.mailboxes.invalidate();
    return result;
  }

  /**
   * Replace a saved draft's body by recreating it.
   *
   * The refusals live in the script, next to the properties they are read from,
   * and come back as ordinary results carrying `replaced: false` rather than as
   * thrown errors — a caller that cannot rewrite this draft still wants to know
   * WHY, and what to do instead, and both travel better as data than as a
   * message string.
   *
   * What is enforced here instead is the shape of the request, before Mail is
   * touched at all: an empty body would silently blank a draft the user wrote,
   * which is the one outcome nothing downstream could distinguish from success.
   */
  async updateDraft(
    ref: string,
    opts: { body: string; subject?: string | undefined },
  ): Promise<Record<string, unknown>> {
    if (!opts.body.trim()) {
      throw new PreconditionError(
        "A replacement body cannot be empty. Blanking a draft and reporting success is " +
          "indistinguishable from having written it, so it is refused here rather than done. " +
          "Delete the draft with apple_mail_delete_messages if that is what you meant.",
      );
    }
    const decoded = decodeRef(ref);
    return withBusyRetry(() =>
      this.runner.run<Record<string, unknown>>(UPDATE_DRAFT, {
        accountUuid: decoded.accountUuid,
        mailbox: decoded.mailbox,
        id: decoded.id,
        body: opts.body,
        subject: opts.subject ?? null,
      }),
    );
  }

  async checkForNewMail(account?: string): Promise<unknown> {
    const resolved = account ? await this.mailboxes.resolveAccount(account) : null;
    return this.runner.run(CHECK_FOR_NEW_MAIL, { accountUuid: resolved?.id ?? null });
  }

  async sendMessage(opts: {
    account?: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    sendNow: boolean;
  }): Promise<unknown> {
    const account = opts.account ? await this.mailboxes.resolveAccount(opts.account) : null;
    return this.runner.run(SEND_MESSAGE, {
      senderAddress: account?.emailAddresses[0] ?? null,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      body: opts.body,
      sendNow: opts.sendNow,
    });
  }

  async replyOrForward(
    ref: string,
    opts: {
      mode: "reply" | "forward";
      body?: string;
      to?: string[];
      replyToAll?: boolean;
      sendNow: boolean;
    },
  ): Promise<unknown> {
    const decoded = decodeRef(ref);
    return this.runner.run(REPLY_OR_FORWARD, {
      accountUuid: decoded.accountUuid,
      mailbox: decoded.mailbox,
      id: decoded.id,
      mode: opts.mode,
      body: opts.body ?? null,
      to: opts.to ?? [],
      replyToAll: opts.replyToAll ?? false,
      sendNow: opts.sendNow,
    });
  }

  #withRef(m: Omit<MessageSummary, "ref">): MessageSummary {
    const ref: MessageRef = { accountUuid: m.accountUuid, mailbox: m.mailbox, id: m.id };
    return { ...m, ref: encodeRef(ref) };
  }
}
