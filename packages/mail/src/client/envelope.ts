import type { DatabaseSync } from "node:sqlite";

import { escapeLike, openReadOnly, toFileUri } from "@mgcrea/mcp-apple-core";

import { SchemaDriftError } from "./errors.js";
import type { Logger } from "./osascript.js";
import { assertUsable, introspect, type IndexCapabilities } from "./schema.js";

/**
 * Read-only access to Mail's Envelope Index.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Never write.** Mail owns this database, holds it open, and reconciles it
 *    against the server. `PRAGMA query_only` makes that structural rather than
 *    a matter of everyone remembering.
 * 2. **Prefer `mode=ro` over `immutable=1`.** `immutable=1` tells SQLite the
 *    file cannot change and to skip the `-wal` entirely — so a read silently
 *    misses anything not yet checkpointed. Measured on a live index: the two
 *    modes reported 181427 and 181426 messages minutes after reporting the same
 *    number, the difference being one newly-arrived mail. It is a race you lose
 *    intermittently and without any error, which is the worst kind.
 */

export type IndexMode = "auto" | "ro" | "immutable" | "off";

export type MessageRow = {
  rowid: number;
  mailboxUrl: string;
  subject: string | null;
  senderAddress: string | null;
  senderName: string | null;
  dateReceived: string | null;
  dateSent: string | null;
  read: boolean;
  flagged: boolean;
  size: number | null;
  conversationId: number | null;
  hasAttachment: boolean;
};

export type SearchFilters = {
  query?: string | undefined;
  sender?: string | undefined;
  recipient?: string | undefined;
  subject?: string | undefined;
  mailboxRowids?: number[] | undefined;
  unreadOnly?: boolean | undefined;
  flaggedOnly?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  limit: number;
  offset: number;
};

/**
 * What a mail query can group on.
 *
 * The single source of truth for both the tool's enum and the SQL expressions
 * in `#groupExpr` — a field can only be asked for if it is listed here, which
 * is what keeps caller strings out of the statement.
 */
export const GROUP_FIELDS = ["sender", "mailbox", "subject", "day", "month"] as const;

export type GroupField = (typeof GROUP_FIELDS)[number];

export type GroupRow = {
  /** The grouped value. Null where the underlying column is null. */
  key: string | null;
  /** A display form of `key` where the schema carries one, else null. */
  label: string | null;
  count: number;
  unread: number;
  firstAt: string | null;
  lastAt: string | null;
};

export type GroupResult = {
  groups: GroupRow[];
  /** Distinct groups matched, before `limit` cut the list. */
  totalGroups: number;
  /** Messages aggregated. Never capped by `limit`. */
  totalRows: number;
};

export { escapeLike, toFileUri };

const contains = (value: string): string => `%${escapeLike(value)}%`;

export type OpenResult = {
  db: DatabaseSync;
  /** Which mode actually opened. `immutable` results are WAL-blind — say so. */
  mode: "ro" | "immutable";
  caps: IndexCapabilities;
};

export const openIndex = (path: string, mode: IndexMode, logger?: Logger): OpenResult => {
  const {
    db,
    mode: opened,
    validated: caps,
  } = openReadOnly<IndexCapabilities>(path, mode, {
    envVar: "APPLE_MAIL_INDEX_MODE",
    label: "Mail's search index",
    hint: "If this is a permission error, grant Full Disk Access to the app running this server.",
    // Introspect inside the ladder: an index that opens but is missing required
    // columns should fall through to the next mode, not be handed back.
    validate: (conn) => {
      const found = introspect(conn);
      assertUsable(found);
      return found;
    },
    // Schema drift is not something a different open mode can fix, and its
    // message names the missing columns and the fingerprint — far more useful
    // than the generic "could not open" the ladder would otherwise produce.
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      logger?.warn?.(
        "opened the index with immutable=1; results may omit mail that is still in the -wal",
      ),
  });
  return { db, mode: opened, caps };
};

export class EnvelopeIndex {
  readonly #db: DatabaseSync;
  readonly caps: IndexCapabilities;
  readonly mode: "ro" | "immutable";

  constructor(opened: OpenResult) {
    this.#db = opened.db;
    this.caps = opened.caps;
    this.mode = opened.mode;
  }

  close(): void {
    try {
      this.#db.close();
    } catch {
      // Already closed, or the file vanished under us. Nothing useful to do.
    }
  }

  /** id -> url for every mailbox, so results can be mapped back to scriptable names. */
  mailboxes(): { rowid: number; url: string; total: number | null; unread: number | null }[] {
    const hasCounts = this.caps.has.mailboxCounts;
    const rows = this.#db
      .prepare(
        hasCounts
          ? "SELECT ROWID AS rowid, url, total_count AS total, unread_count AS unread FROM mailboxes"
          : "SELECT ROWID AS rowid, url, NULL AS total, NULL AS unread FROM mailboxes",
      )
      .all() as { rowid: number; url: string; total: number | null; unread: number | null }[];
    return rows;
  }

  /**
   * Restrict to a set of mailboxes.
   *
   * The `labels` half is not optional for Gmail. Gmail-over-IMAP keeps every
   * message in `[Gmail]/All Mail` and expresses INBOX membership as a label
   * row, so `m.mailbox IN (...)` alone returns an EMPTY inbox — measured here
   * as 0 rows against 51,128 real messages.
   */
  #mailboxPredicate(rowids: number[] | undefined, params: unknown[]): string {
    if (!rowids?.length) return "1=1";
    const placeholders = rowids.map(() => "?").join(",");
    if (!this.caps.has.labels) {
      params.push(...rowids);
      return `m.mailbox IN (${placeholders})`;
    }
    params.push(...rowids, ...rowids);
    return (
      `(m.mailbox IN (${placeholders}) OR m.ROWID IN ` +
      `(SELECT message_id FROM labels WHERE mailbox_id IN (${placeholders})))`
    );
  }

  #toIso(value: number | null): string | null {
    if (value === null || !Number.isFinite(value)) return null;
    return new Date((value + this.caps.epochOffset) * 1000).toISOString();
  }

  #toEpoch(iso: string): number {
    return Math.floor(Date.parse(iso) / 1000) - this.caps.epochOffset;
  }

  /**
   * The WHERE half of a filtered read, appending its bind values to `params`.
   *
   * Shared by `search` and `groupBy` so the two cannot drift: a filter that
   * narrowed a listing but not its aggregate would make "count per sender in
   * INBOX" quietly count the whole archive.
   *
   * Call this before adding any other bind value — the placeholders it appends
   * have to come first in the parameter list, which mirrors WHERE preceding
   * ORDER BY and LIMIT in every statement built from it.
   */
  #filterPredicate(filters: Omit<SearchFilters, "limit" | "offset">, params: unknown[]): string {
    const where: string[] = ["m.deleted = 0"];

    where.push(this.#mailboxPredicate(filters.mailboxRowids, params));

    if (filters.query) {
      // Free text spans subject and sender, which is what "search my mail for X"
      // means in practice. Body search is a separate, opt-in scan.
      where.push(
        "(s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')",
      );
      params.push(contains(filters.query), contains(filters.query), contains(filters.query));
    }
    if (filters.subject) {
      where.push("s.subject LIKE ? ESCAPE '\\'");
      params.push(contains(filters.subject));
    }
    if (filters.sender) {
      where.push("(a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')");
      params.push(contains(filters.sender), contains(filters.sender));
    }
    if (filters.recipient && this.caps.has.recipients) {
      where.push(
        "EXISTS (SELECT 1 FROM recipients r JOIN addresses ra ON ra.ROWID = r.address " +
          "WHERE r.message = m.ROWID AND ra.address LIKE ? ESCAPE '\\')",
      );
      params.push(contains(filters.recipient));
    }
    if (filters.unreadOnly) where.push("m.read = 0");
    if (filters.flaggedOnly && this.caps.has.flagged) where.push("m.flagged = 1");
    if (filters.hasAttachment && this.caps.has.attachments) {
      where.push("EXISTS (SELECT 1 FROM attachments at WHERE at.message = m.ROWID)");
    }
    if (filters.dateFrom) {
      where.push("m.date_received >= ?");
      params.push(this.#toEpoch(filters.dateFrom));
    }
    if (filters.dateTo) {
      where.push("m.date_received <= ?");
      params.push(this.#toEpoch(filters.dateTo));
    }

    return where.join(" AND ");
  }

  /**
   * The joins every filtered read needs. `s` and `a` are LEFT joins because a
   * message can legitimately have no subject row and no sender row, and an
   * INNER join here would drop exactly those from counts.
   */
  static readonly #FROM =
    "FROM messages m " +
    "JOIN mailboxes mb ON mb.ROWID = m.mailbox " +
    "LEFT JOIN subjects s ON s.ROWID = m.subject " +
    "LEFT JOIN addresses a ON a.ROWID = m.sender";

  /**
   * subject_prefix holds "Re: " / "Fwd: " separately from the deduplicated
   * subject row, so the displayed subject is the concatenation of the two.
   */
  get #subjectExpr(): string {
    return this.caps.has.subjectPrefix
      ? "COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '')"
      : "COALESCE(s.subject, '')";
  }

  search(filters: SearchFilters): MessageRow[] {
    const params: unknown[] = [];
    const predicate = this.#filterPredicate(filters, params);
    const subjectExpr = this.#subjectExpr;

    const sql =
      `SELECT m.ROWID AS rowid, mb.url AS mailboxUrl, ${subjectExpr} AS subject, ` +
      `a.address AS senderAddress, a.comment AS senderName, ` +
      `m.date_received AS dateReceived, ${this.caps.has.dateSent ? "m.date_sent" : "NULL"} AS dateSent, ` +
      `m.read AS read, ${this.caps.has.flagged ? "m.flagged" : "0"} AS flagged, m.size AS size, ` +
      `${this.caps.has.conversationId ? "m.conversation_id" : "NULL"} AS conversationId, ` +
      (this.caps.has.attachments
        ? "EXISTS (SELECT 1 FROM attachments at2 WHERE at2.message = m.ROWID) AS hasAttachment "
        : "0 AS hasAttachment ") +
      `${EnvelopeIndex.#FROM} ` +
      `WHERE ${predicate} ` +
      `ORDER BY m.date_received DESC LIMIT ? OFFSET ?`;

    params.push(filters.limit, filters.offset);

    const rows = this.#db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => ({
      rowid: Number(r.rowid),
      mailboxUrl: String(r.mailboxUrl),
      subject: (r.subject as string) || null,
      senderAddress: (r.senderAddress as string) ?? null,
      senderName: (r.senderName as string) || null,
      dateReceived: this.#toIso(r.dateReceived as number | null),
      dateSent: this.#toIso(r.dateSent as number | null),
      read: Boolean(r.read),
      flagged: Boolean(r.flagged),
      size: (r.size as number) ?? null,
      conversationId: (r.conversationId as number) ?? null,
      hasAttachment: Boolean(r.hasAttachment),
    }));
  }

  /**
   * The column expression each groupable field aggregates on.
   *
   * A key here is the ONLY thing that reaches the statement — the tool matches
   * the caller's string against `GROUP_FIELDS` and passes the matched literal,
   * so no caller-controlled text is ever interpolated. `label` is a second,
   * human-readable form of the same group where one exists; it goes through
   * MAX() because everything outside GROUP BY has to be aggregated, and the
   * value is constant within a group anyway.
   */
  #groupExpr(field: GroupField): { key: string; label: string } {
    switch (field) {
      case "sender":
        return { key: "a.address", label: "MAX(NULLIF(a.comment, ''))" };
      // Grouped on the rowid rather than the URL so the caller can map it back
      // through the same mailbox lookup every other result uses.
      case "mailbox":
        return { key: "m.mailbox", label: "MAX(mb.url)" };
      case "subject":
        return { key: this.#subjectExpr, label: "NULL" };
      case "day":
        return { key: this.#dateBucket("%Y-%m-%d"), label: "NULL" };
      case "month":
        return { key: this.#dateBucket("%Y-%m"), label: "NULL" };
    }
  }

  /** `date_received` is epoch-with-offset, so shift it before formatting. */
  #dateBucket(format: string): string {
    return `strftime('${format}', datetime(m.date_received + ${this.caps.epochOffset}, 'unixepoch'))`;
  }

  /**
   * Count matches per group, over every match rather than a page of them.
   *
   * `filters.limit` caps the number of GROUPS returned, not the number of
   * messages considered — that distinction is the whole point of this lane.
   * Aggregating a page instead would answer "the top senders among the
   * twenty-five rows we happened to return", which is indistinguishable from a
   * real top-N unless you already knew to doubt it.
   */
  groupBy(filters: Omit<SearchFilters, "offset">, field: GroupField): GroupResult {
    const { key, label } = this.#groupExpr(field);

    const totalsParams: unknown[] = [];
    const totalsPredicate = this.#filterPredicate(filters, totalsParams);
    // COUNT(DISTINCT) skips NULL, so a "no sender" group would go unreported in
    // totalGroups while still appearing in `groups` — and `truncated` is derived
    // from that number. The second term adds the null group back when it exists.
    const totals = this.#db
      .prepare(
        `SELECT COUNT(*) AS totalRows, ` +
          `COUNT(DISTINCT ${key}) + MAX(CASE WHEN ${key} IS NULL THEN 1 ELSE 0 END) AS totalGroups ` +
          `${EnvelopeIndex.#FROM} WHERE ${totalsPredicate}`,
      )
      .get(...(totalsParams as never[])) as { totalRows: number; totalGroups: number | null };

    const params: unknown[] = [];
    const predicate = this.#filterPredicate(filters, params);
    params.push(filters.limit);

    const rows = this.#db
      .prepare(
        `SELECT ${key} AS key, ${label} AS label, COUNT(*) AS count, ` +
          `SUM(CASE WHEN m.read = 0 THEN 1 ELSE 0 END) AS unread, ` +
          `MIN(m.date_received) AS firstAt, MAX(m.date_received) AS lastAt ` +
          `${EnvelopeIndex.#FROM} WHERE ${predicate} ` +
          // Ordered by count so `limit` yields a top-N; the key breaks ties so
          // repeating the same query cannot reshuffle equal-count groups.
          `GROUP BY ${key} ORDER BY count DESC, key ASC LIMIT ?`,
      )
      .all(...(params as never[])) as Record<string, unknown>[];

    return {
      groups: rows.map((r) => ({
        key: r.key === null ? null : String(r.key),
        label: (r.label as string) || null,
        count: Number(r.count),
        unread: Number(r.unread ?? 0),
        firstAt: this.#toIso(r.firstAt as number | null),
        lastAt: this.#toIso(r.lastAt as number | null),
      })),
      totalRows: totals.totalRows,
      // MAX() over zero rows is NULL, which is the empty-result case.
      totalGroups: totals.totalGroups ?? 0,
    };
  }

  count(filters: Omit<SearchFilters, "limit" | "offset">): { total: number; unread: number } {
    const params: unknown[] = [];
    const predicate = this.#mailboxPredicate(filters.mailboxRowids, params);
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN m.read = 0 THEN 1 ELSE 0 END) AS unread ` +
          `FROM messages m WHERE m.deleted = 0 AND ${predicate}`,
      )
      .get(...(params as never[])) as { total: number; unread: number | null };
    return { total: row.total, unread: row.unread ?? 0 };
  }

  /** Every message in one conversation, oldest first. */
  thread(conversationId: number, limit: number): MessageRow[] {
    if (!this.caps.has.conversationId) return [];
    const subjectExpr = this.caps.has.subjectPrefix
      ? "COALESCE(m.subject_prefix, '') || COALESCE(s.subject, '')"
      : "COALESCE(s.subject, '')";
    const rows = this.#db
      .prepare(
        `SELECT m.ROWID AS rowid, mb.url AS mailboxUrl, ${subjectExpr} AS subject, ` +
          `a.address AS senderAddress, a.comment AS senderName, m.date_received AS dateReceived, ` +
          `${this.caps.has.dateSent ? "m.date_sent" : "NULL"} AS dateSent, m.read AS read, ` +
          `${this.caps.has.flagged ? "m.flagged" : "0"} AS flagged, m.size AS size, ` +
          `m.conversation_id AS conversationId, 0 AS hasAttachment ` +
          `FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox ` +
          `LEFT JOIN subjects s ON s.ROWID = m.subject ` +
          `LEFT JOIN addresses a ON a.ROWID = m.sender ` +
          `WHERE m.deleted = 0 AND m.conversation_id = ? ORDER BY m.date_received ASC LIMIT ?`,
      )
      .all(conversationId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      rowid: Number(r.rowid),
      mailboxUrl: String(r.mailboxUrl),
      subject: (r.subject as string) || null,
      senderAddress: (r.senderAddress as string) ?? null,
      senderName: (r.senderName as string) || null,
      dateReceived: this.#toIso(r.dateReceived as number | null),
      dateSent: this.#toIso(r.dateSent as number | null),
      read: Boolean(r.read),
      flagged: Boolean(r.flagged),
      size: (r.size as number) ?? null,
      conversationId: (r.conversationId as number) ?? null,
      hasAttachment: false,
    }));
  }

  /** conversation_id for one message, so get_thread can start from a ref. */
  conversationOf(rowid: number): number | null {
    if (!this.caps.has.conversationId) return null;
    const row = this.#db
      .prepare("SELECT conversation_id AS c FROM messages WHERE ROWID = ?")
      .get(rowid) as { c: number } | undefined;
    return row?.c ?? null;
  }
}
