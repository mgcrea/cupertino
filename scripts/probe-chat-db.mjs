#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-messages.
//
// Messages is the surface docs/distribution.md singles out:
//
//     "Messages is the surface where Full Disk Access is not optional: there is
//      no AppleScript read path at all, so without the file lane there is no
//      server."
//
// That one sentence changes what this probe has to do. Every prior probe could
// check its file lane AGAINST the Apple Events lane — Notes' row predicate was
// only trustworthy because 921 rows matched 921 reminders fetched over Apple
// Events, and the phantom-notes bug was caught exactly there. Here there is no
// second opinion. Nothing to reconcile against, no count to cross-check.
//
// So this probe cannot prove its predicate the way its predecessors did, and
// pretending otherwise would be the most expensive kind of wrong. What it can do
// instead is answer the questions that decide whether the surface is buildable
// at all:
//
//     1. IS THE BODY EVEN IN `text` ANY MORE, or only in the `attributedBody`
//        blob? If bodies moved wholesale into the archive, the server needs a
//        typedstream decoder before it can return a single message, and that is
//        a different project than "read some rows".
//     2. WHICH EPOCH? `message.date` is NANOSECONDS since 2001 on modern
//        schemas and seconds on old ones. Both render as a plausible date. This
//        is the silent-31-year-error class of bug.
//     3. CAN A SENT MESSAGE BE TIED BACK TO A ROW? AppleScript can `send`.
//        If nothing joins that back to the store, writes and reads are two
//        disconnected halves.
//     4. WHAT DOES THE STORE HOLD THAT NOTHING ELSE CAN REACH? Reactions,
//        edits, replies, read receipts. This list IS the justification for the
//        permission.
//
// THIS PROBE HAS NO UNPRIVILEGED HALF. Without Full Disk Access it can report
// that the store exists and refuses to open, and nothing else. That is itself
// the finding docs/distribution.md predicts, so it prints rather than crashes.
//
// Dependency-free (node builtins + scripts/lib/probe-kit.mjs). The database is
// opened read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, booleans, column
// names and DDL only. No message text, no handles, no phone numbers, no email
// addresses, no chat names. Messages is the surface where this matters most —
// the store is a complete record of someone's private correspondence, and a
// probe report is the kind of thing that ends up pasted into an issue.
//
//   node scripts/probe-chat-db.mjs                # human-readable report
//   node scripts/probe-chat-db.mjs --json         # the raw document
//   node scripts/probe-chat-db.mjs --term=dinner  # word for the search timing
//   node scripts/probe-chat-db.mjs --launch       # allow launching Messages
//   node scripts/probe-chat-db.mjs --write        # also write the schema fixture
//
// `--write` emits packages/messages/test/fixtures/chat-db.sql — the DDL the
// index lane's offline tests build their database from.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appleEventsLane,
  detectEpoch,
  dumpSchema,
  escapeLike,
  fileFacts,
  findIdBridge,
  listable,
  macosVersion,
  maskIdentity,
  maxNumericAsText,
  openStore,
  osascript,
  parseArgs,
  safe,
  tableTools,
  timed,
  uuidOf,
  walkDir,
  writeFixture,
  yn,
} from "./lib/probe-kit.mjs";
import { decodeAttributedBody, outline } from "./lib/typedstream.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERM = args.term;

const MESSAGES_DIR = join(homedir(), "Library", "Messages");
const CHAT_DB = join(MESSAGES_DIR, "chat.db");
const ATTACHMENTS_DIR = join(MESSAGES_DIR, "Attachments");

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: macosVersion(),
  sqlite: null,
  searchTerm: TERM,
  findings: {},
  verdict: {},
  notes: [],
};

// ─── Lane 1: Apple Events, such as it is ────────────────────────────────────
//
// The claim in docs/distribution.md is "send only, no reads". That claim is
// worth TESTING rather than inheriting — it was written from the dictionary, and
// dictionaries and runtimes disagree more often than anyone likes. Messages has
// historically exposed a `chat` class; whether it still answers is the question.
//
// Nothing here sends anything. Composing a message would be an outward-facing
// side effect, and a measurement is not worth one.

const READ_ATTEMPTS = `
function run(argv) {
  var M = Application("Messages");
  var out = {};
  function attempt(name, fn) {
    var t0 = new Date().getTime();
    try {
      var v = fn();
      out[name] = { ok: true, ms: new Date().getTime() - t0, value: v };
    } catch (e) {
      out[name] = { ok: false, ms: new Date().getTime() - t0, error: String(e).slice(0, 160) };
    }
  }
  // Counts only. Never the text of a chat, never a participant's handle.
  attempt("chats", function () { return M.chats().length; });
  attempt("chatIds", function () { return M.chats.id().length; });
  attempt("participants", function () { return M.participants().length; });
  attempt("buddies", function () { return M.buddies().length; });
  // The one that would matter most if it worked: reading messages of a chat.
  attempt("messagesOfChat", function () {
    var cs = M.chats();
    if (!cs.length) return null;
    return cs[0].messages().length;
  });
  return JSON.stringify({ attempts: out });
}
`;

/** One real chat id, for the bridge scan. Never printed unmasked. */
const CHAT_IDS = `
function run(argv) {
  var M = Application("Messages");
  return JSON.stringify({ ids: M.chats.id() });
}
`;

/**
 * The send lane's target ladder, stopped one step short of `send`.
 *
 * Mirrors `packages/messages/src/client/jxa/core.ts` rung for rung. Kept in two
 * places on purpose: this one must be readable as a measurement without the
 * package around it, and it must NOT contain a send at all — a probe that could
 * message somebody by accident is not a probe anyone should run.
 */
const RESOLVE_TARGET = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var M = Application("Messages");
  var out = {};
  function attempt(name, fn) {
    var t0 = new Date().getTime();
    try {
      out[name] = { ok: true, ms: new Date().getTime() - t0, value: fn() };
    } catch (e) {
      out[name] = { ok: false, ms: new Date().getTime() - t0, error: String(e).slice(0, 160) };
    }
  }
  // Rung 1, and the whole question: does Messages know the store's guid?
  attempt("chatByStoreGuid", function () {
    return String(M.chats.byId(p.chatGuid).id()) === p.chatGuid;
  });
  // Rung 2: the guid composed from the handle rather than read.
  attempt("chatByComposedGuid", function () {
    return String(M.chats.byId(p.service + ";-;" + p.handle).id()).length > 0;
  });
  // Rungs 3 and 4 enumerate, and are expected to fail on this surface.
  attempt("accounts", function () { return M.accounts().length; });
  attempt("participantByHandle", function () {
    return M.participants.whose({ handle: p.handle })().length;
  });
  return JSON.stringify({ attempts: out });
}
`;

const aeLane = appleEventsLane("com.apple.MobileSMS", "Messages", args.launch);
doc.findings.appleEventsLane = aeLane;

doc.findings.appleEventsReads = aeLane.available
  ? timed("readAttempts", READ_ATTEMPTS, {}, 120_000)
  : { skipped: true, reason: aeLane.reason };

const attempts = doc.findings.appleEventsReads?.attempts ?? {};
/**
 * Messages answers "Application isn't running" to Apple Events even while
 * NSRunningApplication reports it running — it lives as a background process
 * with no window and declines to wake for a script. So the liveness check and
 * the app's own answer DISAGREE for this surface, and neither is lying. Recorded
 * because it looks exactly like a broken probe and is not: it is one more way
 * Messages has no read lane.
 */
const claimsNotRunning = Object.values(attempts).some((a) =>
  /isn't running|is not running/i.test(String(a.error ?? "")),
);
// "No read path" and "we did not look" are different findings. Only the first is
// evidence for docs/distribution.md's claim, so the second must not masquerade as it.
const anyReadWorked = Object.values(attempts).some((a) => a.ok && a.value !== null);
const readPathTested = aeLane.available;

// ─── Lane 2: the file lane. Without it there is no server. ──────────────────

doc.findings.store = {
  ...fileFacts(CHAT_DB),
  // Redact the home directory out of the printed path.
  path: CHAT_DB.replace(homedir(), "~"),
  dirListable: listable(MESSAGES_DIR),
};

/** Captured DDL, kept for --write. Null until the file lane opens. */
let ddlRows = null;
let opened = null;

if (doc.findings.store.readable) {
  opened = openStore(CHAT_DB);
}

if (opened?.db) {
  const db = opened.db;
  const { columnInfo, countOf, one, all } = tableTools(db);
  doc.sqlite = opened.sqlite;
  doc.findings.open = {
    ms: opened.openMs,
    mode: opened.mode,
    // Recorded loudly: an immutable read skips the -wal, and chat.db is written
    // to constantly. Every count below would be missing recent traffic.
    walBlind: opened.walBlind,
  };

  const schema = dumpSchema(db);
  ddlRows = schema.ddlRows;
  doc.findings.schema = {
    objectCount: schema.objectCount,
    tables: schema.tables,
    views: schema.views,
    fingerprint: schema.fingerprint,
  };
  const tables = schema.tables;
  const hasTable = (t) => tables.includes(t);
  const colsOf = (t) => columnInfo(t).map((c) => c.name);

  doc.findings.tableCounts = Object.fromEntries(tables.map((t) => [t, countOf(t)]));

  /**
   * Q0. Is this the schema anyone writes about?
   *
   * The join shape is the part every third-party chat.db reader assumes, and it
   * has changed before. Check it rather than inherit it.
   */
  doc.findings.joinShape = {
    message: hasTable("message"),
    chat: hasTable("chat"),
    handle: hasTable("handle"),
    attachment: hasTable("attachment"),
    chatMessageJoin: hasTable("chat_message_join"),
    chatHandleJoin: hasTable("chat_handle_join"),
    messageAttachmentJoin: hasTable("message_attachment_join"),
    messageColumns: colsOf("message").length,
    chatColumns: colsOf("chat").length,
  };

  /**
   * Q1, THE BLOCKING QUESTION: where does the body actually live?
   *
   * `message.text` is what every tutorial reads. `message.attributedBody` is an
   * NSArchiver typedstream that Messages started populating years ago, and on
   * some rows it is the ONLY copy. If the "text is empty but attributedBody is
   * not" bucket is large, the server needs a typedstream decoder before it can
   * return a message at all — the same shape of surprise Notes' ZDATA turned out
   * to be, and worth finding now rather than after the tools are written.
   *
   * REDACTION: lengths and counts only. The first 16 bytes of the blob are read
   * as hex to identify the ARCHIVE FORMAT ("streamtyped" is a fixed literal
   * header, not content) — nothing that varies with what anyone said.
   */
  doc.findings.bodyStorage = safe(() => {
    if (!hasTable("message")) return { tested: false, reason: "no message table" };
    const cols = colsOf("message");
    const hasText = cols.includes("text");
    const hasAttributed = cols.includes("attributedBody");
    if (!hasText) return { tested: false, reason: "message has no text column" };

    const emptyText = `("text" IS NULL OR "text" = '')`;
    const row = one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${emptyText} THEN 0 ELSE 1 END) AS withText
         FROM message`,
    );
    const attributed = hasAttributed
      ? one(
          `SELECT SUM(CASE WHEN attributedBody IS NOT NULL THEN 1 ELSE 0 END) AS withBlob,
                  SUM(CASE WHEN ${emptyText} AND attributedBody IS NOT NULL THEN 1 ELSE 0 END) AS blobOnly,
                  SUM(CASE WHEN ${emptyText} AND attributedBody IS NULL THEN 1 ELSE 0 END) AS neither,
                  MAX(LENGTH(attributedBody)) AS maxBlobBytes,
                  AVG(LENGTH(attributedBody)) AS avgBlobBytes
             FROM message`,
        )
      : null;

    /**
     * The same split, PER YEAR — because the aggregate hides the finding.
     *
     * 3.1% blob-only reads like an edge case. It is an average over a decade:
     * measured through the built server, 2016-2025 are ~99% plain `text` and
     * everything from March 2026 onward is blob-only, because Apple stopped
     * writing the column. A probe that reports only the total would let a reader
     * conclude the decoder is optional, which for anything recent it is not.
     *
     * `date` is nanoseconds and overflows a JS double, so the year is taken in
     * SQL — the same reason every date in this file is read as TEXT or divided
     * down before it reaches JavaScript.
     */
    const byYear = hasAttributed
      ? all(
          `SELECT CAST(strftime('%Y', (CAST("date" AS REAL) / 1000000000.0) + 978307200, 'unixepoch') AS INTEGER) AS year,
                  COUNT(*) AS total,
                  SUM(CASE WHEN ${emptyText} AND attributedBody IS NOT NULL THEN 1 ELSE 0 END) AS blobOnly
             FROM message
            WHERE "date" > 0
            GROUP BY year
            ORDER BY year`,
        ).map((r) => ({
          year: r.year,
          total: r.total,
          blobOnly: r.blobOnly,
          blobOnlyPct: r.total ? Number(((r.blobOnly / r.total) * 100).toFixed(1)) : null,
        }))
      : [];

    // The archive header, so the doc can name the format instead of guessing it.
    const magic = hasAttributed
      ? (one(
          `SELECT HEX(SUBSTR(attributedBody, 1, 16)) AS hex
             FROM message WHERE attributedBody IS NOT NULL LIMIT 1`,
        )?.hex ?? null)
      : null;
    const magicAscii = magic
      ? Buffer.from(magic, "hex")
          .toString("latin1")
          .replace(/[^\x20-\x7e]/g, ".")
      : null;

    return {
      tested: true,
      hasAttributedBodyColumn: hasAttributed,
      total: row?.total ?? null,
      withText: row?.withText ?? null,
      withBlob: attributed?.withBlob ?? null,
      // The number that decides whether a decoder is mandatory.
      blobOnly: attributed?.blobOnly ?? null,
      neither: attributed?.neither ?? null,
      maxBlobBytes: attributed?.maxBlobBytes ?? null,
      avgBlobBytes: attributed?.avgBlobBytes ? Math.round(attributed.avgBlobBytes) : null,
      archiveHeaderHex: magic,
      archiveHeaderAscii: magicAscii,
      byYear,
    };
  });

  /**
   * Q1.5. DOES THE DECODER ACTUALLY WORK? — the gate before any package code.
   *
   * `scripts/lib/typedstream.mjs` was written against ground truth rather than
   * against a reading of the format: `NSArchiver` still ships on macOS 26 and is
   * what wrote every blob in this store, so archiving a KNOWN string through it
   * produces a fixture whose plaintext nobody has to guess. Nineteen offline
   * tests pass on that basis.
   *
   * That proves the decoder against eight blobs Apple's archiver made TODAY. It
   * does not prove it against 97,092 blobs written by a decade of iOS versions,
   * and the difference is exactly the kind of gap this project keeps falling
   * into. So this measures it, and the oracle is free: **`text` is populated on
   * 94,049 rows and the blob on 97,092**, so ~94k rows are labelled examples.
   * Decode the blob, compare to the column, count the disagreements.
   *
   * If that agreement is not essentially total, the 3,043 blob-only rows cannot
   * be trusted either and the decoder needs work before a server ships it.
   *
   * REDACTION: no message text, ever. Counts, rates, lengths and Apple's own
   * class names only. Failing blobs are described by `outline()`, which reduces
   * every string to `<str len=N>` and keeps only Apple constants.
   */
  doc.findings.decoder = safe(() => {
    if (!hasTable("message")) return { tested: false, reason: "no message table" };
    const cols = colsOf("message");
    if (!cols.includes("attributedBody")) {
      return { tested: false, reason: "message has no attributedBody column" };
    }

    const stats = {
      rows: 0,
      decoded: 0,
      failed: 0,
      withAttributes: 0,
      // The oracle.
      comparable: 0,
      exact: 0,
      differs: 0,
      // The rows that only the decoder can answer.
      blobOnly: 0,
      blobOnlyDecoded: 0,
      emptyDecode: 0,
    };
    const failureReasons = {};
    const classCounts = {};
    const failureOutlines = [];
    const diffShapes = [];

    const started = performance.now();
    // Streamed in pages so a 216 MB store never lands in memory at once.
    const PAGE = 5_000;
    let lastRowid = 0;
    for (;;) {
      const page = all(
        `SELECT ROWID AS rowid, "text" AS text, "attributedBody" AS blob
           FROM message
          WHERE ROWID > ? AND "attributedBody" IS NOT NULL
          ORDER BY ROWID LIMIT ${PAGE}`,
        lastRowid,
      );
      if (!page.length) break;
      lastRowid = page.at(-1).rowid;

      for (const row of page) {
        stats.rows += 1;
        const blob = row.blob;
        const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob ?? []);
        const result = decodeAttributedBody(buf);
        const hasText = typeof row.text === "string" && row.text.length > 0;
        if (!hasText) stats.blobOnly += 1;

        if (!result.ok) {
          stats.failed += 1;
          failureReasons[result.error] = (failureReasons[result.error] ?? 0) + 1;
          if (failureOutlines.length < 5) {
            failureOutlines.push({ reason: result.error, tokens: outline(buf, 40) });
          }
          continue;
        }

        stats.decoded += 1;
        if (result.hasAttributes) stats.withAttributes += 1;
        if (result.text.length === 0) stats.emptyDecode += 1;
        if (!hasText) stats.blobOnlyDecoded += 1;
        for (const cls of result.classes) classCounts[cls] = (classCounts[cls] ?? 0) + 1;

        if (hasText) {
          stats.comparable += 1;
          if (result.text === row.text) stats.exact += 1;
          else {
            stats.differs += 1;
            // Shapes only. A diff is the most tempting thing to print and the
            // one thing that would put two people's messages in a report.
            if (diffShapes.length < 10) {
              diffShapes.push({
                textChars: row.text.length,
                decodedChars: result.text.length,
                decodedIsPrefix: row.text.startsWith(result.text),
                textIsPrefix: result.text.startsWith(row.text),
              });
            }
          }
        }
      }
    }

    const ms = Math.round(performance.now() - started);
    return {
      tested: true,
      ms,
      msPerThousand: stats.rows ? Math.round((ms / stats.rows) * 1000) : null,
      ...stats,
      decodeRate: stats.rows ? Number(((stats.decoded / stats.rows) * 100).toFixed(2)) : null,
      // THE NUMBER. Agreement with the column, on every row that has both.
      oracleAgreement: stats.comparable
        ? Number(((stats.exact / stats.comparable) * 100).toFixed(3))
        : null,
      failureReasons,
      // Apple's own class names. Which ones appear says what the blobs contain.
      classes: Object.fromEntries(
        Object.entries(classCounts)
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 15),
      ),
      failureOutlines,
      diffShapes,
    };
  });

  /**
   * Q2. Which epoch, decided by whether the answer is a plausible date.
   *
   * Messages switched `date` from seconds to NANOSECONDS since 2001 around
   * macOS 10.13, and both readings produce a date that looks fine at a glance.
   * `packages/core/src/schema.ts` has a `detectEpoch`; this checks whether its
   * assumptions cover the nanosecond case rather than assuming they do.
   */
  doc.findings.epoch = safe(() => {
    if (!hasTable("message")) return { tested: false, reason: "no message table" };
    const dateCols = colsOf("message").filter((c) => c.startsWith("date"));
    const out = {};
    let anyOverflow = false;
    for (const c of dateCols) {
      // Read as TEXT: a plain MAX() throws on these, and a swallowed throw is
      // indistinguishable from an empty column. See maxNumericAsText.
      const max = maxNumericAsText(db, "message", c);
      if (max.exceedsSafeInteger) anyOverflow = true;
      out[c] = {
        ...detectEpoch(max.value),
        digits: max.digits ?? 0,
        exceedsSafeInteger: max.exceedsSafeInteger,
      };
    }
    return { tested: true, columns: out, anyExceedsSafeInteger: anyOverflow };
  });

  /**
   * Q3. Search cost. There is no Apple Events fallback to fall back TO, so this
   * is not a comparison — it is a straight answer to "can the server search".
   */
  doc.findings.search = safe(() => {
    if (!hasTable("message")) return { tested: false, reason: "no message table" };
    const fts = tables.filter((t) => /fts|search/i.test(t));
    const started = performance.now();
    const hit = one(
      `SELECT COUNT(*) AS c FROM message WHERE text LIKE ? ESCAPE '\\'`,
      `%${escapeLike(TERM)}%`,
    );
    const likeMs = Math.round(performance.now() - started);
    // Indexes matter more here than anywhere else: this table is the big one.
    const indexes = all(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='message'`,
    ).map((r) => r.name);
    return {
      tested: true,
      ftsTables: fts,
      likeMs,
      hits: hit?.c ?? null,
      messageIndexes: indexes,
    };
  });

  /**
   * Q4. What the store holds that no other lane can reach.
   *
   * This list is the justification for asking for Full Disk Access on this
   * surface. Unlike Reminders, where a thin answer would mean "reconsider the
   * lane", a thin answer here means reconsider the SURFACE — there is nothing
   * else to fall back on.
   */
  doc.findings.capabilities = safe(() => {
    const probes = {
      reactions: { table: "message", cols: /associated_message_type|associated_message_guid/i },
      edits: { table: "message", cols: /message_summary_info|date_edited|part_count/i },
      replyThreads: { table: "message", cols: /thread_originator/i },
      unsent: { table: "message", cols: /date_retracted|is_delivered|was_deliv/i },
      receipts: { table: "message", cols: /date_read|date_delivered|is_read/i },
      expressive: { table: "message", cols: /expressive_send_style|balloon_bundle/i },
      groupChats: { table: "chat", cols: /room_name|group_id|display_name|style/i },
      attachments: { table: "attachment", cols: /filename|mime_type|total_bytes|transfer_name/i },
      service: { table: "handle", cols: /service|uncanonicalized/i },
    };
    const out = {};
    for (const [key, p] of Object.entries(probes)) {
      const matched = hasTable(p.table) ? colsOf(p.table).filter((c) => p.cols.test(c)) : [];
      out[key] = { table: p.table, columns: matched, present: matched.length > 0 };
    }
    // Reactions are worth counting, not just detecting: they are the single
    // largest category of "message" a naive reader renders as gibberish.
    if (out.reactions.present) {
      out.reactions.rows =
        one(
          `SELECT COUNT(*) AS c FROM message WHERE associated_message_type IS NOT NULL AND associated_message_type != 0`,
        )?.c ?? null;
    }
    if (out.replyThreads.present) {
      out.replyThreads.rows =
        one(`SELECT COUNT(*) AS c FROM message WHERE thread_originator_guid IS NOT NULL`)?.c ??
        null;
    }
    return out;
  });

  /**
   * Q5. Attachment bytes on disk. Same capability the Notes file lane bought,
   * and the same question: does a row point at a file that actually exists and
   * can be opened?
   *
   * REDACTION: filenames are never printed. Only whether they resolve.
   */
  doc.findings.attachments = safe(() => {
    if (!hasTable("attachment")) return { tested: false, reason: "no attachment table" };
    const total = countOf("attachment");
    const sample = all(
      `SELECT filename FROM attachment WHERE filename IS NOT NULL ORDER BY ROWID DESC LIMIT 25`,
    );
    let resolvable = 0;
    let missing = 0;
    for (const r of sample) {
      const p = String(r.filename).replace(/^~/, homedir());
      if (fileFacts(p).readable) resolvable += 1;
      else missing += 1;
    }
    let onDisk = 0;
    walkDir(ATTACHMENTS_DIR, { maxDepth: 4, onFile: () => (onDisk += 1) });
    return {
      tested: true,
      rows: total,
      sampled: sample.length,
      resolvable,
      missing,
      attachmentsDirListable: listable(ATTACHMENTS_DIR),
      filesOnDisk: onDisk,
    };
  });

  /**
   * Q6. Service mix, counts only. Decides whether "send" needs to distinguish
   * iMessage from SMS, and whether a server can assume one transport.
   */
  doc.findings.services = safe(() => {
    if (!hasTable("handle")) return { tested: false, reason: "no handle table" };
    const rows = all(`SELECT service, COUNT(*) AS c FROM handle GROUP BY service ORDER BY c DESC`);
    return { tested: true, byService: Object.fromEntries(rows.map((r) => [r.service, r.c])) };
  });

  /**
   * Q7. THE ID BRIDGE. Can anything AppleScript hands back be found in a row?
   *
   * If the read attempts above all failed, there is no identifier to search for
   * and this cannot be answered — which is itself the finding, and the reason
   * writes may end up unable to report what they wrote.
   */
  const truth = anyReadWorked ? timed("chatIds", CHAT_IDS, {}, 120_000) : null;
  const truthIds = (truth?.ids ?? []).map(String).filter(Boolean);
  doc.findings.idBridge = safe(() => {
    if (!truthIds.length) {
      return {
        tested: false,
        reason:
          "Apple Events returned no chat identifiers, so there is nothing to join on. " +
          "This confirms docs/distribution.md: reads are file-lane-only.",
      };
    }
    const sample = truthIds[0];
    const bare = uuidOf(sample);
    const result = findIdBridge(db, tables, columnInfo, [
      { form: "full id", value: sample },
      ...(bare && bare !== sample ? [{ form: "bare uuid", value: bare }] : []),
      // A guid is `service;-;handle`; the tail on its own is worth trying.
      { form: "id tail", value: sample.includes(";") ? sample.split(";").at(-1) : null },
    ]);
    return { ...result, idShape: maskIdentity(sample) };
  });

  // ─── The send lane's first rung, measured without sending anything ────────
  //
  // `--send-target=<handle>` answers the one question the send lane rests on
  // and cannot answer for itself: **is Messages' `chat.id` the same string as
  // `chat.guid` in the store?** If it is, a send can be addressed by a guid the
  // file lane already holds, which is the whole design (see docs/messages.md).
  // If it is not, every send falls through to rungs that enumerate — and
  // enumeration is what this app refuses.
  //
  // Nothing here sends. `resolveTarget` is exercised up to the point of `send`
  // and no further, so the worst this can do is launch Messages and ask for an
  // Automation grant. Output is masked: a guid contains a phone number.
  const SEND_TARGET = args.valueOf("send-target", "");
  if (SEND_TARGET) {
    const digits = SEND_TARGET.replaceAll(/\D/g, "");
    const suffix = digits.length >= 9 ? digits.slice(-9) : null;
    const row = safe(
      () =>
        db
          .prepare(
            `SELECT c."guid" AS guid, c."service_name" AS service
               FROM "chat" c
               JOIN "chat_handle_join" chj ON chj."chat_id" = c."ROWID"
               JOIN "handle" h ON h."ROWID" = chj."handle_id"
              WHERE c."style" = 45
                AND (h."id" = ? ${suffix ? `OR h."id" LIKE ?` : ""})
              LIMIT 1`,
          )
          .get(...(suffix ? [SEND_TARGET, `%${suffix}`] : [SEND_TARGET])),
      () => null,
    );

    if (!row?.guid) {
      doc.findings.sendTarget = {
        tested: false,
        reason: "No one-to-one chat in the store has that handle. Rung 1 cannot be tested for it.",
      };
    } else if (!aeLane.available) {
      doc.findings.sendTarget = { tested: false, reason: aeLane.reason };
    } else {
      const result = osascript(RESOLVE_TARGET, {
        chatGuid: row.guid,
        handle: SEND_TARGET,
        service: row.service ?? "iMessage",
      });
      doc.findings.sendTarget = {
        tested: true,
        storeGuidShape: String(row.guid).replace(/;[^;]*$/, ";<handle>"),
        attempts: Object.fromEntries(
          Object.entries(result?.attempts ?? {}).map(([k, v]) => [
            k,
            v.ok ? v.value : `failed: ${maskIdentity(String(v.error))}`,
          ]),
        ),
      };
    }
  }

  db.close();
} else {
  doc.findings.open = { ok: false, error: opened?.error ?? null };
  doc.notes.push(
    doc.findings.store.exists && !doc.findings.store.readable
      ? "chat.db exists and cannot be opened — Full Disk Access is not granted to this terminal. " +
          "This is the expected unprivileged result for Messages, and it is the whole finding: " +
          "there is no Apple Events read path to fall back on, so without the grant there is no server."
      : doc.findings.store.exists
        ? `chat.db is readable but SQLite refused both open modes: ${opened?.error ?? "unknown"}.`
        : "chat.db is not present at all. Messages has never been used on this account, or the " +
          "store has moved — either way, re-run on a machine with message history.",
  );
}

// ─── Verdict ────────────────────────────────────────────────────────────────

const body = doc.findings.bodyStorage ?? {};
const decoderMandatory = Boolean(body.tested && body.blobOnly > 0);
const decoderShare =
  body.tested && body.total ? Number(((body.blobOnly / body.total) * 100).toFixed(1)) : null;

const caps = doc.findings.capabilities ?? {};
const gained = Object.entries(caps)
  .filter(([, v]) => v.present)
  .map(([k]) => k);

doc.verdict = {
  fullDiskAccessGranted: Boolean(opened?.db),
  // The claim under test, now measured rather than inherited.
  appleEventsReadPathTested: readPathTested,
  appleEventsClaimsNotRunning: claimsNotRunning,
  appleEventsReadPathExists: readPathTested ? anyReadWorked : null,
  appleEventsAttempts: Object.fromEntries(
    Object.entries(attempts).map(([k, v]) => [k, v.ok ? v.value : `failed: ${v.error}`]),
  ),
  messageCount: body.total ?? null,
  decoderMandatory,
  decoderShare,
  capabilitiesGained: gained,
  searchMs: doc.findings.search?.likeMs ?? null,
  datesExceedSafeInteger: doc.findings.epoch?.anyExceedsSafeInteger ?? null,
  walBlind: doc.findings.open?.walBlind ?? null,
  recommendation: !opened?.db
    ? "Unanswerable without Full Disk Access. Grant it and re-run; there is no partial result for this surface."
    : decoderMandatory
      ? `A typedstream decoder is MANDATORY: ${body.blobOnly} of ${body.total} messages (${decoderShare}%) ` +
        `have an empty text column and a populated attributedBody. Budget for it before writing any tool — ` +
        `this is Notes' ZDATA surprise again, and it was found the same way.`
      : `Every message with content has it in \`text\` (${body.withText}/${body.total}). The typedstream ` +
        `decoder is an enhancement, not a prerequisite. Start with \`text\` and revisit if the ratio moves.`,
  fallbackLane: !readPathTested
    ? `NOT TESTED — ${aeLane.reason} docs/distribution.md's 'send only, no reads' remains unverified; ` +
      "re-run with Messages open before quoting this probe as evidence for it."
    : anyReadWorked
      ? "Some Apple Events reads DID answer — docs/distribution.md's 'send only, no reads' needs revising. " +
        "See the attempts table before assuming the file lane is the only option."
      : "None. Confirmed by measurement: every Apple Events read attempt failed. docs/distribution.md's " +
        "'try before you grant' promise cannot be honoured for Messages, and its README row should say so.",
};

// ─── Report ─────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Messages probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(`Search term: ${JSON.stringify(TERM)}   Messages was running: ${yn(aeLane.running)}`);
  L.push("");
  L.push("Apple Events lane (the claim: send only, no reads)");
  if (!readPathTested) {
    L.push(`  SKIPPED               ${aeLane.reason}`);
  } else {
    for (const [k, v] of Object.entries(attempts)) {
      L.push(
        `  ${k.padEnd(18)} ${v.ok ? `${String(v.ms).padStart(5)} ms  → ${v.value}` : `FAILED  ${v.error}`}`,
      );
    }
    L.push(`     ^ any read path at all: ${yn(anyReadWorked)}`);
  }
  L.push("");

  const st = doc.findings.sendTarget;
  if (st) {
    L.push("Send targeting (--send-target; resolves only, never sends)");
    if (!st.tested) {
      L.push(`  SKIPPED               ${st.reason}`);
    } else {
      L.push(`  store guid shape      ${st.storeGuidShape}`);
      for (const [k, v] of Object.entries(st.attempts)) {
        L.push(`  ${k.padEnd(20)} ${v}`);
      }
      L.push(
        `     ^ chatByStoreGuid true means a send can be addressed by a guid the file lane holds,`,
      );
      L.push(`       which is what packages/messages relies on. False means every send falls`);
      L.push(`       through to rungs that enumerate, and enumeration is what this app refuses.`);
    }
    L.push("");
  }

  L.push("File lane (Full Disk Access — mandatory for this surface)");
  L.push(`  path                  ${doc.findings.store.path}`);
  L.push(
    `  exists / readable     ${yn(doc.findings.store.exists)} / ${yn(doc.findings.store.readable)}` +
      `   (${doc.findings.store.sizeBytes ?? "?"} B, wal ${doc.findings.store.walSizeBytes ?? 0} B)`,
  );
  if (opened?.db) {
    L.push(`  opened                ${doc.findings.open.mode} in ${doc.findings.open.ms} ms`);
    if (doc.findings.open.walBlind) {
      L.push(`     ^ WAL-BLIND        mode=ro failed; counts below miss uncheckpointed traffic`);
    }
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  objects               ${doc.findings.schema.objectCount} (${doc.findings.schema.tables.length} tables)`,
    );
    const j = doc.findings.joinShape;
    L.push(
      `  join shape            message=${yn(j.message)} chat=${yn(j.chat)} handle=${yn(j.handle)} ` +
        `attachment=${yn(j.attachment)} cmj=${yn(j.chatMessageJoin)} maj=${yn(j.messageAttachmentJoin)}`,
    );
    L.push(`  message columns       ${j.messageColumns}`);
    L.push("");
    L.push("  BODY STORAGE — the blocking question");
    if (body.tested) {
      L.push(`     messages           ${body.total}`);
      L.push(`     with text          ${body.withText}`);
      L.push(`     with blob          ${body.withBlob ?? "n/a"}`);
      L.push(
        `     BLOB ONLY          ${body.blobOnly ?? "n/a"}${decoderShare === null ? "" : `  (${decoderShare}%)`}` +
          `${decoderMandatory ? "   → decoder MANDATORY" : "   → decoder optional"}`,
      );
      L.push(`     no content at all  ${body.neither ?? "n/a"}`);
      L.push(
        `     archive header     ${body.archiveHeaderAscii ?? "n/a"}  (${body.archiveHeaderHex ?? "-"})`,
      );
      if ((body.byYear ?? []).length) {
        L.push("");
        L.push("     BLOB-ONLY BY YEAR — the aggregate above hides this");
        for (const y of body.byYear) {
          const bar = "#".repeat(Math.round((y.blobOnlyPct ?? 0) / 5));
          L.push(
            `     ${y.year}  ${String(y.total).padStart(6)} msgs  ${String(y.blobOnly).padStart(6)} blob-only  ${String(y.blobOnlyPct).padStart(5)}%  ${bar}`,
          );
        }
        L.push(
          "     Apple stopped writing `text` in 2026; from then on the decoder is the only lane.",
        );
      }
      L.push(
        `     blob bytes         avg ${body.avgBlobBytes ?? "?"}, max ${body.maxBlobBytes ?? "?"}`,
      );
    } else {
      L.push(`     not tested         ${body.reason}`);
    }
    L.push("");
    L.push("  DATE EPOCHS (a wrong guess here is a silent 31-year error)");
    for (const [col, e] of Object.entries(doc.findings.epoch?.columns ?? {})) {
      L.push(
        `     ${col.padEnd(18)} ${e.tested ? `${e.epoch}${e.latestYear ? `  (latest ${e.latestYear})` : ""}` : e.reason}` +
          `${e.digits ? `  ${e.digits} digits` : ""}${e.exceedsSafeInteger ? "  EXCEEDS JS SAFE INTEGER" : ""}`,
      );
    }
    if (doc.findings.epoch?.anyExceedsSafeInteger) {
      L.push(
        `     ^ these do NOT fit in a JavaScript number. node:sqlite throws rather than truncating,`,
      );
      L.push(
        `       so the server must read them as BigInt or TEXT — a plain SELECT looks like "no dates".`,
      );
    }
    L.push("");
    L.push("DECODER — validated against the `text` column as an oracle");
    const dec = doc.findings.decoder ?? {};
    if (dec.tested) {
      L.push(
        `  blobs walked          ${dec.rows}  in ${dec.ms} ms  (${dec.msPerThousand} ms / 1000)`,
      );
      L.push(`  decoded / failed      ${dec.decoded} / ${dec.failed}   (${dec.decodeRate}%)`);
      L.push(
        `  AGREES WITH text      ${dec.exact} / ${dec.comparable}   (${dec.oracleAgreement}%)` +
          `${dec.differs ? `   ${dec.differs} DISAGREE` : ""}`,
      );
      L.push(
        `  blob-only rows        ${dec.blobOnly}  of which decoded ${dec.blobOnlyDecoded}` +
          `   <- what the column cannot answer`,
      );
      L.push(`  carry attribute runs  ${dec.withAttributes}  (not decoded, by design)`);
      L.push(`  decoded to empty      ${dec.emptyDecode}`);
      if (Object.keys(dec.failureReasons ?? {}).length) {
        L.push("  failures by reason");
        for (const [reason, n] of Object.entries(dec.failureReasons)) {
          L.push(`     ${String(n).padStart(6)}  ${reason}`);
        }
      }
      if (Object.keys(dec.classes ?? {}).length) {
        L.push(
          `  classes seen          ${Object.entries(dec.classes)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")}`,
        );
      }
      for (const f of dec.failureOutlines ?? []) {
        L.push(`  failing blob (${f.reason})`);
        L.push(`     ${f.tokens.join(" ")}`);
      }
      for (const d of dec.diffShapes ?? []) {
        L.push(
          `  disagreement          text=${d.textChars} chars, decoded=${d.decodedChars}` +
            `${d.decodedIsPrefix ? ", decoded is a PREFIX of text" : ""}` +
            `${d.textIsPrefix ? ", text is a PREFIX of decoded" : ""}`,
        );
      }
    } else {
      L.push(`  not tested            ${dec.reason}`);
    }
    L.push("");
    const s = doc.findings.search ?? {};
    L.push(
      `  LIKE search           ${s.likeMs ?? "?"} ms  (${s.hits ?? "?"} hits over ${body.total ?? "?"} rows)`,
    );
    L.push(`  fts tables            ${(s.ftsTables ?? []).join(", ") || "none"}`);
    L.push(`  message indexes       ${(s.messageIndexes ?? []).length}`);
    L.push("");
    L.push("  WHAT THE STORE BUYS (unreachable by any other lane)");
    for (const [k, v] of Object.entries(caps)) {
      L.push(
        `     ${k.padEnd(14)} ${v.present ? "PRESENT" : "absent "}  ${v.columns.join(", ") || "-"}` +
          `${v.rows === undefined ? "" : `  (${v.rows} rows)`}`,
      );
    }
    const at = doc.findings.attachments ?? {};
    L.push(
      `  attachments           ${at.rows ?? "?"} rows, ${at.resolvable ?? "?"}/${at.sampled ?? "?"} sampled files readable, ` +
        `${at.filesOnDisk ?? "?"} files on disk`,
    );
    L.push(`  services              ${JSON.stringify(doc.findings.services?.byService ?? {})}`);
    L.push("");
    const bridge = doc.findings.idBridge ?? {};
    L.push("  ID BRIDGE — can a sent message be found again?");
    if (bridge.tested) {
      L.push(`     id shape           ${bridge.idShape}`);
      L.push(`     TEXT cols scanned  ${bridge.textColumnsScanned}`);
      if (bridge.hits?.length) {
        for (const h of bridge.hits) {
          L.push(`     MATCH              ${h.table}.${h.column}  (${h.form}, ${h.rows} rows)`);
        }
      } else {
        L.push(`     NO MATCH           writes cannot be reconciled against reads`);
      }
    } else {
      L.push(`     not tested         ${bridge.reason}`);
    }
  }
  L.push("");
  L.push("VERDICT");
  L.push(`  bodies     : ${doc.verdict.recommendation}`);
  L.push(`  fallback   : ${doc.verdict.fallbackLane}`);
  if (claimsNotRunning) {
    L.push(
      `  note: Messages answered "Application isn't running" while NSRunningApplication reported it ` +
        `running. It is a windowless background process that declines to wake for a script — not a ` +
        `probe bug, and one more way this surface has no read lane.`,
    );
  }
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "messages",
    file: "chat-db.sql",
    ddlRows,
    macos: doc.macos,
    fingerprint: doc.findings.schema?.fingerprint,
    tool: "scripts/probe-chat-db.mjs",
  });
}
