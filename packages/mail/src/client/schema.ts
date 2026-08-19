import type { DatabaseSync } from "node:sqlite";

import {
  CORE_DATA_EPOCH_OFFSET,
  detectEpoch,
  fingerprintSchema,
  tableMap,
} from "@mgcrea/mcp-apple-core";

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

export { CORE_DATA_EPOCH_OFFSET, detectEpoch };

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

export const introspect = (db: DatabaseSync, now?: number): IndexCapabilities => {
  const fingerprint = fingerprintSchema(db);
  const tables = tableMap(db);
  const tableNames = Object.keys(tables);

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
