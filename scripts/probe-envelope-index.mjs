#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-mail.
//
// Nobody can see Apple Mail's `Envelope Index` schema until Full Disk Access is
// granted, so every design decision that depends on it is a hypothesis until
// this script runs. It answers the open questions in one read-only pass and
// writes the answers into docs/ and test/fixtures/.
//
// It is dependency-free (node:sqlite + node:child_process only), opens the
// database read-only, and NEVER writes to it.
//
// OUTPUT IS REDACTED ON PURPOSE: DDL, counts, timings and booleans only. No
// subjects, no addresses, no bodies. Subject comparisons are reported as
// equal/not-equal plus a length. The result is safe to paste into an issue.
//
//   node scripts/probe-envelope-index.mjs            # human-readable report
//   node scripts/probe-envelope-index.mjs --json     # the raw document
//   node scripts/probe-envelope-index.mjs --write    # also write docs/ + fixtures
//
// Run it from a terminal that has Full Disk Access
// (System Settings > Privacy & Security > Full Disk Access).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = new Set(process.argv.slice(2));
const WANT_JSON = argv.has("--json");
const WANT_WRITE = argv.has("--write");

/** Sample size for the per-message cross-checks. Small on purpose: each one is an Apple Event. */
const SAMPLE = 5;

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: null,
  sqlite: null,
  findings: {},
  notes: [],
};

// ─── osascript, exactly as src/client/osascript.ts will do it ────────────────
// The script is a static constant piped to stdin; every variable input arrives
// as argv[0]. Nothing is interpolated into script text, ever.

const osascript = (script, params) => {
  const out = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", JSON.stringify(params ?? {})],
    {
      input: script,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return JSON.parse(out);
};

const ACCOUNTS_SCRIPT = `
function run(argv) {
  const M = Application("Mail");
  return JSON.stringify(M.accounts().map(function (a) {
    var dir = null;
    try { dir = String(a.accountDirectory()); } catch (e) { dir = null; }
    var caching = null;
    try { caching = String(a.messageCaching()); } catch (e) { caching = null; }
    return {
      name: a.name(),
      id: a.id(),
      enabled: a.enabled(),
      dir: dir,
      messageCaching: caching,
      mailboxes: a.mailboxes().map(function (m) { return m.name(); })
    };
  }));
}
`;

// Resolve a batch of candidate ids inside one mailbox and report what Mail says
// about them. Subjects come back so the caller can compare them; the caller
// only ever prints equal/not-equal.
const RESOLVE_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0]);
  const M = Application("Mail");
  const acct = M.accounts.byId(p.accountUuid);
  const mb = acct.mailboxes.byName(p.mailboxName);
  const out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    try {
      var m = mb.messages.byId(id);
      out.push({
        id: id,
        found: true,
        subject: m.subject(),
        dateReceived: m.dateReceived().toISOString(),
        dateSent: m.dateSent().toISOString(),
        messageId: m.messageId(),
        read: m.readStatus()
      });
    } catch (e) {
      out.push({ id: id, found: false, error: String(e.message || e) });
    }
  }
  return JSON.stringify(out);
}
`;

const COUNT_SCRIPT = `
function run(argv) {
  const p = JSON.parse(argv[0]);
  const M = Application("Mail");
  const mb = M.accounts.byId(p.accountUuid).mailboxes.byName(p.mailboxName);
  return JSON.stringify({ total: mb.messages.length, unread: mb.unreadCount() });
}
`;

// ─── helpers ─────────────────────────────────────────────────────────────────

const yn = (b) => (b ? "yes" : "no");
const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);

const CORE_DATA_EPOCH_OFFSET = 978_307_200; // 2001-01-01T00:00:00Z in Unix seconds

/** Decide the epoch from the data rather than trusting either camp of prior art. */
const detectEpoch = (maxDateReceived) => {
  if (!Number.isFinite(maxDateReceived) || maxDateReceived <= 0)
    return { offset: null, why: "no usable value" };
  const nowSec = Date.now() / 1000;
  const tenYears = 10 * 365.25 * 24 * 3600;
  const asUnix = Math.abs(nowSec - maxDateReceived);
  const asCoreData = Math.abs(nowSec - (maxDateReceived + CORE_DATA_EPOCH_OFFSET));
  if (asUnix < tenYears && asUnix <= asCoreData)
    return { offset: 0, why: "raw value lands within 10 years of now" };
  if (asCoreData < tenYears)
    return {
      offset: CORE_DATA_EPOCH_OFFSET,
      why: "value + 978307200 lands within 10 years of now",
    };
  return { offset: null, why: `neither epoch lands near now (max=${maxDateReceived})` };
};

/** The undocumented .emlx shard rule: digits of floor(id/1000), reversed, one dir each. */
const shardPath = (rowid) => {
  const bucket = Math.floor(rowid / 1000);
  return String(bucket).split("").toReversed().join("/");
};

const toUri = (path, query) =>
  `file:${encodeURI(path).replace(/\?/g, "%3f").replace(/#/g, "%23")}?${query}`;

const openRo = (path, query) => {
  const db = new DatabaseSync(toUri(path, query), { readOnly: true, allowExtension: false });
  db.exec("PRAGMA query_only = 1");
  return db;
};

const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch (err) {
    return typeof fallback === "function" ? fallback(err) : fallback;
  }
};

// ─── 1. macOS + accounts (works without Full Disk Access) ────────────────────

doc.macos = safe(
  () => execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  "unknown",
);

let accounts = [];
try {
  accounts = osascript(ACCOUNTS_SCRIPT);
} catch (err) {
  console.error("FATAL: could not talk to Mail via osascript.");
  console.error(String(err.stderr || err.message || err).trim());
  console.error("\nIf this says (-1743), grant Automation access:");
  console.error("  System Settings > Privacy & Security > Automation > <your terminal> > Mail");
  process.exit(1);
}

doc.findings.accounts = accounts.map((a) => ({
  // The account UUID is the join key to mailboxes.url, so it has to be here.
  id: a.id,
  enabled: a.enabled,
  dir: a.dir,
  messageCaching: a.messageCaching,
  mailboxCount: a.mailboxes.length,
  // Name is redacted; the shape is what matters.
  nameLength: a.name.length,
}));

// ─── 2. Locate the Mail root the way locate.ts will ──────────────────────────

const withDir = accounts.find((a) => a.dir);
const viaAccountDirectory = withDir ? dirname(withDir.dir) : null;
const mailHome = join(homedir(), "Library", "Mail");
const viaGlob = safe(
  () =>
    readdirSync(mailHome)
      .filter((d) => /^V\d+$/.test(d))
      .toSorted((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0] ?? null,
  null,
);

doc.findings.locate = {
  viaAccountDirectory,
  viaGlob: viaGlob ? join(mailHome, viaGlob) : null,
  globReadable: viaGlob !== null,
  agree: viaGlob !== null && viaAccountDirectory === join(mailHome, viaGlob),
  vNumber: viaAccountDirectory ? (viaAccountDirectory.match(/\/(V\d+)$/)?.[1] ?? null) : null,
};

if (!viaAccountDirectory) {
  console.error("FATAL: no account reported an accountDirectory. Is Mail configured?");
  process.exit(1);
}

const indexPath = join(viaAccountDirectory, "MailData", "Envelope Index");

// ─── 3. Full Disk Access + WAL ───────────────────────────────────────────────

// TCC is subtle here: statSync() SUCCEEDS on a protected path (you get the real
// size and mtime), and only open(2)/access(2) are denied. So existence and
// readability are genuinely different questions, and only the second one tells
// you whether Full Disk Access is granted.
const statOf = (p) =>
  safe(
    () => {
      const st = statSync(p);
      const readable = safe(
        () => {
          accessSync(p, constants.R_OK);
          return true;
        },
        () => false,
      );
      return { exists: true, readable, size: st.size, mtime: st.mtime.toISOString() };
    },
    (err) => ({ exists: false, readable: false, errno: err.code ?? String(err) }),
  );

const indexStat = statOf(indexPath);
doc.findings.index = {
  path: indexPath.replace(homedir(), "~"),
  ...indexStat,
  wal: statOf(`${indexPath}-wal`),
  shm: statOf(`${indexPath}-shm`),
};

if (!indexStat.exists) {
  console.error(
    `FATAL: no Envelope Index at ${indexPath} (errno ${indexStat.errno}). Has Mail ever been set up?`,
  );
  doc.findings.fullDiskAccess = "N/A";
  process.exit(2);
}

if (!indexStat.readable) {
  doc.findings.fullDiskAccess = "DENIED";
  console.error(
    [
      "Full Disk Access is not granted to this process.",
      "",
      "  System Settings > Privacy & Security > Full Disk Access",
      "  Add the binary that runs this script (Terminal, iTerm, VS Code, ...), then RESTART it.",
      "  Granting it to Mail.app does nothing — it is the *reader* that needs the permission.",
      "",
      `  path : ${indexPath.replace(homedir(), "~")}`,
      `  size : ${indexStat.size} bytes (stat is allowed; reading is not)`,
      "",
      "Everything above this line was gathered without Full Disk Access, which is",
      "exactly what the server's AppleScript lane can do on its own.",
    ].join("\n"),
  );
  if (WANT_JSON) console.log(JSON.stringify(doc, null, 2));
  process.exit(2);
}
doc.findings.fullDiskAccess = "GRANTED";

// ─── 4. Open ladder: mode=ro vs immutable=1 ──────────────────────────────────
// If these two disagree on MAX(ROWID), `immutable=1` is skipping the WAL and
// would silently serve a stale snapshot. That is the whole reason mode=ro is
// the default in the design.

let db = null;
const openReport = {};

for (const [label, query] of [
  ["ro", "mode=ro"],
  ["immutable", "immutable=1"],
]) {
  const started = performance.now();
  openReport[label] = safe(
    () => {
      const conn = openRo(indexPath, query);
      const max = conn.prepare("SELECT MAX(ROWID) AS m, COUNT(*) AS c FROM messages").get();
      const r = {
        ok: true,
        maxRowid: max.m,
        messageCount: max.c,
        ms: Math.round(performance.now() - started),
      };
      if (label === "ro") db = conn;
      else conn.close();
      return r;
    },
    (err) => ({ ok: false, error: String(err.message || err) }),
  );
}

openReport.walIsBeingSkipped =
  openReport.ro?.ok &&
  openReport.immutable?.ok &&
  openReport.ro.maxRowid !== openReport.immutable.maxRowid;
doc.findings.open = openReport;

if (!db) {
  console.error("FATAL: could not open the Envelope Index read-only.");
  console.error(JSON.stringify(openReport, null, 2));
  process.exit(3);
}

doc.sqlite = db.prepare("SELECT sqlite_version() AS v").get().v;

// ─── 5. Schema ───────────────────────────────────────────────────────────────

const ddlRows = db
  .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
  .all();
const tables = ddlRows.filter((r) => r.type === "table").map((r) => r.name);

const columnsOf = (t) =>
  safe(
    () =>
      db
        .prepare(`PRAGMA table_info("${t}")`)
        .all()
        .map((c) => c.name),
    [],
  );
const countOf = (t) => safe(() => db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c, null);

const schema = {};
for (const t of tables) schema[t] = { columns: columnsOf(t), rows: countOf(t) };

const REQUIRED = {
  messages: ["ROWID", "mailbox", "subject", "sender", "date_received", "read", "deleted"],
  mailboxes: ["ROWID", "url"],
  subjects: ["ROWID", "subject"],
  addresses: ["ROWID", "address"],
};
const missing = [];
for (const [t, cols] of Object.entries(REQUIRED)) {
  if (!schema[t]) {
    missing.push(`${t} (table)`);
    continue;
  }
  // ROWID is implicit unless WITHOUT ROWID; PRAGMA does not list it.
  for (const c of cols)
    if (c !== "ROWID" && !schema[t].columns.includes(c)) missing.push(`${t}.${c}`);
}

doc.findings.schema = {
  fingerprint: sha12(ddlRows.map((r) => r.sql).join("\n")),
  tableCount: tables.length,
  tables: schema,
  missingRequired: missing,
  has: {
    labels: tables.includes("labels"),
    recipients: tables.includes("recipients"),
    attachments: tables.includes("attachments"),
    summaries: tables.includes("summaries"),
    subjects: tables.includes("subjects"),
    addresses: tables.includes("addresses"),
    conversationColumn:
      (schema.messages?.columns ?? []).find((c) => /conversation|thread/i.test(c)) ?? null,
    flaggedColumn: (schema.messages?.columns ?? []).includes("flagged"),
    dateSentColumn: (schema.messages?.columns ?? []).includes("date_sent"),
  },
};

// ─── 6. Epoch ────────────────────────────────────────────────────────────────

const maxDates = safe(
  () => db.prepare("SELECT MAX(date_received) AS r, MAX(date_sent) AS s FROM messages").get(),
  { r: null, s: null },
);
const epoch = detectEpoch(maxDates.r);
doc.findings.epoch = {
  maxDateReceivedRaw: maxDates.r,
  detectedOffset: epoch.offset,
  why: epoch.why,
  asIso: epoch.offset === null ? null : new Date((maxDates.r + epoch.offset) * 1000).toISOString(),
};

// ─── 7. Mailbox URL shape + the account join ────────────────────────────────

const mailboxRows = safe(() => db.prepare("SELECT ROWID, url FROM mailboxes").all(), []);
const accountIds = new Set(accounts.map((a) => a.id));
const parseUrl = (url) => {
  const m = /^([a-z-]+):\/\/([^/]*)\/?(.*)$/i.exec(url ?? "");
  if (!m) return { scheme: null, host: null, path: url ?? "" };
  return { scheme: m[1], host: decodeURIComponent(m[2]), path: decodeURIComponent(m[3]) };
};
const parsedMailboxes = mailboxRows.map((r) => {
  const p = parseUrl(r.url);
  return { rowid: r.ROWID, ...p, hostIsAccountUuid: accountIds.has(p.host) };
});

doc.findings.mailboxUrls = {
  count: parsedMailboxes.length,
  schemes: [...new Set(parsedMailboxes.map((p) => p.scheme))],
  hostIsAccountUuid: {
    yes: parsedMailboxes.filter((p) => p.hostIsAccountUuid).length,
    no: parsedMailboxes.filter((p) => !p.hostIsAccountUuid).length,
  },
  // Paths are mailbox names, not user data. Kept: they drive the resolution ladder.
  samplePaths: [...new Set(parsedMailboxes.map((p) => p.path))].slice(0, 40),
};

// ─── 8. THE GO/NO-GO: does messages.ROWID equal the AppleScript message id? ──

const pickTarget = () => {
  for (const acct of accounts) {
    if (!acct.mailboxes.includes("INBOX") && !acct.mailboxes.includes("Inbox")) continue;
    const name = acct.mailboxes.includes("INBOX") ? "INBOX" : "Inbox";
    const mb = parsedMailboxes.find(
      (p) => p.host === acct.id && (p.path === name || p.path.toUpperCase() === "INBOX"),
    );
    if (mb) return { acct, mailboxName: name, mailboxRowid: mb.rowid };
  }
  return null;
};

const target = pickTarget();
doc.findings.rowidBridge = { attempted: Boolean(target) };

if (target) {
  const sampleRows = safe(
    () =>
      db
        .prepare(
          `SELECT m.ROWID AS rowid, m.date_received AS dr, m.date_sent AS ds, s.subject AS subject
             FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject
            WHERE m.mailbox = ? AND m.deleted = 0
            ORDER BY m.ROWID DESC LIMIT ?`,
        )
        .all(target.mailboxRowid, SAMPLE),
    [],
  );

  const resolved = safe(
    () =>
      osascript(RESOLVE_SCRIPT, {
        accountUuid: target.acct.id,
        mailboxName: target.mailboxName,
        ids: sampleRows.map((r) => r.rowid),
      }),
    (err) => ({ error: String(err.stderr || err.message || err).trim() }),
  );

  const comparisons = Array.isArray(resolved)
    ? sampleRows.map((row, i) => {
        const got = resolved[i] ?? {};
        const sqlSubject = row.subject ?? "";
        const asSubject = got.subject ?? "";
        const off = epoch.offset ?? 0;
        const sqlDate = row.dr ? new Date((row.dr + off) * 1000) : null;
        const asDate = got.dateReceived ? new Date(got.dateReceived) : null;
        return {
          found: Boolean(got.found),
          // Redacted: only whether they match, and how long they were.
          subjectMatches: sqlSubject === asSubject,
          subjectLengths: [sqlSubject.length, asSubject.length],
          dateDeltaSeconds:
            sqlDate && asDate ? Math.round(Math.abs(sqlDate - asDate) / 1000) : null,
        };
      })
    : [];

  const allFound = comparisons.length > 0 && comparisons.every((c) => c.found);
  const allSubjectsMatch = comparisons.every((c) => c.subjectMatches);
  const allDatesClose = comparisons.every(
    (c) => c.dateDeltaSeconds !== null && c.dateDeltaSeconds <= 1,
  );

  doc.findings.rowidBridge = {
    attempted: true,
    sampleSize: sampleRows.length,
    resolveError: Array.isArray(resolved) ? null : resolved.error,
    comparisons,
    allFound,
    allSubjectsMatch,
    allDatesClose,
    VERDICT: allFound && allSubjectsMatch,
  };

  // ─── 9. .emlx shard derivation ─────────────────────────────────────────────
  const mboxDirCandidates = [
    join(target.acct.dir, `${target.mailboxName}.mbox`),
    join(target.acct.dir, "INBOX.mbox"),
  ];
  const mboxDir = mboxDirCandidates.find((d) => existsSync(d)) ?? null;

  const emlx = { mailboxDirFound: Boolean(mboxDir), derived: [], messagesDirCount: null };
  if (mboxDir) {
    // The mailbox dir holds a per-mailbox UUID dir, then Data/<shards>/Messages.
    const inner = safe(() => readdirSync(mboxDir).filter((d) => !d.startsWith(".")), []);
    emlx.innerEntries = inner.slice(0, 10);
    for (const row of sampleRows) {
      const rel = join("Data", shardPath(row.rowid), "Messages");
      const hits = inner
        .flatMap((u) => [
          join(mboxDir, u, rel, `${row.rowid}.emlx`),
          join(mboxDir, u, rel, `${row.rowid}.partial.emlx`),
        ])
        .filter((p) => existsSync(p));
      emlx.derived.push({ rowid: row.rowid, shard: shardPath(row.rowid), hit: hits.length > 0 });
    }
    emlx.derivedHitRate = `${emlx.derived.filter((d) => d.hit).length}/${emlx.derived.length}`;
  }
  doc.findings.emlx = emlx;

  // ─── 10. Gmail: does the mailbox FK under-report? ──────────────────────────
  const gmailChecks = [];
  for (const acct of accounts) {
    const looksGmail =
      acct.mailboxes.includes("All Mail") || acct.mailboxes.some((m) => m.includes("[Gmail]"));
    if (!looksGmail) continue;
    const inboxMb = parsedMailboxes.find(
      (p) => p.host === acct.id && p.path.toUpperCase().endsWith("INBOX"),
    );
    if (!inboxMb) continue;
    const viaFk = safe(
      () =>
        db
          .prepare("SELECT COUNT(*) AS c FROM messages WHERE mailbox = ? AND deleted = 0")
          .get(inboxMb.rowid).c,
      null,
    );
    const viaLabels = doc.findings.schema.has.labels
      ? safe(
          () =>
            db
              .prepare(
                `SELECT COUNT(*) AS c FROM messages m
                  WHERE m.deleted = 0
                    AND m.ROWID IN (SELECT message_id FROM labels WHERE mailbox_id = ?)`,
              )
              .get(inboxMb.rowid).c,
          null,
        )
      : null;
    const viaAppleScript = safe(
      () => osascript(COUNT_SCRIPT, { accountUuid: acct.id, mailboxName: "INBOX" }).total,
      null,
    );
    gmailChecks.push({
      accountId: acct.id,
      mailboxRowid: inboxMb.rowid,
      viaFk,
      viaLabels,
      viaAppleScript,
    });
  }
  doc.findings.gmail = { checked: gmailChecks.length, checks: gmailChecks };
}

db.close();

// ─── Report ──────────────────────────────────────────────────────────────────

if (WANT_JSON) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const f = doc.findings;
  const lines = [
    `macOS ${doc.macos} · node ${doc.node} · sqlite ${doc.sqlite}`,
    ``,
    `LOCATE`,
    `  via accountDirectory : ${f.locate.viaAccountDirectory?.replace(homedir(), "~")}`,
    `  via V* glob          : ${f.locate.viaGlob?.replace(homedir(), "~") ?? "(unreadable without FDA)"}`,
    `  agree                : ${yn(f.locate.agree)}   V number: ${f.locate.vNumber}`,
    ``,
    `INDEX`,
    `  full disk access     : ${f.fullDiskAccess}`,
    `  size                 : ${f.index.size} bytes, mtime ${f.index.mtime}`,
    `  -wal                 : ${f.index.wal.exists ? `${f.index.wal.size} bytes` : "absent"}`,
    `  open mode=ro         : ${f.open.ro?.ok ? `${f.open.ro.messageCount} msgs, MAX(ROWID)=${f.open.ro.maxRowid} (${f.open.ro.ms} ms)` : f.open.ro?.error}`,
    `  open immutable=1     : ${f.open.immutable?.ok ? `${f.open.immutable.messageCount} msgs, MAX(ROWID)=${f.open.immutable.maxRowid}` : f.open.immutable?.error}`,
    `  immutable skips WAL  : ${yn(f.open.walIsBeingSkipped)}${f.open.walIsBeingSkipped ? "   <-- confirms mode=ro must be the default" : ""}`,
    ``,
    `SCHEMA`,
    `  fingerprint          : ${f.schema.fingerprint}`,
    `  tables               : ${f.schema.tableCount}`,
    `  missing required     : ${f.schema.missingRequired.length ? f.schema.missingRequired.join(", ") : "none"}`,
    `  labels (gmail)       : ${yn(f.schema.has.labels)}`,
    `  recipients           : ${yn(f.schema.has.recipients)}`,
    `  attachments          : ${yn(f.schema.has.attachments)}`,
    `  conversation column  : ${f.schema.has.conversationColumn ?? "none"}`,
    ``,
    `EPOCH`,
    `  max(date_received)   : ${f.epoch.maxDateReceivedRaw}`,
    `  detected offset      : ${f.epoch.detectedOffset} (${f.epoch.why})`,
    `  reads as             : ${f.epoch.asIso}`,
    ``,
    `MAILBOX URLS`,
    `  schemes              : ${f.mailboxUrls.schemes.join(", ")}`,
    `  host is account uuid : ${f.mailboxUrls.hostIsAccountUuid.yes} yes / ${f.mailboxUrls.hostIsAccountUuid.no} no`,
  ];

  if (f.rowidBridge.attempted && f.rowidBridge.comparisons) {
    const b = f.rowidBridge;
    lines.push(
      ``,
      `ROWID BRIDGE  (the go/no-go)`,
      `  sample size          : ${b.sampleSize}`,
      `  all resolved by id   : ${yn(b.allFound)}`,
      `  all subjects match   : ${yn(b.allSubjectsMatch)}`,
      `  all dates within 1s  : ${yn(b.allDatesClose)}`,
      `  ROWID_EQUALS_APPLESCRIPT_ID: ${b.VERDICT ? "TRUE  <-- proceed with the hybrid design" : "FALSE <-- fall back to Message-ID resolution"}`,
    );
    if (b.resolveError) lines.push(`  resolve error        : ${b.resolveError}`);
  }

  if (f.emlx) {
    lines.push(
      ``,
      `EMLX SHARD DERIVATION`,
      `  mailbox dir found    : ${yn(f.emlx.mailboxDirFound)}`,
      `  derived path hits    : ${f.emlx.derivedHitRate ?? "n/a"}${f.emlx.derivedHitRate && !f.emlx.derivedHitRate.startsWith("0") ? "" : "   <-- scan fallback will carry the body lane"}`,
    );
  }

  if (f.gmail?.checked) {
    lines.push(``, `GMAIL LABEL CHECK`);
    for (const c of f.gmail.checks) {
      lines.push(
        `  ${c.accountId.slice(0, 8)}  fk=${c.viaFk}  labels=${c.viaLabels ?? "n/a"}  applescript=${c.viaAppleScript}` +
          (c.viaFk === 0 && c.viaAppleScript > 0
            ? "   <-- confirms the labels join is mandatory"
            : ""),
      );
    }
  }

  lines.push(
    ``,
    `Re-run with --json for the full document, --write to update docs/ and test/fixtures/.`,
  );
  console.log(lines.join("\n"));
}

if (WANT_WRITE) {
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  mkdirSync(join(ROOT, "test", "fixtures"), { recursive: true });

  const ddlSql = [
    `-- Captured from a real Envelope Index by scripts/probe-envelope-index.mjs.`,
    `-- macOS ${doc.macos}, Mail ${doc.findings.locate.vNumber}, fingerprint ${doc.findings.schema.fingerprint}.`,
    `-- Schema only. No data.`,
    ``,
    ...ddlRows.map((r) => `${r.sql};`),
  ].join("\n");
  writeFileSync(join(ROOT, "test", "fixtures", "envelope-index.sql"), `${ddlSql}\n`);

  const md = [
    `# Envelope Index — observed schema`,
    ``,
    `Regenerate with \`node scripts/probe-envelope-index.mjs --write\` on each new macOS release.`,
    `Output is redacted: DDL, counts and booleans only.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| macOS | ${doc.macos} |`,
    `| Mail data version | ${doc.findings.locate.vNumber} |`,
    `| Schema fingerprint | \`${doc.findings.schema.fingerprint}\` |`,
    `| SQLite | ${doc.sqlite} |`,
    `| Epoch offset | ${doc.findings.epoch.detectedOffset} |`,
    `| \`labels\` table | ${doc.findings.schema.has.labels} |`,
    `| ROWID == AppleScript id | ${doc.findings.rowidBridge.VERDICT ?? "not tested"} |`,
    `| immutable=1 skips WAL | ${doc.findings.open.walIsBeingSkipped} |`,
    ``,
    `## Full document`,
    ``,
    "```json",
    JSON.stringify(doc, null, 2),
    "```",
  ].join("\n");
  writeFileSync(join(ROOT, "docs", "envelope-index.md"), `${md}\n`);

  console.log(`\nwrote docs/envelope-index.md and test/fixtures/envelope-index.sql`);
}
