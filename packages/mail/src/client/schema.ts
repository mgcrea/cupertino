import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { SchemaDriftError } from "./errors.js";

/**
 * Introspect the Envelope Index once per connection.
 *
 * Apple owns this schema and can reshape it in any macOS release, so nothing
 * here assumes a column exists. Required columns missing means the lane goes
 * `unavailable` with a message naming them; optional ones simply switch query
 * variants off. The failure mode we are avoiding is a `SELECT *` that starts
 * throwing after a system update and takes the whole server down with it.
 */

/** 2001-01-01T00:00:00Z in Unix seconds — the Core Data epoch. */
export const CORE_DATA_EPOCH_OFFSET = 978_307_200;

export type IndexCapabilities = {
  fingerprint: string;
  tables: Record<string, string[]>;
  has: {
    labels: boolean;
    recipients: boolean;
    attachments: boolean;
    subjects: boolean;
    addresses: boolean;
    subjectPrefix: boolean;
    conversationId: boolean;
    flagged: boolean;
    dateSent: boolean;
    messageIdHeader: boolean;
    mailboxCounts: boolean;
  };
  /** Detected, never assumed — prior art disagrees about which epoch this is. */
  epochOffset: number;
  epochReason: string;
  missing: string[];
};

const REQUIRED: Record<string, string[]> = {
  messages: ["mailbox", "subject", "sender", "date_received", "read", "deleted"],
  mailboxes: ["url"],
  subjects: ["subject"],
  addresses: ["address"],
};

const columnsOf = (db: DatabaseSync, table: string): string[] => {
  try {
    return (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  } catch {
    return [];
  }
};

/**
 * Work out whether `date_received` is Unix seconds or Core Data seconds by
 * seeing which reading lands near today. Two independent prior-art projects
 * disagree about this, and hardcoding the wrong one puts every date 31 years
 * out — a bug that looks like corruption rather than a unit mismatch.
 */
export const detectEpoch = (
  maxDateReceived: number | null,
  now: number = Date.now(),
): { offset: number; reason: string } => {
  if (maxDateReceived === null || !Number.isFinite(maxDateReceived) || maxDateReceived <= 0) {
    return { offset: 0, reason: "no dated messages; assuming unix seconds" };
  }
  const nowSec = now / 1000;
  const tenYears = 10 * 365.25 * 24 * 3600;
  const asUnix = Math.abs(nowSec - maxDateReceived);
  const asCoreData = Math.abs(nowSec - (maxDateReceived + CORE_DATA_EPOCH_OFFSET));

  if (asUnix < tenYears && asUnix <= asCoreData) {
    return { offset: 0, reason: "raw value lands within 10 years of now" };
  }
  if (asCoreData < tenYears) {
    return {
      offset: CORE_DATA_EPOCH_OFFSET,
      reason: "value + 978307200 lands within 10 years of now",
    };
  }
  return {
    offset: 0,
    reason: `neither epoch lands near now (max=${maxDateReceived}); assuming unix`,
  };
};

export const introspect = (db: DatabaseSync, now?: number): IndexCapabilities => {
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as { sql: string }[];
  const fingerprint = createHash("sha256")
    .update(ddl.map((r) => r.sql).join("\n"))
    .digest("hex")
    .slice(0, 12);

  const tableNames = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);

  const tables: Record<string, string[]> = {};
  for (const t of tableNames) tables[t] = columnsOf(db, t);

  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED)) {
    if (!tables[table]) {
      missing.push(`${table} (table)`);
      continue;
    }
    for (const c of cols) if (!tables[table]?.includes(c)) missing.push(`${table}.${c}`);
  }

  const messageCols = tables.messages ?? [];
  let epoch = { offset: 0, reason: "not probed" };
  if (missing.length === 0) {
    const row = db.prepare("SELECT MAX(date_received) AS m FROM messages").get() as {
      m: number | null;
    };
    epoch = detectEpoch(row?.m ?? null, now);
  }

  return {
    fingerprint,
    tables,
    has: {
      labels: tableNames.includes("labels"),
      recipients: tableNames.includes("recipients"),
      attachments: tableNames.includes("attachments"),
      subjects: tableNames.includes("subjects"),
      addresses: tableNames.includes("addresses"),
      subjectPrefix: messageCols.includes("subject_prefix"),
      conversationId: messageCols.includes("conversation_id"),
      flagged: messageCols.includes("flagged"),
      dateSent: messageCols.includes("date_sent"),
      messageIdHeader: (tables.message_global_data ?? []).includes("message_id_header"),
      mailboxCounts: (tables.mailboxes ?? []).includes("unread_count"),
    },
    epochOffset: epoch.offset,
    epochReason: epoch.reason,
    missing,
  };
};

export const assertUsable = (caps: IndexCapabilities): void => {
  if (caps.missing.length > 0) {
    throw new SchemaDriftError(
      `Mail's search index is not the shape this server knows how to read (missing: ` +
        `${caps.missing.join(", ")}). This usually means a macOS upgrade changed the schema. ` +
        `The AppleScript lane still works; please report schema fingerprint ${caps.fingerprint}.`,
      { fingerprint: caps.fingerprint, missing: caps.missing },
    );
  }
};
