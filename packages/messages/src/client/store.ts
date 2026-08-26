import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  escapeLike,
  fingerprintSchema,
  openReadOnly,
  SchemaDriftError,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import { appleSecondsSql } from "./dates.js";
import { decodeAttributedBody } from "./typedstream.js";

/**
 * Messages' file lane — the only lane there is.
 *
 * `docs/messages.md` measured every Apple Events read attempt failing, so unlike
 * every other surface here there is nothing to fall back to. That shapes two
 * things: `SchemaDriftError` is the only fatal condition, and a missing store is
 * reported as a reason rather than as an empty list.
 *
 * ## Three measurements this file is built on
 *
 * **The blob is the norm, and increasingly the only thing there.** 97,094 rows
 * carry `attributedBody` and 94,043 carry `text`; 3,051 have only the blob. That
 * 3.1% is an average over a decade, and it hides the real shape: measured
 * through this server, 2016-2025 are ~99% plain `text` and everything from
 * MARCH 2026 ONWARD is blob-only. A reader that selects `text` would today
 * report that the conversation stopped in February. Every read here goes through
 * `#body()`, which prefers the column and falls back to the decoder — validated
 * at **100.000% agreement across all 94,043 rows** where both exist, with zero failures
 * across all 97,094.
 *
 * **Dates do not fit in a JavaScript number.** See `dates.ts`. Every date column
 * is projected through `appleSecondsSql`, never selected raw.
 *
 * **Reactions are messages.** 2,788 rows carry `associated_message_type != 0`,
 * and a reader that does not filter them renders `Liked "see you at 8"` as if
 * somebody had typed it. Filtering is table stakes, not an enhancement.
 */

/** Tables the lane cannot work without. */
const REQUIRED = ["message", "chat", "handle"] as const;

const PROBED_FINGERPRINT = "87b01c58a631";
const PROBED_MACOS = "26.6";

/**
 * A tapback rather than something somebody typed.
 *
 * 2000–2005 add a reaction, 3000–3005 remove one; 0 is an ordinary message.
 * The ranges are Apple's and are not documented anywhere public, so the code
 * treats "not zero" as the test and only uses the ranges to LABEL — an
 * unrecognised value is still excluded from the conversation, which is the safe
 * direction.
 */
const REACTION_LABELS: Record<number, string> = {
  2000: "loved",
  2001: "liked",
  2002: "disliked",
  2003: "laughed",
  2004: "emphasized",
  2005: "questioned",
};

export const reactionLabel = (type: number): string => {
  if (REACTION_LABELS[type]) return REACTION_LABELS[type] as string;
  if (type >= 3000 && type <= 3005) return `removed ${REACTION_LABELS[type - 1000] ?? "reaction"}`;
  return `reaction ${type}`;
};

export type StoreCapabilities = {
  fingerprint: string;
  messageColumns: Set<string>;
  chatColumns: Set<string>;
  handleColumns: Set<string>;
  attachmentColumns: Set<string>;
  hasAttachments: boolean;
  hasReactions: boolean;
  hasThreads: boolean;
  hasEdits: boolean;
};

export type MessageRow = {
  guid: string;
  chatGuid: string | null;
  chatName: string | null;
  handle: string | null;
  service: string | null;
  isFromMe: boolean;
  /** Apple-seconds. Render with `renderInstant`. */
  sentAt: number | null;
  readAt: number | null;
  deliveredAt: number | null;
  editedAt: number | null;
  text: string | null;
  /** Which lane answered — the column, or the decoder. */
  textSource: "column" | "decoded" | "none";
  subject: string | null;
  isRead: boolean;
  isSent: boolean;
  isDelivered: boolean;
  hasAttachments: boolean;
  /** Set when this row is a tapback on another message rather than a message. */
  reactionType: number | null;
  reactionTarget: string | null;
  /** Set when this message is a reply in a thread. */
  threadOriginator: string | null;
  /** Non-zero for a group event — someone joined, left, or renamed the chat. */
  itemType: number | null;
};

export type ChatRow = {
  guid: string;
  identifier: string | null;
  displayName: string | null;
  /** 43 is a group chat, 45 is one-to-one. Reported raw beside the boolean. */
  style: number | null;
  isGroup: boolean;
  service: string | null;
  participants: string[];
  messages: number;
  lastMessageAt: number | null;
};

export type RangeQuery = {
  chatGuid?: string | undefined;
  fromApple?: number | undefined;
  toApple?: number | undefined;
  includeReactions?: boolean | undefined;
  limit: number;
};

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const bool = (v: unknown): boolean => v === 1 || v === true;

export class MessagesStore {
  readonly db: DatabaseSync;
  readonly mode: string;
  readonly caps: StoreCapabilities;

  constructor(db: DatabaseSync, mode: string, caps: StoreCapabilities) {
    this.db = db;
    this.mode = mode;
    this.caps = caps;
  }

  /** Project a column, or a typed NULL when this store does not have it. */
  #col(present: Set<string>, table: string, name: string, alias = name): string {
    return present.has(name) ? `${table}."${name}" AS ${alias}` : `NULL AS ${alias}`;
  }

  #date(present: Set<string>, table: string, name: string, alias: string): string {
    return present.has(name)
      ? `${appleSecondsSql(`${table}."${name}"`)} AS ${alias}`
      : `NULL AS ${alias}`;
  }

  /**
   * The text of a message, from whichever source has it.
   *
   * The column first because it is free, then the decoder. `textSource` is on
   * every result so a caller can see which answered — and so the 3.1% that only
   * the decoder can reach are visible rather than indistinguishable from empty.
   */
  #body(row: Record<string, unknown>): { text: string | null; source: MessageRow["textSource"] } {
    const column = text(row.text);
    if (column !== null) return { text: column, source: "column" };
    const blob = row.attributedBody;
    if (blob instanceof Uint8Array && blob.length > 0) {
      const decoded = decodeAttributedBody(blob);
      if (decoded.ok && decoded.text.length > 0) return { text: decoded.text, source: "decoded" };
    }
    return { text: null, source: "none" };
  }

  #messageColumns(): string {
    const m = this.caps.messageColumns;
    return [
      `m."guid" AS guid`,
      `m."text" AS text`,
      m.has("attributedBody") ? `m."attributedBody" AS attributedBody` : `NULL AS attributedBody`,
      this.#col(m, "m", "subject"),
      this.#col(m, "m", "service"),
      this.#col(m, "m", "is_from_me", "isFromMe"),
      this.#col(m, "m", "is_read", "isRead"),
      this.#col(m, "m", "is_sent", "isSent"),
      this.#col(m, "m", "is_delivered", "isDelivered"),
      this.#col(m, "m", "cache_has_attachments", "hasAttachments"),
      this.#col(m, "m", "associated_message_type", "reactionType"),
      this.#col(m, "m", "associated_message_guid", "reactionTarget"),
      this.#col(m, "m", "thread_originator_guid", "threadOriginator"),
      this.#col(m, "m", "item_type", "itemType"),
      this.#date(m, "m", "date", "sentAt"),
      this.#date(m, "m", "date_read", "readAt"),
      this.#date(m, "m", "date_delivered", "deliveredAt"),
      this.#date(m, "m", "date_edited", "editedAt"),
      `h."id" AS handle`,
      `c."guid" AS chatGuid`,
      this.#col(this.caps.chatColumns, "c", "display_name", "chatName"),
    ].join(",\n           ");
  }

  #joins(): string {
    return `LEFT JOIN "handle" h ON h."ROWID" = m."handle_id"
       LEFT JOIN "chat_message_join" cmj ON cmj."message_id" = m."ROWID"
       LEFT JOIN "chat" c ON c."ROWID" = cmj."chat_id"`;
  }

  #toRow(r: Record<string, unknown>): MessageRow {
    const body = this.#body(r);
    return {
      guid: String(r.guid),
      chatGuid: text(r.chatGuid),
      chatName: text(r.chatName),
      handle: text(r.handle),
      service: text(r.service),
      isFromMe: bool(r.isFromMe),
      sentAt: num(r.sentAt),
      readAt: num(r.readAt),
      deliveredAt: num(r.deliveredAt),
      editedAt: num(r.editedAt),
      text: body.text,
      textSource: body.source,
      subject: text(r.subject),
      isRead: bool(r.isRead),
      isSent: bool(r.isSent),
      isDelivered: bool(r.isDelivered),
      hasAttachments: bool(r.hasAttachments),
      reactionType: num(r.reactionType) || null,
      reactionTarget: text(r.reactionTarget),
      threadOriginator: text(r.threadOriginator),
      itemType: num(r.itemType),
    };
  }

  /**
   * A window of messages, newest first.
   *
   * Reactions are excluded by default. They are rows in this table like any
   * other, and 2,788 of them would otherwise appear as messages reading
   * `Liked "see you at 8"` — which is not something anybody typed.
   */
  range(q: RangeQuery): MessageRow[] {
    const m = this.caps.messageColumns;
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.chatGuid) {
      where.push(`c."guid" = ?`);
      params.push(q.chatGuid);
    }
    if (q.fromApple !== undefined && m.has("date")) {
      where.push(`${appleSecondsSql('m."date"')} >= ?`);
      params.push(q.fromApple);
    }
    if (q.toApple !== undefined && m.has("date")) {
      where.push(`${appleSecondsSql('m."date"')} < ?`);
      params.push(q.toApple);
    }
    if (!q.includeReactions && m.has("associated_message_type")) {
      where.push(`(m."associated_message_type" IS NULL OR m."associated_message_type" = 0)`);
    }

    const sql = `
      SELECT ${this.#messageColumns()}
        FROM "message" m
        ${this.#joins()}
       ${where.length ? `WHERE ${where.join("\n         AND ")}` : ""}
       ORDER BY m."date" DESC
       LIMIT ${Math.max(1, Math.trunc(q.limit))}`;
    const rows = this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => this.#toRow(r));
  }

  /**
   * Text search, in two passes — and the second one is the point.
   *
   * Pass 1 is `LIKE` on the column: measured at **16 ms over 97,416 rows** with
   * 27 existing indexes, so there is no index-vs-scan tradeoff to litigate and
   * no FTS table to build.
   *
   * Pass 2 covers what pass 1 structurally cannot. 3,051 messages have an empty
   * `text` and content only in `attributedBody`, and no amount of SQL reaches
   * inside a blob. Decoding them costs about **6 ms** — the decoder runs at
   * 2 ms per thousand — so completeness here is nearly free, and a search that
   * silently omitted one message in thirty-two would be the worst kind of wrong.
   */
  search(query: string, limit: number, includeReactions = false): MessageRow[] {
    const m = this.caps.messageColumns;
    const needle = `%${escapeLike(query)}%`;
    const reactionFilter =
      !includeReactions && m.has("associated_message_type")
        ? `AND (m."associated_message_type" IS NULL OR m."associated_message_type" = 0)`
        : "";
    const cap = Math.max(1, Math.trunc(limit));

    const fromColumn = this.db
      .prepare(
        `SELECT ${this.#messageColumns()}
           FROM "message" m
           ${this.#joins()}
          WHERE m."text" LIKE ? ESCAPE '\\' ${reactionFilter}
          ORDER BY m."date" DESC
          LIMIT ${cap}`,
      )
      .all(needle) as Record<string, unknown>[];

    const results = fromColumn.map((r) => this.#toRow(r));
    if (results.length >= cap || !m.has("attributedBody")) return results;

    // Only the blob-only rows: 3,051 of 97,416 on the probed store.
    const blobOnly = this.db
      .prepare(
        `SELECT ${this.#messageColumns()}
           FROM "message" m
           ${this.#joins()}
          WHERE (m."text" IS NULL OR m."text" = '')
            AND m."attributedBody" IS NOT NULL ${reactionFilter}
          ORDER BY m."date" DESC`,
      )
      .all() as Record<string, unknown>[];

    const lowered = query.toLowerCase();
    for (const raw of blobOnly) {
      if (results.length >= cap) break;
      const row = this.#toRow(raw);
      if (row.text && row.text.toLowerCase().includes(lowered)) results.push(row);
    }
    return results.slice(0, cap);
  }

  byGuid(guid: string): MessageRow | null {
    const rows = this.db
      .prepare(
        `SELECT ${this.#messageColumns()}
           FROM "message" m
           ${this.#joins()}
          WHERE m."guid" = ?
          LIMIT 1`,
      )
      .all(guid) as Record<string, unknown>[];
    return rows[0] ? this.#toRow(rows[0]) : null;
  }

  /** Tapbacks aimed at one message. */
  reactionsFor(guid: string): { type: number; label: string; handle: string | null }[] {
    if (!this.caps.hasReactions) return [];
    // Apple prefixes the target with `p:0/` on some rows, so match the tail.
    const rows = this.db
      .prepare(
        `SELECT m."associated_message_type" AS type, h."id" AS handle
           FROM "message" m
           LEFT JOIN "handle" h ON h."ROWID" = m."handle_id"
          WHERE m."associated_message_guid" LIKE ? ESCAPE '\\'
            AND m."associated_message_type" > 0
          ORDER BY m."date" ASC`,
      )
      .all(`%${escapeLike(guid)}`) as Record<string, unknown>[];
    return rows.flatMap((r) => {
      const type = num(r.type);
      if (type === null) return [];
      return [{ type, label: reactionLabel(type), handle: text(r.handle) }];
    });
  }

  /**
   * The attachments on one message.
   *
   * `id` is `attachment.guid`, for the reason `ref.ts` gives at length about
   * messages: the ROWID is faster and gets REUSED. Every "delete this
   * conversation" frees a block of attachment ids for the next insert, so a
   * caller that listed attachments in one turn and saved one two turns later
   * would write out a different file, silently. The guid is `UNIQUE NOT NULL`
   * in the shipped schema and is what Apple's own sync joins on.
   *
   * `path` is the raw `filename` column, reported so a caller can see WHERE the
   * bytes are before asking for them — it is frequently `~`-prefixed, and it is
   * empty for an attachment iCloud has offloaded.
   */
  attachmentsFor(guid: string): {
    id: string | null;
    path: string | null;
    mimeType: string | null;
    transferName: string | null;
    bytes: number | null;
    isSticker: boolean;
  }[] {
    if (!this.caps.hasAttachments) return [];
    const a = this.caps.attachmentColumns;
    const rows = this.db
      .prepare(
        `SELECT ${this.#col(a, "a", "guid", "id")},
                ${this.#col(a, "a", "filename", "path")},
                ${this.#col(a, "a", "mime_type", "mimeType")},
                ${this.#col(a, "a", "transfer_name", "transferName")},
                ${this.#col(a, "a", "total_bytes", "bytes")},
                ${this.#col(a, "a", "is_sticker", "isSticker")}
           FROM "attachment" a
           JOIN "message_attachment_join" maj ON maj."attachment_id" = a."ROWID"
           JOIN "message" m ON m."ROWID" = maj."message_id"
          WHERE m."guid" = ?`,
      )
      .all(guid) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: text(r.id),
      path: text(r.path),
      mimeType: text(r.mimeType),
      transferName: text(r.transferName),
      bytes: num(r.bytes),
      isSticker: num(r.isSticker) === 1,
    }));
  }

  /** One attachment by its guid, wherever it hangs. Null when it is gone. */
  attachmentById(id: string): {
    id: string | null;
    path: string | null;
    mimeType: string | null;
    transferName: string | null;
    bytes: number | null;
  } | null {
    if (!this.caps.hasAttachments) return null;
    const a = this.caps.attachmentColumns;
    if (!a.has("guid")) return null;
    const row = this.db
      .prepare(
        `SELECT ${this.#col(a, "a", "guid", "id")},
                ${this.#col(a, "a", "filename", "path")},
                ${this.#col(a, "a", "mime_type", "mimeType")},
                ${this.#col(a, "a", "transfer_name", "transferName")},
                ${this.#col(a, "a", "total_bytes", "bytes")}
           FROM "attachment" a WHERE a."guid" = ? LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      path: text(row.path),
      mimeType: text(row.mimeType),
      transferName: text(row.transferName),
      bytes: num(row.bytes),
    };
  }

  chats(limit: number): ChatRow[] {
    return this.#chats("", [], limit);
  }

  /** One chat, by the guid a ref carries. Null when it has been deleted. */
  chatByGuid(guid: string): ChatRow | null {
    return this.#chats(`WHERE c."guid" = ?`, [guid], 1)[0] ?? null;
  }

  /**
   * The chats that already exist with a set of handles, newest first.
   *
   * This is what makes a send addressable at all. Messages will not enumerate
   * participants for a script, so the write lane cannot look a person up — but
   * it can address a chat by guid, and the guid lives here. The read lane
   * choosing the target for the write lane is the whole arrangement; see
   * `client/jxa/core.ts`.
   *
   * Handles are matched as given. Suffix matching happens a layer up in
   * `client/messages.ts`, where `packages/contacts`' measured `suffixKey` is
   * available and the candidate list is the store's own 1,075 handles.
   */
  chatsForHandles(handles: readonly string[], limit = 10): ChatRow[] {
    if (!handles.length) return [];
    const marks = handles.map(() => "?").join(", ");
    return this.#chats(
      `WHERE c."ROWID" IN (
           SELECT chj."chat_id"
             FROM "chat_handle_join" chj
             JOIN "handle" h2 ON h2."ROWID" = chj."handle_id"
            WHERE h2."id" IN (${marks}))`,
      [...handles],
      limit,
    );
  }

  /**
   * Outgoing messages in a set of chats since an instant — the send's receipt.
   *
   * `docs/messages.md` recorded that Apple Events returns no chat identifier, so
   * a send "cannot report what it wrote by id". That is true of the write lane
   * alone and false of the pair: the row Messages writes for an outgoing message
   * is an ordinary row in this table, and a narrow window plus the target chat
   * identifies it. Matching on text as well would be wrong — two identical
   * messages a minute apart are a normal thing to send — so the caller passes a
   * `sinceApple` taken immediately BEFORE the send and takes the oldest match.
   */
  sentSince(chatGuids: readonly string[], sinceApple: number, limit = 10): MessageRow[] {
    const m = this.caps.messageColumns;
    if (!chatGuids.length || !m.has("date")) return [];
    const marks = chatGuids.map(() => "?").join(", ");
    const fromMe = m.has("is_from_me") ? `AND m."is_from_me" = 1` : "";
    const rows = this.db
      .prepare(
        `SELECT ${this.#messageColumns()}
           FROM "message" m
           ${this.#joins()}
          WHERE c."guid" IN (${marks})
            AND ${appleSecondsSql('m."date"')} >= ?
            ${fromMe}
          ORDER BY m."date" ASC
          LIMIT ${Math.max(1, Math.trunc(limit))}`,
      )
      .all(...([...chatGuids, sinceApple] as never[])) as Record<string, unknown>[];
    return rows.map((r) => this.#toRow(r));
  }

  #chats(where: string, params: readonly unknown[], limit: number): ChatRow[] {
    const c = this.caps.chatColumns;
    const rows = this.db
      .prepare(
        `SELECT c."ROWID" AS rowid,
                c."guid" AS guid,
                ${this.#col(c, "c", "chat_identifier", "identifier")},
                ${this.#col(c, "c", "display_name", "displayName")},
                ${this.#col(c, "c", "style")},
                ${this.#col(c, "c", "service_name", "service")},
                COUNT(cmj."message_id") AS messages,
                ${appleSecondsSql('MAX(m."date")')} AS lastMessageAt
           FROM "chat" c
           LEFT JOIN "chat_message_join" cmj ON cmj."chat_id" = c."ROWID"
           LEFT JOIN "message" m ON m."ROWID" = cmj."message_id"
          ${where}
          GROUP BY c."ROWID"
          ORDER BY MAX(m."date") DESC
          LIMIT ${Math.max(1, Math.trunc(limit))}`,
      )
      .all(...(params as never[])) as Record<string, unknown>[];

    const participants = this.#participants(rows.map((r) => Number(r.rowid)));
    return rows.map((r) => {
      const style = num(r.style);
      return {
        guid: String(r.guid),
        identifier: text(r.identifier),
        displayName: text(r.displayName),
        style,
        // 43 is a group chat and 45 is one-to-one, measured. The participant
        // count is the check: a "one-to-one" with four people is a drift signal.
        isGroup: style === 43 || (participants.get(Number(r.rowid))?.length ?? 0) > 1,
        service: text(r.service),
        participants: participants.get(Number(r.rowid)) ?? [],
        messages: Number(r.messages ?? 0),
        lastMessageAt: num(r.lastMessageAt),
      };
    });
  }

  #participants(chatRowIds: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!chatRowIds.length) return out;
    const marks = chatRowIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT chj."chat_id" AS chatId, h."id" AS handle
           FROM "chat_handle_join" chj
           JOIN "handle" h ON h."ROWID" = chj."handle_id"
          WHERE chj."chat_id" IN (${marks})`,
      )
      .all(...(chatRowIds as never[])) as Record<string, unknown>[];
    for (const r of rows) {
      const id = Number(r.chatId);
      const handle = text(r.handle);
      if (!handle) continue;
      const bucket = out.get(id);
      if (bucket) bucket.push(handle);
      else out.set(id, [handle]);
    }
    return out;
  }

  /** Every distinct handle in the store, for a bulk resolve. */
  handles(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT "id" AS id FROM "handle" WHERE "id" IS NOT NULL AND "id" <> ''`)
      .all() as Record<string, unknown>[];
    return rows.flatMap((r) => {
      const h = text(r.id);
      return h ? [h] : [];
    });
  }

  counts(): { messages: number; chats: number; handles: number; attachments: number } {
    const one = (sql: string): number => {
      try {
        return Number((this.db.prepare(sql).get() as { c: number }).c ?? 0);
      } catch {
        return 0;
      }
    };
    return {
      messages: one(`SELECT COUNT(*) AS c FROM "message"`),
      chats: one(`SELECT COUNT(*) AS c FROM "chat"`),
      handles: one(`SELECT COUNT(*) AS c FROM "handle"`),
      attachments: this.caps.hasAttachments ? one(`SELECT COUNT(*) AS c FROM "attachment"`) : 0,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Closing a database that already failed is not worth reporting.
    }
  }
}

export const introspect = (db: DatabaseSync): StoreCapabilities => {
  const messageColumns = new Set(columnsOf(db, "message"));
  const chatColumns = new Set(columnsOf(db, "chat"));
  const handleColumns = new Set(columnsOf(db, "handle"));

  for (const t of REQUIRED) {
    const cols = t === "message" ? messageColumns : t === "chat" ? chatColumns : handleColumns;
    if (cols.size === 0) {
      throw new SchemaDriftError(
        `This Messages store has no ${t} table. It was probed on macOS ${PROBED_MACOS} with ` +
          `schema fingerprint ${PROBED_FINGERPRINT} (a PROBE fingerprint — compare it against ` +
          `another probe run, not against the one diagnostics reports); re-run ` +
          `\`pnpm probe:messages\` to see what changed.`,
      );
    }
  }

  const attachmentColumns = new Set(columnsOf(db, "attachment"));
  return {
    fingerprint: fingerprintSchema(db),
    messageColumns,
    chatColumns,
    handleColumns,
    attachmentColumns,
    hasAttachments:
      attachmentColumns.size > 0 && columnsOf(db, "message_attachment_join").length > 0,
    hasReactions: messageColumns.has("associated_message_type"),
    hasThreads: messageColumns.has("thread_originator_guid"),
    hasEdits: messageColumns.has("date_edited"),
  };
};

export const openStore = (
  path: string | null,
  mode: ReadOnlyMode,
  logger?: Logger,
): MessagesStore | null => {
  if (!path) return null;
  const {
    db,
    mode: used,
    validated,
  } = openReadOnly<StoreCapabilities>(path, mode, {
    label: "Messages store",
    envVar: "APPLE_MESSAGES_INDEX_MODE",
    validate: introspect,
    fatal: (err) => err instanceof SchemaDriftError,
    onFallback: () =>
      logger?.debug?.(
        "opened the Messages store with immutable=1, which skips the write-ahead log — recent " +
          "messages may be missing until Messages checkpoints. The measured WAL was ~0.5 MB.",
      ),
  });
  return new MessagesStore(db, used, validated);
};
