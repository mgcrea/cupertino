#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-reminders.
//
// Reminders differs from Mail and Notes in a way that changes what this has to
// answer. Its scripting dictionary is already complete for the core model —
// name, body, completed, due/allday-due/remind-me dates, priority, flagged,
// container, and every one of them read-write. So the question is NOT "is Apple
// Events fast enough" the way it was for Notes. It is:
//
//     WHAT DOES THE STORE HOLD THAT THE DICTIONARY CANNOT REACH,
//     AND CAN A ROW BE TIED BACK TO AN APPLE EVENTS REMINDER?
//
// The dictionary has no attachment, tag, url, alarm or recurrence class. Those
// are the capability Full Disk Access would buy. The bridge is what makes them
// reachable: without a column tying a store row to the `x-apple-reminder://…`
// id Apple Events returns, the two lanes are two disconnected halves and the
// index can only ever answer queries it can also fully resolve by itself.
//
// THE APPLE EVENTS HALF RUNS WITHOUT FULL DISK ACCESS. Run it as-is first.
//
// Unlike Notes, the store path is a GLOB, not a constant — and listing the
// directory to resolve it is itself privileged. Without FDA this script cannot
// even find the database, which is a finding worth printing rather than a crash.
//
// Dependency-free (node:sqlite + node:child_process). The database is opened
// read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, booleans, column
// names and DDL only. No reminder names, no bodies, no list names. The one
// exception is deliberate and bounded — see REDACTION note on the id bridge.
//
//   node scripts/probe-reminders.mjs                # human-readable report
//   node scripts/probe-reminders.mjs --json         # the raw document
//   node scripts/probe-reminders.mjs --term=milk    # word for the search timing
//   node scripts/probe-reminders.mjs --launch       # allow launching Reminders
//   node scripts/probe-reminders.mjs --write        # also write the schema fixture
//
// `--write` additionally needs Full Disk Access, and emits
// packages/reminders/test/fixtures/reminders-store.sql — the DDL the index
// lane's offline tests build their database from.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const WANT_JSON = has("--json");
const ALLOW_LAUNCH = has("--launch");
const WANT_WRITE = has("--write");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERM = (argv.find((a) => a.startsWith("--term=")) ?? "--term=a").slice(7);

/** Sample size for per-reminder reads. Small on purpose: each one is an Apple Event. */
const SAMPLE = 8;
/** Core Data stores seconds since 2001-01-01. */
const APPLE_EPOCH_OFFSET = 978_307_200;
/** Reminders shipped in 2012; outside this the offset guess is wrong. */
const sane = (d) => d.getFullYear() >= 2007 && d.getFullYear() <= 2100;
/** Core Data spells strings VARCHAR; LENGTH() on an INTEGER lies, so check the type. */
const isTextType = (t) => /CHAR|CLOB|TEXT/i.test(String(t ?? ""));
/** Apple Events ids arrive as `x-apple-reminder://<uuid>`; the store keeps the bare uuid. */
const uuidOf = (id) => /([0-9A-Fa-f-]{36})/.exec(id)?.[1] ?? null;
const yn = (b) => (b === null || b === undefined ? "?" : b ? "yes" : "no");

const CONTAINER = join(homedir(), "Library", "Group Containers", "group.com.apple.reminders");

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

const readable = (p) =>
  safe(
    () => {
      accessSync(p, constants.R_OK);
      return true;
    },
    () => false,
  );

// ─── osascript, exactly as packages/core/src/osascript.ts does it ─────────────
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

// Note the lowercase bundle id. Notes is com.apple.Notes; Reminders is not
// capitalised, and NSRunningApplication matches exactly.
const IS_RUNNING = `
function run(argv) {
  ObjC.import("AppKit");
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.reminders");
  return JSON.stringify({ running: apps.count > 0 });
}
`;

/**
 * Shape of the library: accounts, the list tree and its depth, reminder counts.
 *
 * `list.container` may be an account OR another list, so lists nest and the
 * walk has to recurse — the same lesson Notes' folder tree taught, arrived at
 * from the dictionary rather than from a surprise in production.
 */
const SHAPE = `
function run(argv) {
  var R = Application("Reminders");
  var accounts = R.accounts();
  var out = [];
  for (var a = 0; a < accounts.length; a++) {
    var acc = accounts[a];
    var lists = [];
    try { lists = acc.lists(); } catch (e) { lists = []; }
    out.push({
      nameLength: String(acc.name()).length,
      idLength: String(acc.id()).length,
      lists: lists.length
    });
  }
  // Does a list ever contain another list? The dictionary allows it; whether a
  // real library uses it is a different question, and only one of them matters.
  var nested = 0;
  var allLists = R.lists();
  for (var i = 0; i < allLists.length; i++) {
    var c = null;
    try { c = allLists[i].container(); } catch (e) { c = null; }
    if (c === null) continue;
    var cls = null;
    try { cls = String(c.class()); } catch (e) { cls = null; }
    if (cls === "list") nested++;
  }
  return JSON.stringify({
    accountCount: accounts.length,
    accounts: out,
    listCount: allLists.length,
    nestedLists: nested,
    reminderCount: R.reminders().length
  });
}
`;

/**
 * Per-property bulk fetch cost.
 *
 * This is the number the whole Apple Events lane rests on. A bulk array fetch
 * is ONE Apple Event whatever the library size, so a server that reads 13
 * properties pays 13 round trips total — not 13 per reminder. Timing each one
 * separately proves that and prices the read.
 */
const PROP_MATRIX = `
function run(argv) {
  var R = Application("Reminders");
  var names = ["id","name","body","completed","completionDate","dueDate",
               "alldayDueDate","remindMeDate","priority","flagged",
               "creationDate","modificationDate"];
  var out = {};
  for (var i = 0; i < names.length; i++) {
    var k = names[i];
    var t0 = new Date().getTime();
    try {
      var vals = R.reminders[k]();
      var nonNull = 0;
      for (var j = 0; j < vals.length; j++) if (vals[j] !== null && vals[j] !== undefined) nonNull++;
      out[k] = { ok: true, ms: new Date().getTime() - t0, count: vals.length, nonNull: nonNull };
    } catch (e) {
      out[k] = { ok: false, ms: new Date().getTime() - t0, error: String(e).slice(0, 120) };
    }
  }
  return JSON.stringify({ props: out });
}
`;

/**
 * `whose` on a BOOLEAN, which is the open question.
 *
 * Notes measured `whose` at 6.9x slower than a bulk scan, but that was a text
 * _contains match evaluated per note across the bridge. A boolean predicate is
 * a different animal and could push the filtering into the app, turning a 10k
 * fetch into a 200 fetch. Assuming Notes' answer carries over here would be
 * generalising from one measurement of a different thing.
 */
const WHOSE_INCOMPLETE = `
function run(argv) {
  var R = Application("Reminders");
  var names = R.reminders.whose({ completed: false }).name();
  return JSON.stringify({ hits: names.length });
}
`;

/** The alternative: pull both columns in bulk and filter in JS. */
const BULK_INCOMPLETE = `
function run(argv) {
  var R = Application("Reminders");
  var done = R.reminders.completed();
  var hits = 0;
  for (var i = 0; i < done.length; i++) if (!done[i]) hits++;
  return JSON.stringify({ hits: hits, scanned: done.length });
}
`;

/** Text search the way the server would do it: bulk name+body, filter in JS. */
const BULK_SEARCH = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var R = Application("Reminders");
  var names = R.reminders.name();
  var bodies = R.reminders.body();
  var needle = String(p.term).toLowerCase();
  var hits = 0, bytes = 0;
  for (var i = 0; i < names.length; i++) {
    var n = String(names[i] === null ? "" : names[i]);
    var b = String(bodies[i] === null ? "" : bodies[i]);
    bytes += n.length + b.length;
    if (n.toLowerCase().indexOf(needle) !== -1 || b.toLowerCase().indexOf(needle) !== -1) hits++;
  }
  return JSON.stringify({ hits: hits, scanned: names.length, totalChars: bytes });
}
`;

/** The same search asked of `whose`, for the text case. */
const WHOSE_SEARCH = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var R = Application("Reminders");
  var hits = R.reminders.whose({ name: { _contains: p.term } }).name();
  return JSON.stringify({ hits: hits.length });
}
`;

/**
 * Are subtasks reachable over Apple Events?
 *
 * The dictionary has no `subtasks` element, which is why everyone assumes they
 * are store-only. But `reminder.container` is typed `list OR reminder` — so a
 * subtask is representable as a reminder whose container is a reminder. If that
 * holds, a whole capability moves out of the file lane and into the free one.
 */
const SUBTASKS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var R = Application("Reminders");
  var all = R.reminders();
  var limit = Math.min(all.length, p.sample);
  var classes = {};
  var checked = 0, failed = 0;
  for (var i = 0; i < limit; i++) {
    var cls = null;
    try { cls = String(all[i].container().class()); } catch (e) { failed++; continue; }
    classes[cls] = (classes[cls] || 0) + 1;
    checked++;
  }
  return JSON.stringify({ checked: checked, failed: failed, containerClasses: classes,
                          sampledOf: all.length });
}
`;

/**
 * Ids, plus name lengths, for the bridge and predicate checks.
 *
 * REDACTION: this returns ids, and an id may be a UUID. That is the one thing
 * that must cross into the SQL half — finding which column holds it is the
 * point of the exercise. Ids never reach the printed report or the JSON
 * document; only the discovered column names do.
 */
const ALL_IDS = `
function run(argv) {
  var R = Application("Reminders");
  return JSON.stringify({ ids: R.reminders.id(), completed: R.reminders.completed() });
}
`;

/** Per-reminder property reads, and how the two due-date properties interact. */
const SAMPLE_DETAIL = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var R = Application("Reminders");
  var all = R.reminders();
  var out = [];
  var withDue = 0, withAllDay = 0, both = 0;
  for (var i = 0; i < all.length && out.length < p.sample; i++) {
    var r = all[i];
    var due = null, allday = null, err = null;
    try { due = r.dueDate(); } catch (e) { err = String(e).slice(0, 80); }
    try { allday = r.alldayDueDate(); } catch (e) { err = String(e).slice(0, 80); }
    if (due) withDue++;
    if (allday) withAllDay++;
    if (due && allday) both++;
    out.push({
      nameLength: String(r.name()).length,
      bodyLength: r.body() === null ? null : String(r.body()).length,
      hasDue: Boolean(due),
      hasAllDay: Boolean(allday),
      priority: r.priority(),
      error: err
    });
  }
  // The full-library view of the same question, in two Apple Events.
  var dueAll = null, alldayAll = null, prios = null;
  try {
    var d = R.reminders.dueDate();
    var a = R.reminders.alldayDueDate();
    dueAll = 0; alldayAll = 0; var bothAll = 0;
    for (var j = 0; j < d.length; j++) {
      if (d[j]) dueAll++;
      if (a[j]) alldayAll++;
      if (d[j] && a[j]) bothAll++;
    }
    var pv = R.reminders.priority();
    prios = {};
    for (var k = 0; k < pv.length; k++) prios[String(pv[k])] = (prios[String(pv[k])] || 0) + 1;
    return JSON.stringify({ sampled: out, withDue: withDue, withAllDay: withAllDay, both: both,
                            dueTotal: dueAll, alldayTotal: alldayAll, bothTotal: bothAll,
                            priorityHistogram: prios });
  } catch (e) {
    return JSON.stringify({ sampled: out, withDue: withDue, withAllDay: withAllDay, both: both,
                            error: String(e).slice(0, 120) });
  }
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
    "Reminders is not running.\n\n" +
      "Open Reminders and re-run, or pass --launch to let this script start it.\n" +
      "Launching is not the default for the same reason the read tools refuse to:\n" +
      "it steals focus and kicks off a sync.",
  );
  process.exit(2);
}
doc.findings.remindersWasRunning = running.running;

// ─── Lane 1: Apple Events. This half needs Automation only. ─────────────────

doc.findings.shape = timed("shape", SHAPE, {}, 120_000);
doc.findings.props = timed("props", PROP_MATRIX, {}, 300_000);
doc.findings.whoseIncomplete = timed("whoseIncomplete", WHOSE_INCOMPLETE, {}, 300_000);
doc.findings.bulkIncomplete = timed("bulkIncomplete", BULK_INCOMPLETE, {}, 300_000);
doc.findings.whoseSearch = timed("whoseSearch", WHOSE_SEARCH, { term: TERM }, 300_000);
doc.findings.bulkSearch = timed("bulkSearch", BULK_SEARCH, { term: TERM }, 300_000);
doc.findings.subtasks = timed("subtasks", SUBTASKS, { sample: 60 }, 180_000);
doc.findings.detail = timed("detail", SAMPLE_DETAIL, { sample: SAMPLE }, 180_000);

const reminderCount = doc.findings.shape.reminderCount ?? null;
const whoseBoolMs = doc.findings.whoseIncomplete.ok ? doc.findings.whoseIncomplete.ms : null;
const bulkBoolMs = doc.findings.bulkIncomplete.ok ? doc.findings.bulkIncomplete.ms : null;
const whoseTextMs = doc.findings.whoseSearch.ok ? doc.findings.whoseSearch.ms : null;
const bulkTextMs = doc.findings.bulkSearch.ok ? doc.findings.bulkSearch.ms : null;
const textCandidates = [whoseTextMs, bulkTextMs].filter((n) => n !== null);
const searchMs = textCandidates.length ? Math.min(...textCandidates) : null;
const searchVia = searchMs === null ? null : searchMs === whoseTextMs ? "whose" : "bulk scan";

// ─── Lane 2: the file lane. Needs Full Disk Access to even be FOUND. ────────
// Notes had one constant path, so existence could be probed with stat() while
// unreadable. Here the filename carries a UUID, so resolving it means listing a
// TCC-protected directory: without the grant there is nothing to stat.

const findStores = () => {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".sqlite")) {
        const st = safe(
          () => statSync(p),
          () => null,
        );
        out.push({
          path: p,
          sizeBytes: st?.size ?? null,
          readable: readable(p),
          walSizeBytes:
            safe(
              () => statSync(`${p}-wal`).size,
              () => null,
            ) ?? null,
        });
      }
    }
  };
  walk(CONTAINER, 0);
  return out;
};

const containerListable = safe(
  () => {
    readdirSync(CONTAINER);
    return true;
  },
  () => false,
);
const stores = containerListable ? findStores() : [];
// Largest readable file wins. Reminders keeps per-store containers, so a stale
// or empty one can sit beside the real database.
const chosen =
  stores.filter((s) => s.readable).toSorted((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0] ??
  null;

doc.findings.store = {
  containerPath: CONTAINER,
  containerListable,
  candidates: stores.map((s) => ({
    // Only the tail is printed: the parent holds a UUID that identifies the user's store.
    name: s.path.slice(CONTAINER.length + 1),
    sizeBytes: s.sizeBytes,
    readable: s.readable,
    walSizeBytes: s.walSizeBytes,
  })),
  chosen: chosen ? chosen.path.slice(CONTAINER.length + 1) : null,
};

/** Captured DDL, kept for --write. Null until the file lane runs. */
let ddlRows = null;

if (chosen) {
  const started = performance.now();
  const db = new DatabaseSync(`file:${encodeURI(chosen.path)}?mode=ro`, {
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
  ddlRows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
    )
    .all()
    // sqlite_sequence is created implicitly by AUTOINCREMENT and cannot be declared.
    .filter((r) => r.name !== "sqlite_sequence");
  doc.findings.schema = {
    objectCount: ddlRows.length,
    tables: ddlRows.filter((r) => r.type === "table").map((r) => r.name),
    fingerprint: createHash("sha256")
      .update(ddlRows.map((r) => r.sql).join("\n"))
      .digest("hex")
      .slice(0, 12),
  };

  const columnInfo = (t) =>
    safe(
      () => db.prepare(`PRAGMA table_info("${t}")`).all(),
      () => [],
    );
  const countOf = (t) =>
    safe(
      () => db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c,
      () => null,
    );

  const tables = doc.findings.schema.tables;

  /**
   * Q3. Which rows are reminders. Core Data may pack everything into one table
   * (as Notes does) or split per entity — do not assume either, read
   * Z_PRIMARYKEY and let the shape of the store say which.
   */
  doc.findings.entities = safe(() => {
    const rows = db.prepare("SELECT Z_ENT, Z_NAME, Z_SUPER FROM Z_PRIMARYKEY ORDER BY Z_ENT").all();
    return {
      names: rows.map((r) => r.Z_NAME),
      reminderish: rows.filter((r) => /reminder|todo|task/i.test(r.Z_NAME)).map((r) => r.Z_NAME),
      byName: Object.fromEntries(rows.map((r) => [r.Z_NAME, r.Z_ENT])),
    };
  });

  doc.findings.tableCounts = Object.fromEntries(
    tables.filter((t) => t.startsWith("Z") && t !== "Z_PRIMARYKEY").map((t) => [t, countOf(t)]),
  );

  /**
   * Q2, THE BLOCKING QUESTION: the id bridge.
   *
   * Guessing a column name here would be the same mistake the Notes decoder
   * made — a plausible answer that is silently wrong. So don't guess. Take a
   * real id from Apple Events, and search every TEXT column of every table for
   * it. Whatever comes back IS the bridge, by construction.
   *
   * Ids often arrive as x-apple-reminder://<UUID>, so try the bare UUID too:
   * the store almost certainly holds the identifier without the scheme.
   */
  const truth = timed("allIds", ALL_IDS, {}, 300_000);
  const truthIds = (truth.ids ?? []).map(String);

  doc.findings.idBridge = safe(() => {
    if (!truthIds.length) return { tested: false, reason: "no Apple Events ids to search for" };
    const sample = truthIds[0];
    const bare = uuidOf(sample);
    const needles = [
      { form: "full id", value: sample },
      ...(bare && bare !== sample ? [{ form: "bare uuid", value: bare }] : []),
    ];
    const hits = [];
    let scanned = 0;
    for (const t of tables) {
      for (const c of columnInfo(t)) {
        if (!isTextType(c.type)) continue;
        scanned += 1;
        for (const n of needles) {
          const found = safe(
            () =>
              db.prepare(`SELECT COUNT(*) AS c FROM "${t}" WHERE "${c.name}" = ?`).get(n.value).c,
            () => null,
          );
          if (found) hits.push({ table: t, column: c.name, form: n.form, rows: found });
        }
      }
    }
    return {
      tested: true,
      idShape: sample.replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}/, "<uuid>"),
      textColumnsScanned: scanned,
      hits,
      found: hits.length > 0,
    };
  });

  /**
   * Q3 continued. With the bridge known, check the candidate predicates by
   * comparing ID SETS against Apple Events — not counts. A matching COUNT is
   * not evidence; that is exactly how the Notes decoder passed while being 49%
   * wrong, and the phantom-notes bug came from trusting 1191 vs 921 too late.
   */
  doc.findings.reminderPredicate = safe(() => {
    const bridge = doc.findings.idBridge?.hits?.[0];
    if (!bridge) return { tested: false, reason: "no bridge column found" };
    const wantBare = bridge.form === "bare uuid";
    const truthSet = new Set(
      truthIds
        .map((id) => (wantBare ? uuidOf(id) : id))
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    );
    if (!truthSet.size) return { tested: false, reason: "no comparable ids" };

    const cols = columnInfo(bridge.table).map((c) => c.name);
    const deletionCols = cols.filter((c) => /DELET|TRASH|REMOVED|MARKEDFOR/i.test(c));
    const notDeleted = deletionCols.map((c) => ` AND ("${c}" IS NULL OR "${c}" = 0)`).join("");
    const candidates = [
      { name: "all rows", extra: "" },
      ...(notDeleted ? [{ name: "not deleted", extra: notDeleted }] : []),
    ];
    return {
      tested: true,
      table: bridge.table,
      column: bridge.column,
      deletionCols,
      appleEventsCount: truthSet.size,
      results: candidates.map((c) => {
        const got = safe(
          () =>
            new Set(
              db
                .prepare(
                  `SELECT "${bridge.column}" AS v FROM "${bridge.table}" WHERE "${bridge.column}" IS NOT NULL${c.extra}`,
                )
                .all()
                .map((r) => String(r.v).toUpperCase()),
            ),
          () => null,
        );
        if (!got) return { name: c.name, error: true };
        let missing = 0;
        for (const v of truthSet) if (!got.has(v)) missing += 1;
        let extra = 0;
        for (const v of got) if (!truthSet.has(v)) extra += 1;
        return {
          name: c.name,
          rows: got.size,
          missing,
          extra,
          exact: missing === 0 && extra === 0,
        };
      }),
    };
  });

  /**
   * Q4. What the store has that the dictionary does not. This list IS the
   * justification for the file lane — if it comes back thin, the lane shrinks
   * and Full Disk Access stops being worth asking for on this surface.
   */
  doc.findings.capabilities = safe(() => {
    const probes = {
      tags: /HASHTAG|\bTAG\b|TAGS/i,
      url: /\bURL\b/i,
      recurrence: /RECURR|REPEAT|FREQUENC/i,
      alarms: /ALARM|TRIGGER/i,
      location: /LOCATION|GEO|LATITUDE|PROXIMIT|PLACEMARK/i,
      attachments: /ATTACHMENT|MEDIA|IMAGE|FILE/i,
      subtasks: /SUBTASK|PARENT|CHILD/i,
      smartLists: /SMART|SAVEDSEARCH|FILTER/i,
      assignment: /ASSIGN|PARTICIPANT|SHARE/i,
    };
    const out = {};
    for (const [key, re] of Object.entries(probes)) {
      const matchedTables = tables.filter((t) => re.test(t));
      const matchedColumns = [];
      for (const t of tables) {
        for (const c of columnInfo(t)) {
          if (re.test(c.name)) matchedColumns.push(`${t}.${c.name}`);
        }
      }
      out[key] = {
        tables: matchedTables,
        // Bounded: the point is whether it exists and roughly where, not a full listing.
        columns: matchedColumns.slice(0, 12),
        columnCount: matchedColumns.length,
        rows: Object.fromEntries(
          matchedTables.map((t) => [t, doc.findings.tableCounts[t] ?? null]),
        ),
        present: matchedTables.length > 0 || matchedColumns.length > 0,
      };
    }
    return out;
  });

  /** Q5. Attachment bytes on disk — do they exist, and can a row reach one? */
  doc.findings.attachmentFiles = safe(() => {
    const dirs = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      let files = 0;
      for (const e of entries) {
        if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
        else files += 1;
      }
      if (files && /attach|media|image|file/i.test(dir)) {
        dirs.push({ name: dir.slice(CONTAINER.length + 1), files });
      }
    };
    walk(CONTAINER, 0);
    return { mediaDirs: dirs, found: dirs.length > 0 };
  });

  /** Which Core Data epoch, so dates are not silently 31 years off. */
  doc.findings.epoch = safe(() => {
    const bridge = doc.findings.idBridge?.hits?.[0];
    const table = bridge?.table ?? tables.find((t) => /REMINDER/i.test(t));
    if (!table) return { tested: false, reason: "no reminder table identified" };
    const dateCol = columnInfo(table).find(
      (c) => /CREAT|MODIF/i.test(c.name) && /TIMESTAMP|FLOAT|DATE/i.test(String(c.type)),
    );
    if (!dateCol) return { tested: false, reason: `no date column on ${table}` };
    const row = safe(
      () => db.prepare(`SELECT MAX("${dateCol.name}") AS m FROM "${table}"`).get(),
      () => null,
    );
    if (!row?.m) return { tested: false, reason: "no dates present" };
    const asApple = new Date((row.m + APPLE_EPOCH_OFFSET) * 1000);
    const asUnix = new Date(row.m * 1000);
    return {
      tested: true,
      table,
      column: dateCol.name,
      detectedOffset: sane(asApple) ? APPLE_EPOCH_OFFSET : sane(asUnix) ? 0 : "unknown",
    };
  });

  db.close();
} else {
  doc.notes.push(
    containerListable
      ? "The Reminders container is listable but holds no readable .sqlite file."
      : "Cannot list the Reminders group container — Full Disk Access is not granted to this " +
          "terminal. Unlike Notes, the store filename carries a UUID, so without the grant there " +
          "is not even a path to stat. The Apple Events half above still ran.",
  );
}

// ─── Verdict ────────────────────────────────────────────────────────────────
// Reminders' dictionary already covers the core model read-write, so the file
// lane is not being judged on speed. The rule in docs/distribution.md is that a
// permission must buy CAPABILITY. So the verdict asks two things: is the Apple
// Events lane usable on its own, and does the store hold anything the
// dictionary cannot reach at any speed.

const SEARCH_BUDGET_MS = 3_000;

const projection =
  searchMs !== null && reminderCount
    ? [1_000, 5_000, 10_000, 50_000].map((n) => ({
        reminders: n,
        projectedMs: Math.round((searchMs / reminderCount) * n),
      }))
    : null;

const caps = doc.findings.capabilities ?? {};
const gained = Object.entries(caps)
  .filter(([, v]) => v.present)
  .map(([k]) => k);
const bridge = doc.findings.idBridge ?? {};
const subtasksViaAppleEvents = Boolean(
  doc.findings.subtasks?.containerClasses &&
  Object.keys(doc.findings.subtasks.containerClasses).some((c) => /reminder/i.test(c)),
);

const indexLane = !chosen
  ? { answered: false, reason: "Full Disk Access not granted — re-run with it to settle this." }
  : {
      answered: true,
      bridgeFound: Boolean(bridge.found),
      bridge: bridge.hits?.[0] ?? null,
      capabilitiesGained: gained,
      recommendation: bridge.found
        ? `Bridge found: ${bridge.hits[0].table}.${bridge.hits[0].column} matches the Apple Events id ` +
          `(${bridge.hits[0].form}). The index lane can enrich an Apple Events result, and it buys: ` +
          `${gained.join(", ") || "nothing the dictionary lacks — reconsider the lane"}.`
        : `NO BRIDGE FOUND across ${bridge.textColumnsScanned ?? "?"} TEXT columns. The index cannot ` +
          `tie a row back to an Apple Events reminder, so take the documented fallback: the index ` +
          `filters and searches, and results are re-resolved by name+list over Apple Events.`,
    };

doc.verdict = {
  indexLane,
  reminderCount,
  listCount: doc.findings.shape.listCount ?? null,
  nestedLists: doc.findings.shape.nestedLists ?? null,
  subtasksViaAppleEvents,
  appleEventsSearchMs: searchMs,
  appleEventsSearchVia: searchVia,
  whoseBooleanMs: whoseBoolMs,
  bulkBooleanMs: bulkBoolMs,
  // The open question Notes' 6.9x answer does NOT settle, because that was text.
  whoseWinsOnBoolean: whoseBoolMs !== null && bulkBoolMs !== null ? whoseBoolMs < bulkBoolMs : null,
  whoseTextMs,
  bulkTextMs,
  searchBudgetMs: SEARCH_BUDGET_MS,
  fullDiskAccessGranted: Boolean(chosen),
  msPerReminder:
    searchMs !== null && reminderCount ? Number((searchMs / reminderCount).toFixed(4)) : null,
  projection,
  recommendation:
    searchMs === null
      ? "Apple Events search did not complete. Treat that as a blocker, not a nuance."
      : searchMs > SEARCH_BUDGET_MS
        ? `Best Apple Events search took ${searchMs} ms over ${reminderCount} reminders (${searchVia}). Too slow — the index lane carries search.`
        : `Apple Events search took ${searchMs} ms over ${reminderCount} reminders via ${searchVia}. Fast enough to ship on its own; the index lane is for capability, not speed.`,
};

// ─── Report ─────────────────────────────────────────────────────────────────

if (WANT_JSON) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Reminders probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(
    `Search term: ${JSON.stringify(TERM)}   Reminders was running: ${doc.findings.remindersWasRunning}`,
  );
  L.push("");
  L.push("Apple Events lane (Automation only)");
  L.push(`  accounts              ${doc.findings.shape.accountCount ?? "?"}`);
  L.push(
    `  lists                 ${doc.findings.shape.listCount ?? "?"} (${doc.findings.shape.nestedLists ?? "?"} nested inside another list)`,
  );
  L.push(`  reminders             ${reminderCount ?? "?"}`);
  L.push(
    `  whose completed=false ${whoseBoolMs ?? "failed"} ms  (${doc.findings.whoseIncomplete.hits ?? "?"} hits)`,
  );
  L.push(
    `  bulk + filter in JS   ${bulkBoolMs ?? "failed"} ms  (${doc.findings.bulkIncomplete.hits ?? "?"} hits)`,
  );
  L.push(
    `     ^ boolean whose ${doc.verdict.whoseWinsOnBoolean === null ? "inconclusive" : doc.verdict.whoseWinsOnBoolean ? "WINS — unlike Notes' text case" : "loses, same as Notes' text case"}`,
  );
  L.push(
    `  whose name contains   ${whoseTextMs ?? "failed"} ms  (${doc.findings.whoseSearch.hits ?? "?"} hits)`,
  );
  L.push(
    `  bulk name+body scan   ${bulkTextMs ?? "failed"} ms  (${doc.findings.bulkSearch.hits ?? "?"} hits, ${doc.findings.bulkSearch.totalChars ?? "?"} chars)`,
  );
  const props = doc.findings.props?.props ?? {};
  L.push(`  per-property bulk fetch (one Apple Event each, size-independent):`);
  for (const [k, v] of Object.entries(props)) {
    L.push(
      `     ${k.padEnd(20)} ${v.ok ? `${String(v.ms).padStart(5)} ms  ${v.nonNull}/${v.count} non-null` : `FAILED  ${v.error}`}`,
    );
  }
  const det = doc.findings.detail ?? {};
  L.push(
    `  due dates             ${det.dueTotal ?? "?"} timed, ${det.alldayTotal ?? "?"} all-day, ${det.bothTotal ?? "?"} with BOTH set`,
  );
  L.push(`  priorities            ${JSON.stringify(det.priorityHistogram ?? {})}`);
  L.push(
    `  subtasks over AE      containers seen: ${JSON.stringify(doc.findings.subtasks?.containerClasses ?? {})} (${doc.findings.subtasks?.failed ?? "?"} failed)`,
  );
  L.push(`     ^ reachable without Full Disk Access: ${yn(subtasksViaAppleEvents)}`);
  L.push("");
  L.push("File lane (Full Disk Access)");
  L.push(`  container listable    ${containerListable}`);
  L.push(`  sqlite candidates     ${stores.length}`);
  for (const c of doc.findings.store.candidates ?? []) {
    L.push(
      `     ${c.name.padEnd(52)} ${String(c.sizeBytes ?? "?").padStart(9)} B  readable=${c.readable}`,
    );
  }
  if (chosen) {
    L.push(`  chosen                ${doc.findings.store.chosen}`);
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  objects               ${doc.findings.schema.objectCount} (${doc.findings.schema.tables.length} tables)`,
    );
    L.push(
      `  entities              ${doc.findings.entities.names?.length ?? "?"}; reminder-ish: ${(doc.findings.entities.reminderish ?? []).join(", ") || "none"}`,
    );
    L.push("");
    L.push(`  ID BRIDGE — the blocking question`);
    L.push(`     id shape           ${bridge.idShape ?? "?"}`);
    L.push(`     TEXT cols scanned  ${bridge.textColumnsScanned ?? "?"}`);
    if (bridge.hits?.length) {
      for (const h of bridge.hits) {
        L.push(`     MATCH              ${h.table}.${h.column}  (${h.form}, ${h.rows} row)`);
      }
    } else {
      L.push(`     NO MATCH           the two lanes cannot be joined by id — take the fallback`);
    }
    const pred = doc.findings.reminderPredicate ?? {};
    if (pred.tested) {
      L.push(
        `  predicate on ${pred.table}.${pred.column}   Apple Events says ${pred.appleEventsCount}`,
      );
      for (const r of pred.results ?? []) {
        L.push(
          `     ${String(r.name).padEnd(18)} ${String(r.rows ?? "?").padStart(6)} rows` +
            `${r.exact ? "  EXACT MATCH" : `  missing ${r.missing}, extra ${r.extra}`}`,
        );
      }
      L.push(`     deletion columns   ${(pred.deletionCols ?? []).join(", ") || "none found"}`);
    } else if (pred.reason) {
      L.push(`  predicate             not tested - ${pred.reason}`);
    }
    L.push("");
    L.push("  WHAT THE STORE BUYS (absent from the scripting dictionary)");
    for (const [k, v] of Object.entries(caps)) {
      L.push(
        `     ${k.padEnd(14)} ${v.present ? "PRESENT" : "absent "}  ${v.tables.join(", ") || `${v.columnCount} cols`}${v.columns.length && !v.tables.length ? `  e.g. ${v.columns.slice(0, 3).join(", ")}` : ""}`,
      );
    }
    L.push(
      `  attachment dirs       ${JSON.stringify(doc.findings.attachmentFiles?.mediaDirs ?? [])}`,
    );
    L.push(
      `  epoch offset          ${doc.findings.epoch?.detectedOffset ?? doc.findings.epoch?.reason ?? "?"}`,
    );
  }
  L.push("");
  if (projection) {
    L.push("Projected Apple Events search cost at scale (no index — paid every query)");
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
        `  ${String(row.reminders).padStart(6)} reminders    ${String(row.projectedMs).padStart(6)} ms   ${v}`,
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

if (WANT_WRITE) {
  if (!ddlRows) {
    console.error("\n--write needs the file lane. Grant Full Disk Access and re-run.");
    process.exit(3);
  }
  const dest = join(ROOT, "packages", "reminders", "test", "fixtures", "reminders-store.sql");
  mkdirSync(dirname(dest), { recursive: true });
  const sql = [
    "-- Captured from a real Reminders store by scripts/probe-reminders.mjs --write.",
    `-- macOS ${doc.macos}, fingerprint ${doc.findings.schema.fingerprint}, ${doc.findings.schema.objectCount} objects.`,
    "-- Schema only. No data.",
    "",
    ...ddlRows.map((r) => `${r.sql};`),
  ].join("\n");
  writeFileSync(dest, `${sql}\n`);
  console.log(`\nwrote ${dest.replace(ROOT + "/", "")}`);
}
