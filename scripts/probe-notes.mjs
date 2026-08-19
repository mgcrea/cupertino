#!/usr/bin/env node
// Phase 0 spike for a future @mgcrea/mcp-apple-notes.
//
// This answers one decisive question before any code is written:
//
//     DOES NOTES NEED FULL DISK ACCESS AT ALL?
//
// Mail needed it because Apple Events search was unusable — 74 s for
// `messages whose read status is false` over 51k messages — so search had to go
// to the SQLite index, which dragged in the launcher, the disclaim SPI and the
// whole permission story. Notes libraries are usually two orders of magnitude
// smaller, and unlike Mail the scripting dictionary already exposes `plaintext`
// read-only and `body` read-write. If the Apple Events lane is fast enough here,
// the Notes server needs Automation only: no Full Disk Access, no SQLite, no
// protobuf, no launcher.
//
// So THE APPLE EVENTS HALF RUNS WITHOUT FULL DISK ACCESS. Run it as-is first;
// only bother granting FDA if the verdict says the file lane is needed.
//
// Dependency-free (node:sqlite + node:child_process). The database is opened
// read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, booleans and DDL
// only. No note titles, no bodies, no folder names. Safe to paste into an issue.
//
//   node scripts/probe-notes.mjs                 # human-readable report
//   node scripts/probe-notes.mjs --json          # the raw document
//   node scripts/probe-notes.mjs --term=invoice  # word for the search timing
//   node scripts/probe-notes.mjs --launch        # allow launching Notes.app
//   node scripts/probe-notes.mjs --write         # also write the schema fixture
//
// Notes must be running, or pass --launch. Launching it is the same objection
// the read tools make for Mail: it steals focus.
//
// `--write` additionally needs Full Disk Access, and emits
// test/fixtures/note-store.sql — the DDL the index lane's offline tests build
// their database from, exactly as test/fixtures/envelope-index.sql does for
// Mail. It answers the question that gates the whole index lane: whether search
// can read an indexed title/snippet column, or has to decode ZICNOTEDATA.ZDATA.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { extractNoteText } from "./lib/note-protobuf.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const WANT_JSON = has("--json");
const ALLOW_LAUNCH = has("--launch");
const WANT_WRITE = has("--write");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERM = (argv.find((a) => a.startsWith("--term=")) ?? "--term=the").slice(7);

/** Sample size for per-note reads. Small on purpose: each one is an Apple Event. */
const SAMPLE = 5;
/** Core Data stores seconds since 2001-01-01. */
const APPLE_EPOCH_OFFSET = 978_307_200;
/**
 * Notes uses U+2028 for soft breaks where Apple Events renders a newline, so
 * compare on a normalised form rather than reading a line-ending convention as
 * a decoder bug.
 */
const norm = (t) => t.replaceAll(/\r\n?/g, "\n").replaceAll("\u2028", "\n").trim();

/** Core Data spells strings VARCHAR; LENGTH() on an INTEGER lies, so check the type. */
const isTextType = (t) => /CHAR|CLOB|TEXT/i.test(String(t ?? ""));

/** Render a hex magic as printable ASCII, so `bplist` is legible as itself. */
const ascii = (hex) =>
  (hex.match(/../g) ?? [])
    .map((h) => Number.parseInt(h, 16))
    .map((n) => (n >= 32 && n < 127 ? String.fromCharCode(n) : "."))
    .join("");

/** Notes shipped in 2011; anything outside this means the offset guess is wrong. */
const sane = (d) => d.getFullYear() >= 2007 && d.getFullYear() <= 2100;

const STORE = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.com.apple.notes",
  "NoteStore.sqlite",
);

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: null,
  sqlite: null,
  searchTerm: TERM,
  findings: {},
  verdict: {},
  notes: [],
};

const safe = (fn, onErr) => {
  try {
    return fn();
  } catch (err) {
    return onErr ? onErr(err) : { ok: false, error: String(err?.message ?? err) };
  }
};

// ─── osascript, exactly as src/client/osascript.ts does it ───────────────────
// The script is a static constant piped to stdin; every variable input arrives
// as argv[0]. Nothing is interpolated into script text, ever.

const osascript = (script, params, timeout = 180_000) => {
  const out = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", JSON.stringify(params ?? {})],
    { input: script, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
};

/** Time an Apple Event round trip. A timeout is itself an answer, so record it. */
const timed = (label, script, params, timeout) => {
  const started = performance.now();
  try {
    const data = osascript(script, params, timeout);
    return { ok: true, ms: Math.round(performance.now() - started), ...data };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      timedOut: String(err?.message ?? err).includes("ETIMEDOUT") || err?.killed === true,
      error: String(err?.message ?? err).slice(0, 300),
      label,
    };
  }
};

const IS_RUNNING = `
function run(argv) {
  ObjC.import("AppKit");
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Notes");
  return JSON.stringify({ running: apps.count > 0 });
}
`;

/** Shape of the library: accounts, the folder tree and its depth, note counts. */
const SHAPE = `
function run(argv) {
  var N = Application("Notes");
  function depth(f, d) {
    var worst = d;
    var subs = [];
    try { subs = f.folders(); } catch (e) { return worst; }
    for (var i = 0; i < subs.length; i++) {
      var got = depth(subs[i], d + 1);
      if (got > worst) worst = got;
    }
    return worst;
  }
  var accounts = N.accounts();
  var out = [];
  var maxDepth = 0;
  for (var a = 0; a < accounts.length; a++) {
    var acc = accounts[a];
    var tops = [];
    try { tops = acc.folders(); } catch (e) { tops = []; }
    for (var t = 0; t < tops.length; t++) {
      var d = depth(tops[t], 1);
      if (d > maxDepth) maxDepth = d;
    }
    out.push({
      nameLength: String(acc.name()).length,
      idLength: String(acc.id()).length,
      topLevelFolders: tops.length
    });
  }
  return JSON.stringify({
    accountCount: accounts.length,
    accounts: out,
    maxFolderDepth: maxDepth,
    noteCount: N.notes().length
  });
}
`;

/** Bulk property fetch — one Apple Event returning an array, the fast pattern. */
const BULK_IDS = `
function run(argv) {
  var N = Application("Notes");
  var ids = N.notes.id();
  var mods = N.notes.modificationDate();
  return JSON.stringify({ count: ids.length, modCount: mods.length,
                          idSample: ids.length ? String(ids[0]) : null });
}
`;

/** The Mail-killer query, asked of Notes. This is the number that decides it. */
const WHOSE_SEARCH = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var N = Application("Notes");
  var hits = N.notes.whose({ plaintext: { _contains: p.term } })();
  return JSON.stringify({ hits: hits.length });
}
`;

/**
 * The alternative to `whose`: pull every plaintext in one Apple Event and filter
 * in JS. If `whose` is slow but this is not, search needs no file lane — it just
 * needs a different query strategy. Measuring both is the point.
 */
const BULK_SCAN = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var N = Application("Notes");
  var texts = N.notes.plaintext();
  var needle = String(p.term).toLowerCase();
  var hits = 0, bytes = 0;
  for (var i = 0; i < texts.length; i++) {
    var t = String(texts[i] === null ? "" : texts[i]);
    bytes += t.length;
    if (t.toLowerCase().indexOf(needle) !== -1) hits++;
  }
  return JSON.stringify({ hits: hits, scanned: texts.length, totalChars: bytes });
}
`;

/**
 * Every note's id and plaintext in one round trip. Used only to CHECK the ZDATA
 * decoder against the authority — Apple Events is what the user sees, so if the
 * decoder disagrees with it, the decoder is wrong.
 */
const ALL_PLAINTEXT = `
function run(argv) {
  var N = Application("Notes");
  return JSON.stringify({ ids: N.notes.id(), texts: N.notes.plaintext() });
}
`;

/** Per-note plaintext reads, and how password-protected notes behave. */
const SAMPLE_BODIES = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var N = Application("Notes");
  var all = N.notes();
  var out = [];
  var locked = 0;
  var lockedReadable = null;
  for (var i = 0; i < all.length && out.length < p.sample; i++) {
    var n = all[i];
    var prot = false;
    try { prot = n.passwordProtected(); } catch (e) { prot = false; }
    if (prot) {
      locked++;
      if (lockedReadable === null) {
        try { lockedReadable = String(n.plaintext()).length > 0; }
        catch (e) { lockedReadable = false; }
      }
      continue;
    }
    var plainLen = null, bodyLen = null, err = null;
    try { plainLen = String(n.plaintext()).length; } catch (e) { err = String(e); }
    try { bodyLen = String(n.body()).length; } catch (e) { err = String(e); }
    out.push({ plaintextLength: plainLen, bodyLength: bodyLen, error: err });
  }
  // Bulk array fetch, not a per-note loop: the README measures the loop form at
  // ~250 ms per item, which would take minutes on a real library.
  var lockedTotal = null;
  try {
    var flags = N.notes.passwordProtected();
    lockedTotal = 0;
    for (var j = 0; j < flags.length; j++) if (flags[j]) lockedTotal++;
  } catch (e) { lockedTotal = null; }
  return JSON.stringify({ sampled: out, lockedInSample: locked,
                          lockedTotal: lockedTotal, lockedPlaintextReadable: lockedReadable });
}
`;

// ─── macOS + preconditions ──────────────────────────────────────────────────

doc.macos = safe(
  () => execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  () => null,
);

const running = safe(
  () => osascript(IS_RUNNING, {}, 10_000),
  () => ({ running: false }),
);
if (!running.running && !ALLOW_LAUNCH) {
  console.error(
    "Notes is not running.\n\n" +
      "Open Notes and re-run, or pass --launch to let this script start it.\n" +
      "Launching is not the default for the same reason the Mail read tools refuse to:\n" +
      "it steals focus and kicks off a sync.",
  );
  process.exit(2);
}
doc.findings.notesWasRunning = running.running;

// ─── Lane 1: Apple Events. This half needs Automation only. ─────────────────

doc.findings.shape = timed("shape", SHAPE, {}, 120_000);
doc.findings.bulkIds = timed("bulkIds", BULK_IDS, {}, 180_000);
doc.findings.whoseSearch = timed("whoseSearch", WHOSE_SEARCH, { term: TERM }, 300_000);
doc.findings.bulkScan = timed("bulkScan", BULK_SCAN, { term: TERM }, 300_000);
doc.findings.bodies = timed("bodies", SAMPLE_BODIES, { sample: SAMPLE }, 120_000);

const noteCount = doc.findings.shape.noteCount ?? null;
const whoseMs = doc.findings.whoseSearch.ok ? doc.findings.whoseSearch.ms : null;
const scanMs = doc.findings.bulkScan.ok ? doc.findings.bulkScan.ms : null;
// Whichever strategy is cheaper is the one a real server would use, so the
// verdict is about the best available Apple Events path, not about `whose`.
const candidates = [whoseMs, scanMs].filter((n) => n !== null);
const searchMs = candidates.length ? Math.min(...candidates) : null;
const searchVia = searchMs === null ? null : searchMs === whoseMs ? "whose" : "bulk scan";
const bulkMs = doc.findings.bulkIds.ok ? doc.findings.bulkIds.ms : null;

// ─── Lane 2: the file lane. Needs Full Disk Access; degrades cleanly. ───────
// stat() succeeds on a TCC-protected file and only open/access are denied, so
// existence and readability are different questions. Only readability answers
// whether FDA is granted. (Same lesson as src/client/locate.ts.)

const fileFacts = safe(
  () => {
    const st = statSync(STORE);
    let readable = false;
    try {
      accessSync(STORE, constants.R_OK);
      readable = true;
    } catch {
      readable = false;
    }
    let walSize = null;
    try {
      walSize = statSync(`${STORE}-wal`).size;
    } catch {
      walSize = null;
    }
    return { exists: true, readable, sizeBytes: st.size, walSizeBytes: walSize };
  },
  () => ({ exists: false, readable: false, sizeBytes: null, walSizeBytes: null }),
);
doc.findings.store = { path: STORE, ...fileFacts };

/** Captured DDL, kept for --write. Null until the file lane runs. */
let ddlRows = null;

if (fileFacts.readable) {
  const started = performance.now();
  const db = new DatabaseSync(`file:${encodeURI(STORE)}?mode=ro`, {
    readOnly: true,
    allowExtension: false,
  });
  db.exec("PRAGMA query_only = 1");
  doc.sqlite = safe(
    () => db.prepare("SELECT sqlite_version() AS v").get().v,
    () => null,
  );
  doc.findings.open = { ms: Math.round(performance.now() - started) };

  // Order matters: sqlite_master's natural "type, name" ordering puts every
  // CREATE INDEX before the tables it indexes, which makes the dump unreplayable.
  // Emit tables first, then indexes, then triggers and views.
  ddlRows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
    )
    .all()
    // sqlite_sequence is created implicitly by AUTOINCREMENT and cannot be declared.
    .filter((r) => r.name !== "sqlite_sequence");
  const ddl = ddlRows;
  doc.findings.schema = {
    objectCount: ddl.length,
    tables: ddl.filter((r) => r.type === "table").map((r) => r.name),
    fingerprint: createHash("sha256")
      .update(ddl.map((r) => r.sql).join("\n"))
      .digest("hex")
      .slice(0, 12),
  };

  const countOf = (t) =>
    safe(
      () => db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c,
      () => null,
    );
  doc.findings.counts = Object.fromEntries(
    ["ZICCLOUDSYNCINGOBJECT", "ZICNOTEDATA", "ZICATTACHMENT"]
      .filter((t) => doc.findings.schema.tables.includes(t))
      .map((t) => [t, countOf(t)]),
  );

  /** Declared type matters: LENGTH() on an INTEGER returns its digit count, so
   *  a name-based filter happily reports a version number as a 1-char "title". */
  const columnInfo = (t) =>
    safe(
      () => db.prepare(`PRAGMA table_info("${t}")`).all(),
      () => [],
    );
  /**
   * Q3 first, because everything else has to be scoped by it. Core Data packs
   * every entity into ZICCLOUDSYNCINGOBJECT, so a note row must be told apart
   * from a folder, an account and an attachment before any column is counted.
   */
  doc.findings.entities = safe(() => {
    const rows = db.prepare("SELECT Z_ENT, Z_NAME, Z_SUPER FROM Z_PRIMARYKEY ORDER BY Z_ENT").all();
    const byName = Object.fromEntries(rows.map((r) => [r.Z_NAME, r.Z_ENT]));
    const counts = safe(
      () =>
        Object.fromEntries(
          db
            .prepare("SELECT Z_ENT, COUNT(*) AS c FROM ZICCLOUDSYNCINGOBJECT GROUP BY Z_ENT")
            .all()
            .map((r) => [rows.find((e) => e.Z_ENT === r.Z_ENT)?.Z_NAME ?? `Z_ENT ${r.Z_ENT}`, r.c]),
        ),
      () => null,
    );
    const cols = columnInfo("ZICCLOUDSYNCINGOBJECT").map((c) => c.name);
    const deletionCols = cols.filter((c) => /DELET|TRASH|PENDINGREMOVAL/i.test(c));
    const noteEnt = byName.ICNote ?? null;
    const where = deletionCols.map((c) => ` AND ("${c}" IS NULL OR "${c}" = 0)`).join("");
    const scoped = (extra) =>
      noteEnt === null
        ? null
        : safe(
            () =>
              db
                .prepare(`SELECT COUNT(*) AS c FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?${extra}`)
                .get(noteEnt).c,
            () => null,
          );
    return {
      names: rows.map((r) => r.Z_NAME),
      countsByEntity: counts,
      noteEnt,
      deletionCols,
      allNotes: scoped(""),
      liveNotes: scoped(where),
      // Apple Events is the authority on what a user considers a note. A gap
      // here means the Z_ENT filter alone is not the right definition.
      appleEventsNoteCount: noteCount,
    };
  });

  const noteEnt = doc.findings.entities?.noteEnt ?? null;

  /**
   * Q1, the gate for the whole index lane. Two things a looser check gets wrong:
   * only TEXT-typed columns count, and every count is scoped to note rows —
   * ZTITLE spans folders and accounts too, so its raw row count is meaningless.
   *
   * The objective test for FULL TEXT is total characters. Apple Events already
   * told us the library holds `bulkScan.totalChars`; a column carrying the real
   * body will be close to that, a preview column will be far below it.
   */
  doc.findings.searchColumns = safe(() => {
    const info = columnInfo("ZICCLOUDSYNCINGOBJECT");
    const textCols = info.filter((c) => isTextType(c.type)).map((c) => c.name);
    const trueTotal = doc.findings.bulkScan?.totalChars ?? null;
    const stats = {};
    for (const c of textCols) {
      const row = safe(
        () =>
          db
            .prepare(
              `SELECT COUNT("${c}") AS rows, SUM(LENGTH("${c}")) AS chars,
                      CAST(AVG(LENGTH("${c}")) AS INT) AS avgLength
               FROM ZICCLOUDSYNCINGOBJECT
               WHERE Z_ENT = ? AND "${c}" IS NOT NULL AND "${c}" != ''`,
            )
            .get(noteEnt),
        () => null,
      );
      if (!row?.rows) continue;
      stats[c] = {
        ...row,
        coverage: noteCount ? Number((row.rows / noteCount).toFixed(3)) : null,
        // >0.9 means this column plausibly holds the whole body, not a preview.
        charRatio: trueTotal ? Number((row.chars / trueTotal).toFixed(3)) : null,
      };
    }
    return { textColumnCount: textCols.length, trueTotalChars: trueTotal, stats };
  });

  /**
   * Q1b. What ZDATA actually is, over several rows — the first row is not
   * evidence. Report hex, because the interesting case is a MIXED store where
   * some rows are one format and some another.
   */
  doc.findings.zdata = safe(
    () => {
      const rows = db
        .prepare("SELECT ZDATA AS d FROM ZICNOTEDATA WHERE ZDATA IS NOT NULL LIMIT 24")
        .all();
      if (!rows.length) return { sampled: 0 };
      const seen = {};
      let gunzipOk = 0;
      let inner = null;
      for (const r of rows) {
        const b = Buffer.from(r.d);
        const magic = b.subarray(0, 8).toString("hex");
        seen[magic] = (seen[magic] ?? 0) + 1;
        if (b[0] === 0x1f && b[1] === 0x8b) {
          const out = safe(
            () => gunzipSync(b),
            () => null,
          );
          if (out) {
            gunzipOk++;
            inner ??= `${out.subarray(0, 8).toString("hex")} (${ascii(out.subarray(0, 8).toString("hex"))})`;
          }
        }
      }
      const magics = Object.keys(seen);
      return {
        sampled: rows.length,
        formats: magics.map((m) => ({ hex: m, ascii: ascii(m), rows: seen[m] })),
        uniform: magics.length === 1,
        allGzipped: magics.every((m) => m.startsWith("1f8b")),
        allBplist: magics.every((m) => ascii(m).startsWith("bplist")),
        gunzipSucceeded: gunzipOk,
        innerMagicAfterGunzip: inner,
      };
    },
    (e) => ({ sampled: 0, error: String(e.message ?? e) }),
  );

  /**
   * Q2. There is no ZICATTACHMENT table — attachments are entities inside
   * ZICCLOUDSYNCINGOBJECT like everything else, so look them up by name.
   */
  doc.findings.attachments = safe(() => {
    const names = doc.findings.entities?.names ?? [];
    const attachEntities = names.filter((n) => /attachment|media/i.test(n));
    const info = columnInfo("ZICCLOUDSYNCINGOBJECT");
    const pathish = info
      .filter((c) => /FILENAME|FILEPATH|IDENTIFIER|MEDIA|URL/i.test(c.name) && isTextType(c.type))
      .map((c) => c.name);
    const counts = doc.findings.entities?.countsByEntity ?? {};
    const accountsDir = join(dirname(STORE), "Accounts");
    return {
      attachEntities: Object.fromEntries(attachEntities.map((n) => [n, counts[n] ?? 0])),
      pathCandidates: pathish,
      accountsDirPath: accountsDir,
      accountsDirReadable: safe(
        () => {
          accessSync(accountsDir, constants.R_OK);
          return true;
        },
        () => false,
      ),
    };
  });

  /**
   * Q1c. Can the gzipped protobuf actually be decoded into the note body?
   *
   * The decoder guesses structurally rather than from a compiled .proto, so it
   * has to be proven, not asserted — and there is a perfect oracle available:
   * Apple Events already returns the same note's plaintext. Agreement across a
   * sample is what makes an index full-text lane defensible.
   *
   * Redaction holds: text is compared in memory, only counts and offsets print.
   */
  // One round trip, shared by the decoder check and the predicate check below.
  const truth = timed("allPlaintext", ALL_PLAINTEXT, {}, 300_000);
  const prefix = /^(.*)\/p\d+$/.exec(doc.findings.bulkIds?.idSample ?? "")?.[1] ?? null;
  /** The Z_PKs Apple Events considers notes - the authority for the predicate. */
  const truthPks = new Set(
    (truth.ids ?? [])
      .map((id) => Number(/\/p(\d+)$/.exec(String(id))?.[1]))
      .filter((n) => Number.isInteger(n)),
  );

  /**
   * Q3, settled properly. ZTITLE1 being non-null on exactly 921 rows is
   * suggestive, but a matching COUNT is not a matching SET - the longest-string
   * decoder also had the right count and the wrong answer. So compare the Z_PK
   * sets and report what each candidate predicate misses or adds.
   */
  doc.findings.notePredicate = safe(() => {
    if (!truthPks.size) return { tested: false, reason: "no Apple Events ids to compare against" };
    const cols = columnInfo("ZICCLOUDSYNCINGOBJECT").map((c) => c.name);
    const hasTitle = cols.includes("ZTITLE1");
    const notDeleted = (doc.findings.entities?.deletionCols ?? [])
      .map((c) => ` AND ("${c}" IS NULL OR "${c}" = 0)`)
      .join("");
    const predicates = [
      { name: "Z_ENT only", extra: "" },
      { name: "Z_ENT + not deleted", extra: notDeleted },
    ];
    if (hasTitle) {
      predicates.push(
        { name: "Z_ENT + ZTITLE1 NOT NULL", extra: " AND ZTITLE1 IS NOT NULL" },
        {
          name: "Z_ENT + ZTITLE1 NOT NULL + not deleted",
          extra: ` AND ZTITLE1 IS NOT NULL${notDeleted}`,
        },
      );
    }
    return predicates.map((c) => {
      const pks = safe(
        () =>
          new Set(
            db
              .prepare(`SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = ?${c.extra}`)
              .all(noteEnt)
              .map((r) => r.Z_PK),
          ),
        () => null,
      );
      if (!pks) return { name: c.name, error: true };
      let missing = 0;
      for (const pk of truthPks) if (!pks.has(pk)) missing += 1;
      let extra = 0;
      for (const pk of pks) if (!truthPks.has(pk)) extra += 1;
      return { name: c.name, rows: pks.size, missing, extra, exact: missing === 0 && extra === 0 };
    });
  });

  doc.findings.zdataDecode = safe(() => {
    if (!truth.ok)
      return { attempted: false, reason: "could not read plaintext over Apple Events" };
    const byId = new Map(
      (truth.ids ?? []).map((id, i) => [String(id), String(truth.texts?.[i] ?? "")]),
    );
    if (!prefix) return { attempted: false, reason: "no id sample to derive the Core Data prefix" };

    const rows = db
      .prepare(
        `SELECT ZNOTE AS pk, ZDATA AS blob, ZCRYPTOTAG AS tag
         FROM ZICNOTEDATA WHERE ZDATA IS NOT NULL AND ZNOTE IS NOT NULL LIMIT 60`,
      )
      .all();

    let encrypted = 0;
    let notGzip = 0;
    let noCounterpart = 0;
    let decoded = 0;
    // Both strategies are scored on the same notes, because the pin is only
    // worth having if it beats the heuristic on real data.
    const score = { pinned: 0, longest: 0 };
    const paths = {};
    const viaCounts = {};
    const deltas = [];

    for (const r of rows) {
      if (r.tag) {
        encrypted += 1;
        continue;
      }
      const buf = Buffer.from(r.blob);
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
        notGzip += 1;
        continue;
      }
      const plain = byId.get(`${prefix}/p${r.pk}`);
      if (plain === undefined) {
        noCounterpart += 1;
        continue;
      }
      const inflated = safe(
        () => gunzipSync(buf),
        () => null,
      );
      if (!inflated) continue;

      const pinned = extractNoteText(inflated);
      const longest = extractNoteText(inflated, { preferPath: null });
      if (pinned.text === null) continue;
      decoded += 1;
      paths[pinned.path] = (paths[pinned.path] ?? 0) + 1;
      viaCounts[pinned.via] = (viaCounts[pinned.via] ?? 0) + 1;

      const truthNorm = norm(plain);
      if (norm(pinned.text) === truthNorm) score.pinned += 1;
      else deltas.push(norm(pinned.text).length - truthNorm.length);
      if (longest.text !== null && norm(longest.text) === truthNorm) score.longest += 1;
    }

    return {
      attempted: true,
      sampled: rows.length,
      encrypted,
      notGzip,
      noCounterpart,
      decoded,
      agreePinned: score.pinned,
      agreeLongest: score.longest,
      agreementRate: decoded ? Number((score.pinned / decoded).toFixed(3)) : null,
      longestRate: decoded ? Number((score.longest / decoded).toFixed(3)) : null,
      // Which field path held the body, and how it was reached. Learned, not assumed.
      paths,
      via: viaCounts,
      lengthDeltas: deltas.slice(0, 5),
    };
  });

  // Does the AppleScript id bridge to a primary key, the way Mail's ROWID did?
  // Notes ids look like x-coredata://<uuid>/ICNote/p<N>; test whether p<N> is Z_PK.
  doc.findings.idBridge = safe(
    () => {
      const sample = doc.findings.bulkIds.idSample;
      const m = /\/p(\d+)$/.exec(sample ?? "");
      if (!m) return { tested: false, reason: "no id sample from Apple Events" };
      const pk = Number(m[1]);
      const row = db
        .prepare("SELECT Z_PK, Z_ENT FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?")
        .get(pk);
      return { tested: true, pk, foundRow: Boolean(row), zEnt: row?.Z_ENT ?? null };
    },
    (e) => ({ tested: false, error: String(e.message ?? e) }),
  );

  doc.findings.epoch = safe(
    () => {
      const row = db
        .prepare(
          "SELECT MAX(ZMODIFICATIONDATE1) AS m FROM ZICCLOUDSYNCINGOBJECT WHERE ZMODIFICATIONDATE1 IS NOT NULL",
        )
        .get();
      if (!row?.m) return { tested: false };
      const asApple = new Date((row.m + APPLE_EPOCH_OFFSET) * 1000);
      const asUnix = new Date(row.m * 1000);
      return {
        tested: true,
        detectedOffset: sane(asApple) ? APPLE_EPOCH_OFFSET : sane(asUnix) ? 0 : "unknown",
      };
    },
    (e) => ({ tested: false, error: String(e.message ?? e) }),
  );

  db.close();
} else {
  doc.notes.push(
    fileFacts.exists
      ? "NoteStore.sqlite exists but is not readable — Full Disk Access is not granted to this " +
          "terminal. The Apple Events half above still ran, and it is the half that decides."
      : "NoteStore.sqlite not found. Has Notes ever been set up on this account?",
  );
}

// ─── Verdict ────────────────────────────────────────────────────────────────
// The threshold: search is the only thing that forced Mail onto the file lane.
// If Notes answers a full-text `whose` query in a couple of seconds, an
// Automation-only server is viable and the whole FDA apparatus is unnecessary.

const SEARCH_BUDGET_MS = 3_000;

// The Apple Events lane has no index, so every search pays the full cost again.
// That is fine on a small library and is exactly the wall Mail hit on a large
// one, so project this library's measured rate onto bigger ones rather than
// generalising from whatever size happens to be here.
const projection =
  searchMs !== null && noteCount
    ? [5_000, 10_000, 20_000, 50_000].map((n) => ({
        notes: n,
        projectedMs: Math.round((searchMs / noteCount) * n),
      }))
    : null;
/**
 * The phase-0 gate. Two questions hide behind "can the index search": titles,
 * and full text. A store can answer the first and not the second — that is
 * exactly what a preview column looks like.
 *
 * `coverage` is rows-with-text over notes; `charRatio` is total characters over
 * the total Apple Events actually returned. A real body column approaches 1 on
 * both. A snippet has good coverage and a tiny charRatio.
 */
const colStats = doc.findings.searchColumns?.stats ?? {};
const ranked = Object.entries(colStats)
  .map(([column, v]) => ({ column, ...v }))
  .toSorted((a, b) => (b.charRatio ?? 0) - (a.charRatio ?? 0));
const fullTextCol = ranked.find((c) => (c.charRatio ?? 0) >= 0.9) ?? null;
/**
 * Identifiers are TEXT, sit on every row, and are never what anyone means by
 * "title" — without excluding them a UUID column wins on coverage. Coverage
 * above 1.0 is itself a tell: the column spans rows Apple Events does not call
 * notes, so the closest fit to exactly 1.0 is the one we want.
 */
const IDENTIFIERISH = /IDENTIFIER|UUID|HASH|URL|TOKEN|DEVICE|ZONE/i;
const namedCols = ranked.filter((c) => !IDENTIFIERISH.test(c.column) && (c.coverage ?? 0) >= 0.5);
const titleCol =
  namedCols.toSorted(
    (a, b) => Math.abs((a.coverage ?? 0) - 1) - Math.abs((b.coverage ?? 0) - 1),
  )[0] ?? null;
const bestSnippet = namedCols.filter((c) => c !== titleCol)[0] ?? null;

const indexLane = !fileFacts.readable
  ? { answered: false, reason: "Full Disk Access not granted — re-run with it to settle this." }
  : {
      answered: true,
      fullTextColumn: fullTextCol?.column ?? null,
      titleColumn: titleCol?.column ?? null,
      snippetColumn: bestSnippet?.column ?? null,
      needsBlobDecode: !fullTextCol,
      recommendation: fullTextCol
        ? `${fullTextCol.column} holds ${Math.round((fullTextCol.charRatio ?? 0) * 100)}% of the library's characters — index full-text search is viable and ZDATA never has to be opened.`
        : (doc.findings.zdataDecode?.agreementRate ?? 0) >= 0.99
          ? `Full text is not in a column, but the ZDATA decoder agrees with Apple Events on ` +
            `${doc.findings.zdataDecode.agreePinned}/${doc.findings.zdataDecode.decoded} notes ` +
            `at path ${Object.keys(doc.findings.zdataDecode.paths ?? {}).join(", ")}. ` +
            `Index full-text search is viable: title from ${titleCol?.column ?? "?"}, body from ZDATA.`
          : `No column holds the full body. Title: ${titleCol?.column ?? "none"} (${Math.round((titleCol?.coverage ?? 0) * 100)}% of notes)` +
            (bestSnippet ? `, snippet ${bestSnippet.column} ~${bestSnippet.avgLength}ch` : "") +
            `. The index filters and ranks by title. FULL TEXT lives in ZDATA, which is ` +
            `${(doc.findings.zdata?.formats ?? []).map((f) => `${f.rows}x ${f.ascii}`).join(", ")}` +
            `${doc.findings.zdata?.gunzipSucceeded ? `, ${doc.findings.zdata.gunzipSucceeded} of which gunzip to ${doc.findings.zdata.innerMagicAfterGunzip}` : ""}` +
            ". So either decode it, or take the fallback: index for filtering, Apple Events for body.",
    };
doc.verdict = {
  indexLane,
  noteCount,
  appleEventsSearchMs: searchMs,
  appleEventsSearchVia: searchVia,
  whoseMs,
  bulkScanMs: scanMs,
  appleEventsBulkMs: bulkMs,
  searchBudgetMs: SEARCH_BUDGET_MS,
  fullDiskAccessGranted: fileFacts.readable,
  msPerNote: searchMs !== null && noteCount ? Number((searchMs / noteCount).toFixed(4)) : null,
  projection,
  needsFileLane:
    searchMs === null
      ? "unknown — the search query failed or timed out"
      : searchMs > SEARCH_BUDGET_MS,
  recommendation:
    searchMs === null
      ? "Apple Events search did not complete. Treat the file lane as required until it does."
      : searchMs > SEARCH_BUDGET_MS
        ? `Best Apple Events search took ${searchMs} ms over ${noteCount} notes (${searchVia}). Too slow — Notes needs the index lane, same as Mail.`
        : `Apple Events search took ${searchMs} ms over ${noteCount} notes via ${searchVia}. Fast enough — an Automation-only Notes server is viable, with no Full Disk Access at all.`,
};

// ─── Report ─────────────────────────────────────────────────────────────────

if (WANT_JSON) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Notes probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(
    `Search term: ${JSON.stringify(TERM)}   Notes was running: ${doc.findings.notesWasRunning}`,
  );
  L.push("");
  L.push("Apple Events lane (Automation only)");
  L.push(`  accounts              ${doc.findings.shape.accountCount ?? "?"}`);
  L.push(`  notes                 ${noteCount ?? "?"}`);
  L.push(`  max folder depth      ${doc.findings.shape.maxFolderDepth ?? "?"}`);
  L.push(`  bulk id+date fetch    ${bulkMs ?? "failed"} ms`);
  L.push(
    `  whose plaintext       ${whoseMs ?? "failed"} ms  (${doc.findings.whoseSearch.hits ?? "?"} hits)`,
  );
  L.push(
    `  bulk scan in JS       ${scanMs ?? "failed"} ms  (${doc.findings.bulkScan.hits ?? "?"} hits, ` +
      `${doc.findings.bulkScan.totalChars ?? "?"} chars)`,
  );
  L.push(`  sample bodies         ${doc.findings.bodies.ms ?? "?"} ms for ${SAMPLE}`);
  L.push(`  password-protected    ${doc.findings.bodies.lockedTotal ?? "?"} total`);
  L.push("");
  L.push("File lane (Full Disk Access)");
  L.push(`  store exists          ${fileFacts.exists}`);
  L.push(`  store readable        ${fileFacts.readable}`);
  L.push(
    `  size                  ${fileFacts.sizeBytes ?? "?"} bytes, wal ${fileFacts.walSizeBytes ?? "?"}`,
  );
  if (fileFacts.readable) {
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  entities              ${doc.findings.entities.names?.length ?? "?"} (ICNote = Z_ENT ${doc.findings.entities.noteEnt ?? "?"})`,
    );
    L.push(
      `  note rows             ${doc.findings.entities.liveNotes ?? "?"} live / ${doc.findings.entities.allNotes ?? "?"} total   Apple Events said ${noteCount ?? "?"}`,
    );
    if (doc.findings.entities.allNotes !== noteCount) {
      L.push(`     ^ MISMATCH — Z_ENT alone is not "a note the user sees".`);
    }
    L.push(
      `  deletion columns      ${(doc.findings.entities.deletionCols ?? []).join(", ") || "none found"}`,
    );
    L.push(
      `  TEXT columns          ${doc.findings.searchColumns.textColumnCount ?? "?"} typed TEXT; populated on note rows:`,
    );
    for (const c of ranked.slice(0, 8)) {
      L.push(
        `     ${c.column.padEnd(22)} ${String(c.rows).padStart(5)} rows (${Math.round((c.coverage ?? 0) * 100)}% of notes), avg ${c.avgLength}ch, ${Math.round((c.charRatio ?? 0) * 100)}% of all text`,
      );
    }
    L.push(`  ZDATA over ${doc.findings.zdata.sampled ?? 0} rows:`);
    for (const f of doc.findings.zdata.formats ?? []) {
      L.push(`     ${f.hex}  "${f.ascii}"  ${f.rows} rows`);
    }
    if (doc.findings.zdata.gunzipSucceeded) {
      L.push(
        `     gunzip ok on ${doc.findings.zdata.gunzipSucceeded}, inner ${doc.findings.zdata.innerMagicAfterGunzip}`,
      );
    }
    const zd = doc.findings.zdataDecode ?? {};
    for (const c of doc.findings.notePredicate ?? []) {
      L.push(
        `  predicate  ${c.name.padEnd(38)} ${String(c.rows ?? "?").padStart(5)} rows` +
          `${c.exact ? "  EXACT MATCH" : `  missing ${c.missing}, extra ${c.extra}`}`,
      );
    }
    if (zd.attempted) {
      L.push(
        `  ZDATA decode          ${zd.decoded}/${zd.sampled} decoded; pinned path agrees ` +
          `${zd.agreePinned}/${zd.decoded} (${Math.round((zd.agreementRate ?? 0) * 100)}%), ` +
          `longest-string agrees ${zd.agreeLongest}/${zd.decoded} (${Math.round((zd.longestRate ?? 0) * 100)}%)`,
      );
      L.push(`     reached via        ${JSON.stringify(zd.via ?? {})}`);
      L.push(
        `     skipped            ${zd.encrypted} encrypted, ${zd.notGzip} not gzip, ${zd.noCounterpart} no counterpart`,
      );
      L.push(`     body field path    ${JSON.stringify(zd.paths)}`);
      if (zd.lengthDeltas?.length) {
        L.push(`     length deltas      ${zd.lengthDeltas.join(", ")}`);
      }
    } else if (zd.reason) {
      L.push(`  ZDATA decode          not attempted - ${zd.reason}`);
    }
    L.push(
      `  attachment entities   ${JSON.stringify(doc.findings.attachments.attachEntities ?? {})}`,
    );
    L.push(
      `  attachment path cols  ${(doc.findings.attachments.pathCandidates ?? []).join(", ") || "none"}`,
    );
    L.push(`  Accounts/ readable    ${doc.findings.attachments.accountsDirReadable}`);
    L.push(`  tables                ${doc.findings.schema.objectCount}`);
    L.push(
      `  id bridges to Z_PK    ${doc.findings.idBridge.foundRow ?? doc.findings.idBridge.reason}`,
    );
    L.push(`  epoch offset          ${doc.findings.epoch.detectedOffset ?? "?"}`);
  }
  L.push("");
  if (projection) {
    L.push("Projected search cost at scale (no index — paid on every query)");
    for (const row of projection) {
      const v =
        row.projectedMs < 300
          ? "instant"
          : row.projectedMs < 1000
            ? "noticeable"
            : row.projectedMs < 5000
              ? "too slow"
              : "unusable";
      L.push(
        `  ${String(row.notes).padStart(6)} notes        ${String(row.projectedMs).padStart(6)} ms   ${v}`,
      );
    }
    L.push("");
  }
  L.push("VERDICT");
  L.push(`  search lane: ${doc.verdict.recommendation}`);
  L.push(`  index lane : ${indexLane.recommendation ?? indexLane.reason}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

// ─── --write: capture the schema fixture ────────────────────────────────────
// The fixture-built database is how the index lane gets tested offline, exactly
// as test/fixtures/envelope-index.sql does for Mail. DDL only — no data ever.

if (WANT_WRITE) {
  if (!ddlRows) {
    console.error("\n--write needs the file lane. Grant Full Disk Access and re-run.");
    process.exit(3);
  }
  const dest = join(ROOT, "packages", "notes", "test", "fixtures", "note-store.sql");
  mkdirSync(dirname(dest), { recursive: true });
  const sql = [
    "-- Captured from a real NoteStore.sqlite by scripts/probe-notes.mjs --write.",
    `-- macOS ${doc.macos}, fingerprint ${doc.findings.schema.fingerprint}, ${doc.findings.schema.objectCount} objects.`,
    "-- Schema only. No data.",
    "",
    ...ddlRows.map((r) => `${r.sql};`),
  ].join("\n");
  writeFileSync(dest, `${sql}\n`);
  console.log(`\nwrote ${dest.replace(ROOT + "/", "")}`);
}
