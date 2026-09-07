#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-calendar.
//
// THIS PROBE EXISTS TO SETTLE A DOCUMENTED WRONG TURN.
//
// docs/distribution.md's surface table reads:
//
//     | Calendar  | `~/Library/Calendars`  | absent | slow |
//
// and concludes, in the paragraph under it:
//
//     "neither does `~/Library/Calendars`, so Calendar probably needs EventKit
//      rather than a file lane."
//
// The premise is right and the conclusion does not follow. `~/Library/Calendars`
// really is absent — but `~/Library/Group Containers/group.com.apple.calendar`
// EXISTS and returns `Operation not permitted`, which is the same signature
// Notes and Reminders show, and which the table itself records as `EPERM` for
// every other surface. "Absent" and "EPERM" are exactly the distinction
// packages/core/src/fs.ts was written to keep apart, and the table conflated
// them here by looking at only one of the two candidate paths.
//
// The stakes are not academic. Linking EventKit would be the first data
// framework in `apps/apple/`, which today is a pure broker: it would add a TCC grant,
// move logic from TypeScript into Swift, and fork the two-lane design that
// packages/core exists to hold in one place. That is a large decision to take on
// the strength of a path that was never checked.
//
// So the questions here, in order of what they decide:
//
//     1. WHERE IS THE STORE? Check BOTH candidate roots, and report exists,
//        listable and readable separately for each. This alone settles the
//        table.
//     2. IF IT EXISTS, WHAT IS IN IT? Schema, entities, counts — enough to say
//        whether a file lane is real rather than merely present.
//     3. HOW SLOW IS APPLE EVENTS, ACTUALLY? "Slow" in the table is unsourced.
//        Calendar's dictionary is rich (attendees, alarms, recurrence all
//        read-write), so if the lane is merely unhurried rather than unusable,
//        Calendar can ship on it the way Notes did.
//     4. CAN A ROW BE TIED TO AN EVENT? Calendar hands back a `uid`. Without a
//        column holding it, the two lanes are two disconnected halves.
//
// THE APPLE EVENTS HALF RUNS WITHOUT FULL DISK ACCESS. Run it as-is first: on
// the strength of question 3 alone, Calendar may not need the grant.
//
// Dependency-free (node builtins + scripts/lib/probe-kit.mjs). Any database is
// opened read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, booleans, column
// names and DDL only. No event titles, no locations, no attendees, no calendar
// names, no notes.
//
//   node scripts/probe-calendar.mjs                 # human-readable report
//   node scripts/probe-calendar.mjs --json          # the raw document
//   node scripts/probe-calendar.mjs --term=standup  # word for the search timing
//   node scripts/probe-calendar.mjs --days=90       # window for the range query
//   node scripts/probe-calendar.mjs --launch        # allow launching Calendar
//   node scripts/probe-calendar.mjs --write         # also write the schema fixture

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggNumericAsText,
  appleEventsLane,
  detectEpoch,
  dumpSchema,
  fileFacts,
  findIdBridge,
  listable,
  macosVersion,
  looksLikeDateColumn,
  openStore,
  parseArgs,
  safe,
  tableTools,
  timed,
  uuidOf,
  walkDir,
  writeFixture,
  yn,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERM = args.term;
const DAYS = Number(args.valueOf("days", "90")) || 90;

/**
 * BOTH candidate roots. The whole correction hangs on checking the second one,
 * so neither is allowed to be implicit.
 */
const CANDIDATE_ROOTS = [
  { label: "legacy", path: join(homedir(), "Library", "Calendars") },
  {
    label: "group container",
    path: join(homedir(), "Library", "Group Containers", "group.com.apple.calendar"),
  },
];

const tilde = (p) => p.replace(homedir(), "~");

/** How many members of `want` are absent from `got`. Set diffs, both directions. */
const missingFrom = (want, got) => {
  let n = 0;
  for (const v of want) if (!got.has(v)) n += 1;
  return n;
};

/**
 * Whether a stored timezone string names a real zone.
 *
 * Called, not `new`ed: `Intl.DateTimeFormat` returns an instance either way, and
 * the throw on an unknown zone is the whole test. Anything that fails here is a
 * sentinel — a floating date, which is a different type from an instant.
 */
const isIanaZone = (v) => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: String(v) });
    return true;
  } catch {
    return false;
  }
};

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: macosVersion(),
  sqlite: null,
  searchTerm: TERM,
  rangeDays: DAYS,
  findings: {},
  verdict: {},
  notes: [],
};

// ─── Lane 1: Apple Events. This half needs Automation only. ─────────────────
//
// Calendar's reputation for slowness comes from `cal.events()`, which
// materialises every event in a calendar across the bridge. The dictionary also
// offers `whose` with a date range, which pushes the filter into the app. Which
// one the server should use is a measurement, not a preference — and it is the
// same shape of question Reminders asked about `whose` on a boolean.

/** Counts only, and per-calendar counts via the specifier rather than a fetch. */
const SHAPE = `
function run(argv) {
  var C = Application("Calendar");
  var cals = C.calendars();
  var out = [];
  var total = 0;
  for (var i = 0; i < cals.length; i++) {
    var n = null;
    var t0 = new Date().getTime();
    try { n = cals[i].events.length; } catch (e) { n = null; }
    if (n !== null) total += n;
    out.push({
      nameLength: String(cals[i].name()).length,
      writable: (function () { try { return cals[i].writable(); } catch (e) { return null; } })(),
      events: n,
      countMs: new Date().getTime() - t0
    });
  }
  return JSON.stringify({ calendarCount: cals.length, calendars: out, eventTotal: total });
}
`;

/**
 * The range query the server would actually issue, pushed into the app.
 * A calendar tool is almost always "what is on in this window", so this is the
 * hot path and the number that decides the lane.
 */
const RANGE_WHOSE = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Calendar");
  var from = new Date(p.from);
  var to = new Date(p.to);
  var cals = C.calendars();
  var hits = 0, scanned = 0, failed = 0;
  for (var i = 0; i < cals.length; i++) {
    try {
      var evs = cals[i].events.whose({
        _and: [{ startDate: { _greaterThan: from } }, { startDate: { _lessThan: to } }]
      });
      var ids = evs.uid();
      hits += ids.length;
      scanned += 1;
    } catch (e) {
      failed += 1;
    }
  }
  return JSON.stringify({ hits: hits, calendarsScanned: scanned, calendarsFailed: failed });
}
`;

/**
 * The alternative: bulk-fetch start dates per calendar and filter in JS. One
 * Apple Event per calendar whatever the event count, which is what made the
 * Notes lane viable.
 */
const RANGE_BULK = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Calendar");
  var from = new Date(p.from).getTime();
  var to = new Date(p.to).getTime();
  var cals = C.calendars();
  var hits = 0, scanned = 0, failed = 0;
  for (var i = 0; i < cals.length; i++) {
    try {
      var starts = cals[i].events.startDate();
      scanned += starts.length;
      for (var j = 0; j < starts.length; j++) {
        if (starts[j] === null) continue;
        var t = starts[j].getTime();
        if (t > from && t < to) hits++;
      }
    } catch (e) {
      failed += 1;
    }
  }
  return JSON.stringify({ hits: hits, scanned: scanned, calendarsFailed: failed });
}
`;

/** Text search the way the server would do it: bulk summaries, filter in JS. */
const BULK_SEARCH = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Calendar");
  var needle = String(p.term).toLowerCase();
  var cals = C.calendars();
  var hits = 0, scanned = 0, chars = 0;
  for (var i = 0; i < cals.length; i++) {
    try {
      var sums = cals[i].events.summary();
      for (var j = 0; j < sums.length; j++) {
        var s = String(sums[j] === null ? "" : sums[j]);
        chars += s.length;
        scanned++;
        if (s.toLowerCase().indexOf(needle) !== -1) hits++;
      }
    } catch (e) {}
  }
  return JSON.stringify({ hits: hits, scanned: scanned, totalChars: chars });
}
`;

/**
 * Per-property bulk fetch cost, to price a read the way the Reminders probe did.
 * The dictionary claims all of these; whether they answer in bulk is separate.
 */
const PROP_MATRIX = `
function run(argv) {
  var C = Application("Calendar");
  var names = ["uid","summary","startDate","endDate","alldayEvent","location",
               "description","status","recurrence","stampDate","excludedDates","url"];
  var cals = C.calendars();
  if (!cals.length) return JSON.stringify({ props: {}, note: "no calendars" });
  // Price against the busiest calendar: the worst realistic case, not the best.
  var busiest = 0, most = -1;
  for (var i = 0; i < cals.length; i++) {
    var n = 0;
    try { n = cals[i].events.length; } catch (e) { n = 0; }
    if (n > most) { most = n; busiest = i; }
  }
  var cal = cals[busiest];
  var out = {};
  for (var k = 0; k < names.length; k++) {
    var key = names[k];
    var t0 = new Date().getTime();
    try {
      var vals = cal.events[key]();
      var nonNull = 0;
      for (var j = 0; j < vals.length; j++) if (vals[j] !== null && vals[j] !== undefined) nonNull++;
      out[key] = { ok: true, ms: new Date().getTime() - t0, count: vals.length, nonNull: nonNull };
    } catch (e) {
      out[key] = { ok: false, ms: new Date().getTime() - t0, error: String(e).slice(0, 120) };
    }
  }
  return JSON.stringify({ props: out, busiestEventCount: most });
}
`;

/**
 * Attendees and alarms over Apple Events. Both are in the dictionary, which
 * means they might NOT be a reason to want the file lane — worth confirming,
 * because it shrinks what the permission would buy.
 */
const RICH_ELEMENTS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Calendar");
  var cals = C.calendars();
  var attendees = 0, alarms = 0, checked = 0, failed = 0;
  var alarmClasses = {};
  for (var i = 0; i < cals.length && checked < p.sample; i++) {
    var evs;
    try { evs = cals[i].events(); } catch (e) { failed++; continue; }
    for (var j = 0; j < evs.length && checked < p.sample; j++) {
      checked++;
      try { attendees += evs[j].attendees().length; } catch (e) { failed++; }
      try {
        var ds = evs[j].displayAlarms();
        var ss = evs[j].soundAlarms();
        alarms += ds.length + ss.length;
        if (ds.length) alarmClasses.display = (alarmClasses.display || 0) + ds.length;
        if (ss.length) alarmClasses.sound = (alarmClasses.sound || 0) + ss.length;
      } catch (e) { failed++; }
    }
  }
  return JSON.stringify({ checked: checked, failed: failed, attendees: attendees,
                          alarms: alarms, alarmClasses: alarmClasses });
}
`;

/**
 * PHASE 0.5 — the truth set for the recurrence question.
 *
 * `EVENT_UIDS` above answers "does this uid appear in a column"; that settled the
 * id bridge and nothing more. Deciding how to expand recurrences needs a
 * different shape of answer: the (uid, start instant) PAIRS Calendar itself
 * reports for a window, so the store's range query can be diffed against them as
 * a SET.
 *
 * A count comparison would not do. `docs/surfaces.md` records that the Notes
 * decoder passed a count check while being wrong about half the corpus, and a
 * recurring event is precisely the case where the store can return the right
 * NUMBER of rows for the wrong instants.
 *
 * Bulk per calendar, filtered in JS — the shape every measurement in this file
 * has already shown to win.
 */
const RANGE_TRUTH = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var C = Application("Calendar");
  var from = new Date(p.from).getTime();
  var to = new Date(p.to).getTime();
  var cals = C.calendars();
  var pairs = [], failed = 0, truncated = false;
  for (var i = 0; i < cals.length; i++) {
    try {
      var uids = cals[i].events.uid();
      var starts = cals[i].events.startDate();
      for (var j = 0; j < uids.length && j < starts.length; j++) {
        if (starts[j] === null) continue;
        var t = starts[j].getTime();
        if (t < from || t >= to) continue;
        if (pairs.length >= p.cap) { truncated = true; break; }
        pairs.push(String(uids[j]) + "|" + Math.round(t / 1000));
      }
    } catch (e) {
      failed += 1;
    }
  }
  return JSON.stringify({ pairs: pairs, calendarsFailed: failed, truncated: truncated });
}
`;

/** Event uids for the bridge scan. Uids are opaque; masked before printing anyway. */
const EVENT_UIDS = `
function run(argv) {
  var C = Application("Calendar");
  var cals = C.calendars();
  var ids = [];
  for (var i = 0; i < cals.length && ids.length < 200; i++) {
    try {
      var us = cals[i].events.uid();
      for (var j = 0; j < us.length && ids.length < 200; j++) ids.push(String(us[j]));
    } catch (e) {}
  }
  return JSON.stringify({ ids: ids });
}
`;

// The Apple Events half is skippable and the file-lane half is not, because the
// question this probe exists to answer — where the store lives — needs no Apple
// Event at all. Exiting here would abandon the correction to save a measurement.
const aeLane = appleEventsLane("com.apple.iCal", "Calendar", args.launch);
doc.findings.appleEventsLane = aeLane;

const now = new Date();
const from = new Date(now.getTime() - DAYS * 86_400_000).toISOString();
const to = new Date(now.getTime() + DAYS * 86_400_000).toISOString();

const skipped = { skipped: true, ok: false, reason: aeLane.reason };
const ae = (fn) => (aeLane.available ? fn() : skipped);

doc.findings.shape = ae(() => timed("shape", SHAPE, {}, 300_000));
doc.findings.rangeWhose = ae(() => timed("rangeWhose", RANGE_WHOSE, { from, to }, 300_000));
doc.findings.rangeBulk = ae(() => timed("rangeBulk", RANGE_BULK, { from, to }, 300_000));
doc.findings.bulkSearch = ae(() => timed("bulkSearch", BULK_SEARCH, { term: TERM }, 300_000));
doc.findings.props = ae(() => timed("props", PROP_MATRIX, {}, 300_000));
doc.findings.richElements = ae(() => timed("richElements", RICH_ELEMENTS, { sample: 40 }, 240_000));
// The same window the store-side range query below uses, so the two are
// comparable as sets. Capped: a set diff is about membership, and an unbounded
// fetch on a large calendar would price this probe out of being run at all.
doc.findings.rangeTruth = ae(() =>
  timed("rangeTruth", RANGE_TRUTH, { from, to, cap: 5_000 }, 300_000),
);

const eventTotal = doc.findings.shape.eventTotal ?? null;
const whoseMs = doc.findings.rangeWhose.ok ? doc.findings.rangeWhose.ms : null;
const bulkMs = doc.findings.rangeBulk.ok ? doc.findings.rangeBulk.ms : null;
const searchMs = doc.findings.bulkSearch.ok ? doc.findings.bulkSearch.ms : null;
const rangeCandidates = [whoseMs, bulkMs].filter((n) => n !== null);
const rangeMs = rangeCandidates.length ? Math.min(...rangeCandidates) : null;
const rangeVia = rangeMs === null ? null : rangeMs === whoseMs ? "whose" : "bulk scan";

// ─── Lane 2: THE CORRECTION. Where is the store, actually? ──────────────────
//
// Both roots, each reported with exists / listable / readable kept separate.
// A root that exists but cannot be listed is EPERM — the same answer every other
// surface in the table gives, and the opposite of "absent".

const STORE_SUFFIX = /\.(sqlitedb|sqlite|db)$/i;

/**
 * Every store file found under either root, WITH its full path. This array is
 * the working list; the document only ever receives the redacted projection
 * built alongside it, because a parent directory here can carry an account UUID.
 */
const allStores = [];

doc.findings.roots = CANDIDATE_ROOTS.map((root) => {
  const facts = fileFacts(root.path);
  const canList = listable(root.path);
  const found = [];
  if (canList) {
    walkDir(root.path, {
      maxDepth: 4,
      onFile: (filePath, entry) => {
        if (!STORE_SUFFIX.test(entry.name)) return;
        const f = fileFacts(filePath);
        // Only the tail is ever printed: parents can carry account UUIDs.
        const store = {
          name: filePath.slice(root.path.length + 1),
          sizeBytes: f.sizeBytes,
          readable: f.readable,
          walSizeBytes: f.walSizeBytes,
        };
        found.push(store);
        allStores.push({ ...store, fullPath: filePath });
      },
    });
  }
  return {
    label: root.label,
    path: tilde(root.path),
    exists: facts.exists,
    listable: canList,
    // The distinction the table got wrong, stated in one field.
    status: !facts.exists ? "absent" : canList ? "readable" : "EPERM",
    storeCount: found.length,
    stores: found,
  };
});

// Largest readable wins; Calendar keeps per-account stores and a stale or empty
// one can sit beside the real database.
const chosen =
  allStores
    .filter((s) => s.readable)
    .toSorted((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0] ?? null;
doc.findings.chosenStore = chosen ? { name: chosen.name, sizeBytes: chosen.sizeBytes } : null;

let ddlRows = null;
let opened = null;
if (chosen) opened = openStore(chosen.fullPath);

if (opened?.db) {
  const db = opened.db;
  const { columnInfo, countOf, one, all } = tableTools(db);
  doc.sqlite = opened.sqlite;
  doc.findings.open = { ms: opened.openMs, mode: opened.mode, walBlind: opened.walBlind };

  const schema = dumpSchema(db);
  ddlRows = schema.ddlRows;
  doc.findings.schema = {
    objectCount: schema.objectCount,
    tables: schema.tables,
    fingerprint: schema.fingerprint,
  };
  const tables = schema.tables;
  const colsOf = (t) => columnInfo(t).map((c) => c.name);

  doc.findings.tableCounts = Object.fromEntries(tables.map((t) => [t, countOf(t)]));

  /**
   * Entities, read from the store rather than assumed. Calendar's store has
   * historically NOT been Core Data in the Z_PRIMARYKEY sense, so try that and
   * fall back to naming heuristics rather than crashing on its absence.
   */
  doc.findings.entities = safe(() => {
    const rows = all("SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY ORDER BY Z_ENT");
    if (rows.length) {
      return {
        style: "core-data",
        names: rows.map((r) => r.Z_NAME),
        eventish: rows.filter((r) => /event|occurrence|item/i.test(r.Z_NAME)).map((r) => r.Z_NAME),
      };
    }
    return {
      style: "plain",
      names: tables,
      eventish: tables.filter((t) => /event|occurrence|item/i.test(t)),
    };
  });

  /** THE ID BRIDGE: does a uid Calendar handed us appear in a column? */
  const truth = ae(() => timed("uids", EVENT_UIDS, {}, 300_000));
  const truthIds = (truth.ids ?? []).map(String).filter(Boolean);
  doc.findings.idBridge = safe(() => {
    if (!truthIds.length) return { tested: false, reason: "Apple Events returned no event uids" };
    const sample = truthIds[0];
    const bare = uuidOf(sample);
    const result = findIdBridge(db, tables, columnInfo, [
      { form: "full uid", value: sample },
      ...(bare && bare !== sample ? [{ form: "bare uuid", value: bare }] : []),
    ]);
    return {
      ...result,
      idShape: sample.replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}/, "<uuid>").replace(/\d/g, "0"),
    };
  });

  /**
   * Cross-check the row count against Apple Events by ID SET, not by count.
   * A matching COUNT is not evidence — that is exactly how the Notes decoder
   * passed while being wrong about half the corpus.
   */
  doc.findings.eventPredicate = safe(() => {
    const bridge = doc.findings.idBridge?.hits?.[0];
    if (!bridge) return { tested: false, reason: "no bridge column found" };
    const wantBare = bridge.form === "bare uuid";
    const truthSet = new Set(
      truthIds
        .map((id) => (wantBare ? uuidOf(id) : id))
        .filter(Boolean)
        .map((s) => s.toUpperCase()),
    );
    const got = new Set(
      all(
        `SELECT "${bridge.column}" AS v FROM "${bridge.table}" WHERE "${bridge.column}" IS NOT NULL`,
      ).map((r) => String(r.v).toUpperCase()),
    );
    let missing = 0;
    for (const v of truthSet) if (!got.has(v)) missing += 1;
    return {
      tested: true,
      table: bridge.table,
      column: bridge.column,
      // Apple Events was capped at 200 uids, so `extra` is expected and not a defect.
      appleEventsSampled: truthSet.size,
      storeRows: got.size,
      missingFromStore: missing,
      allSampledIdsFound: missing === 0,
    };
  });

  /**
   * What the store holds that the dictionary CANNOT reach. Calendar's dictionary
   * is unusually complete — attendees, alarms and recurrence are all in it — so
   * this list is expected to be short, and a short list is a real argument
   * against wanting the grant for this surface at all.
   */
  doc.findings.capabilities = safe(() => {
    const probes = {
      attachments: /ATTACHMENT|FILE|MEDIA/i,
      travelTime: /TRAVEL|COMMUTE/i,
      availability: /AVAILABILIT|TRANSPAREN|BUSY|FREE/i,
      conferencing: /CONFERENCE|VIDEO|MEETING_URL|JOIN/i,
      invitations: /INVIT|PARTICIPANT|ORGANIZER|RSVP|ATTENDEE/i,
      sharing: /SHARE|SUBSCRIB|DELEGAT|PUBLISH/i,
      notifications: /NOTIFICATION|ALARM|TRIGGER/i,
      structuredLocation: /LOCATION|GEO|LATITUDE|PLACEMARK|PROXIMIT/i,
      recurrenceRules: /RECURR|EXDATE|RRULE|FREQUENC/i,
      birthdays: /BIRTHDAY|ANNIVERSAR/i,
    };
    const out = {};
    for (const [key, re] of Object.entries(probes)) {
      const matchedTables = tables.filter((t) => re.test(t));
      const matchedColumns = [];
      for (const t of tables)
        for (const c of colsOf(t)) if (re.test(c)) matchedColumns.push(`${t}.${c}`);
      out[key] = {
        tables: matchedTables,
        columns: matchedColumns.slice(0, 12),
        columnCount: matchedColumns.length,
        present: matchedTables.length > 0 || matchedColumns.length > 0,
      };
    }
    return out;
  });

  /**
   * The event-ish tables ranked by row count.
   *
   * "Which table holds the events" is not answerable by name alone: this store
   * has seven tables matching /event|occurrence|item/, and the FIRST one
   * alphabetically is `EventAction`, which holds no dates at all. Ranking by
   * rows finds `CalendarItem` instead. Printed because the doc needs to name the
   * main table, and because a first-match heuristic quietly picking the wrong
   * one is how the epoch check below reported "no date column" on its first run.
   */
  doc.findings.eventTables = safe(() => {
    const candidates = tables.filter((t) => /event|occurrence|item/i.test(t));
    return candidates
      .map((t) => ({
        table: t,
        rows: doc.findings.tableCounts[t] ?? null,
        dateColumns: columnInfo(t)
          .filter((c) => looksLikeDateColumn(c.name, c.type))
          .map((c) => c.name),
      }))
      .toSorted((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
  });

  /**
   * Which epoch, so dates are not silently 31 years off.
   *
   * `CalendarItem` carries 27 date columns and there is no reason to believe
   * they agree — a Core Data store can mix an anchored timestamp with a plain
   * one. So sample several rather than trusting whichever name matches first,
   * and report each. Picking one column and generalising from it is the same
   * mistake as reading a blob format from `LIMIT 1`.
   */
  doc.findings.epoch = safe(() => {
    const bridge = doc.findings.idBridge?.hits?.[0];
    const ranked = doc.findings.eventTables ?? [];
    const table = bridge?.table ?? ranked.find((t) => t.dateColumns.length)?.table;
    if (!table) {
      return {
        tested: false,
        reason: `no event table with a date column among ${ranked.length} candidates`,
      };
    }
    // The columns a server would actually read, capped so the report stays short.
    const preferred = columnInfo(table)
      .filter((c) => looksLikeDateColumn(c.name, c.type))
      .map((c) => c.name)
      .slice(0, 8);
    if (!preferred.length) return { tested: false, reason: `no date column on ${table}` };

    const columns = {};
    let disagreement = false;
    let first = null;
    for (const c of preferred) {
      // Read as TEXT: a column that overflows a JS double throws in node:sqlite
      // and is indistinguishable from an empty one. See aggNumericAsText.
      const max = aggNumericAsText(db, table, c, "MAX");
      let detected = detectEpoch(max.value);
      let via = "MAX";
      // MAX can be a far-future sentinel — an unbounded recurring event's last
      // occurrence — which fails every plausibility window and reports as
      // "unknown" while the column is perfectly readable. MIN settles it.
      if (detected.epoch === "unknown") {
        const min = aggNumericAsText(db, table, c, "MIN");
        const fromMin = detectEpoch(min.value);
        if (fromMin.epoch && fromMin.epoch !== "unknown") {
          detected = fromMin;
          via = "MIN (MAX is out of range — likely a recurrence sentinel)";
        }
      }
      columns[c] = {
        ...detected,
        via,
        digits: max.digits ?? 0,
        exceedsSafeInteger: max.exceedsSafeInteger,
      };
      if (detected.epoch && detected.epoch !== "unknown") {
        if (first === null) first = detected.epoch;
        else if (detected.epoch !== first) disagreement = true;
      }
    }
    return { tested: true, table, columns, consensus: disagreement ? null : first, disagreement };
  });

  // ─── PHASE 0.5: what the recurrence decision actually needs ───────────────
  //
  // Everything above settled where the store is and whether a row can be tied
  // to an event. Neither answers the question that decides whether a range
  // query is CORRECT: `OccurrenceCache` (1,946 rows) and `OccurrenceCacheDays`
  // (2,630) both out-row `CalendarItem` (1,350), so expanded recurrences live
  // somewhere other than the main table and a naive `SELECT ... FROM
  // CalendarItem` returns a repeating event once instead of weekly.
  //
  // The failure mode is the dangerous kind: a short list is indistinguishable
  // from a free afternoon. So none of the column names below are assumed —
  // each is resolved against the live schema and the resolution is printed, in
  // the same spirit as findIdBridge above.

  const APPLE_EPOCH = 978_307_200;
  const appleToMs = (v) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? null
      : (Number(v) + APPLE_EPOCH) * 1000;
  const daysFromNow = (v) => {
    const ms = appleToMs(v);
    return ms === null ? null : Math.round((ms - Date.now()) / 86_400_000);
  };
  const isoOf = (v) => {
    const ms = appleToMs(v);
    if (ms === null) return null;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  };
  const has = (t) => tables.includes(t);

  /** First candidate that exists on the table, else null. Never guesses blind. */
  const pickCol = (table, candidates) => {
    if (!has(table)) return null;
    const names = colsOf(table);
    const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
    for (const c of candidates) {
      const hit = lower.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  /**
   * WHICH COLUMN JOINS A CHILD ROW TO ITS PARENT, measured rather than assumed.
   *
   * Same reasoning as findIdBridge: a plausible-looking `event_id` that is
   * really an index into something else would produce a query that runs, returns
   * rows, and is wrong. So score every integer column by how completely its
   * non-null values resolve to a parent ROWID, and report the ranking — a
   * winner with a 100% resolve rate over many distinct values is a measurement;
   * one that resolves 40% is a warning.
   */
  const linkColumn = (child, parent) => {
    if (!has(child) || !has(parent)) {
      return { tested: false, reason: `${!has(child) ? child : parent} absent` };
    }
    /**
     * The child's own INTEGER PRIMARY KEY is excluded, and that exclusion is
     * the whole correctness of this function.
     *
     * MEASURED FAILURE: without it this reported `Recurrence.ROWID` and
     * `ExceptionDate.ROWID` as 100% resolving links to CalendarItem. They are
     * not links at all — both tables are `ROWID INTEGER PRIMARY KEY
     * AUTOINCREMENT`, so their keys are a dense 1..N sequence that trivially
     * lands inside CalendarItem's own dense 1..N rowids. A perfect score, and
     * completely wrong; the real column is `owner_id` in both cases.
     *
     * That is the exact shape of mistake this file keeps warning about — a
     * plausible answer nobody would think to question — so the guard is here
     * rather than in the reader's head.
     */
    const cols = columnInfo(child);
    // A SOLE `INTEGER PRIMARY KEY` column is an alias for the table's rowid.
    // A composite key is not, so `OccurrenceCacheDays.calendar_id` — part of
    // `PRIMARY KEY (calendar_id, day)` and a genuine foreign key — must survive.
    const keyed = cols.filter((c) => c.pk > 0);
    const rowidAlias =
      keyed.length === 1 && /INT/i.test(keyed[0].type || "") ? keyed[0].name : null;
    const ints = cols.filter((c) => /INT/i.test(c.type || "") && c.name !== rowidAlias);
    const ranked = [];
    for (const c of ints) {
      const stats = one(
        `SELECT COUNT(*) AS nonNull, COUNT(DISTINCT "${c.name}") AS distinctValues
           FROM "${child}" WHERE "${c.name}" IS NOT NULL AND "${c.name}" > 0`,
      );
      if (!stats?.nonNull) continue;
      const matched = one(
        `SELECT COUNT(*) AS matched FROM "${child}" ch
           JOIN "${parent}" pa ON pa.ROWID = ch."${c.name}"
          WHERE ch."${c.name}" IS NOT NULL AND ch."${c.name}" > 0`,
      );
      ranked.push({
        column: c.name,
        nonNull: stats.nonNull,
        distinctValues: stats.distinctValues,
        matched: matched?.matched ?? 0,
        resolveRate: Number(((matched?.matched ?? 0) / stats.nonNull).toFixed(4)),
      });
    }
    // Fully-resolving first, then the one spanning the most parents: a flag
    // column of 0s and 1s also "resolves" against a table with rowids 0 and 1.
    ranked.sort((a, b) => b.resolveRate - a.resolveRate || b.distinctValues - a.distinctValues);
    const winner = ranked.find((r) => r.resolveRate === 1 && r.distinctValues > 1) ?? null;
    return { tested: true, winner: winner?.column ?? null, ranked: ranked.slice(0, 8) };
  };

  /** (1) The tables a server would read, with their real column lists. */
  doc.findings.schemaDetail = safe(() => {
    const WANTED = [
      "CalendarItem",
      "Calendar",
      "Store",
      "OccurrenceCache",
      "OccurrenceCacheDays",
      "Recurrence",
      "ExceptionDate",
      "Location",
      "Alarm",
      "Participant",
    ];
    const out = {};
    for (const t of WANTED) {
      if (!has(t)) {
        out[t] = { present: false };
        continue;
      }
      const cols = columnInfo(t);
      out[t] = {
        present: true,
        rows: doc.findings.tableCounts[t] ?? null,
        columnCount: cols.length,
        columns: cols.map((c) => `${c.name}:${c.type || "?"}`),
        dateColumns: cols.filter((c) => looksLikeDateColumn(c.name, c.type)).map((c) => c.name),
      };
    }
    return out;
  });

  /** (2) The joins, each measured. */
  doc.findings.links = safe(() => ({
    occurrenceToItem: linkColumn("OccurrenceCache", "CalendarItem"),
    occurrenceDaysToOccurrence: linkColumn("OccurrenceCacheDays", "OccurrenceCache"),
    recurrenceToItem: linkColumn("Recurrence", "CalendarItem"),
    exceptionToItem: linkColumn("ExceptionDate", "CalendarItem"),
    itemToCalendar: linkColumn("CalendarItem", "Calendar"),
    calendarToStore: linkColumn("Calendar", "Store"),
  }));

  /**
   * (3) THE NUMBER THAT DECIDES THE DESIGN: how far the expansion reaches.
   *
   * If the cache spans a bounded window around today, it is a materialised view
   * for the month/day UI and cannot be the sole authority — "what is on in March
   * next year" would come back empty and look exactly like a free calendar. If
   * it spans decades, it is a real expansion and can be trusted inside its edges.
   * Either way the server must publish the edges rather than truncate silently.
   */
  doc.findings.occurrenceCoverage = safe(() => {
    if (!has("OccurrenceCache")) return { tested: false, reason: "OccurrenceCache absent" };
    const rows = countOf("OccurrenceCache") ?? 0;
    if (!rows) return { tested: true, rows: 0, note: "present but empty" };
    const dateCols = columnInfo("OccurrenceCache")
      .filter((c) => looksLikeDateColumn(c.name, c.type))
      .map((c) => c.name);
    const columns = {};
    for (const c of dateCols) {
      const min = aggNumericAsText(db, "OccurrenceCache", c, "MIN");
      const max = aggNumericAsText(db, "OccurrenceCache", c, "MAX");
      columns[c] = {
        earliestIso: isoOf(min.value),
        latestIso: isoOf(max.value),
        earliestDaysFromToday: daysFromNow(min.value),
        latestDaysFromToday: daysFromNow(max.value),
        // The epoch is re-derived per column rather than inherited: a Core Data
        // store can mix anchored and unanchored timestamps in one table.
        epoch: detectEpoch(max.value).epoch ?? null,
      };
    }
    return { tested: true, rows, columns };
  });

  /**
   * (4) Does the cache hold non-recurring items too?
   *
   * This decides whether the two legs of a union overlap for ordinary events —
   * i.e. whether the dedupe step is doing real work or is merely defensive.
   */
  doc.findings.occurrenceScope = safe(() => {
    const link = doc.findings.links?.occurrenceToItem?.winner;
    const recLink = doc.findings.links?.recurrenceToItem?.winner;
    if (!link) return { tested: false, reason: "no measured OccurrenceCache -> CalendarItem link" };
    const parents = one(
      `SELECT COUNT(DISTINCT "${link}") AS parents FROM "OccurrenceCache" WHERE "${link}" > 0`,
    );
    const result = {
      tested: true,
      linkColumn: link,
      distinctParents: parents?.parents ?? null,
      itemRows: doc.findings.tableCounts.CalendarItem ?? null,
      occurrenceRows: doc.findings.tableCounts.OccurrenceCache ?? null,
    };
    if (recLink && has("Recurrence")) {
      const withRule = one(
        `SELECT COUNT(DISTINCT oc."${link}") AS n FROM "OccurrenceCache" oc
           WHERE EXISTS (SELECT 1 FROM "Recurrence" r WHERE r."${recLink}" = oc."${link}")`,
      );
      const withoutRule = one(
        `SELECT COUNT(DISTINCT oc."${link}") AS n FROM "OccurrenceCache" oc
           WHERE NOT EXISTS (SELECT 1 FROM "Recurrence" r WHERE r."${recLink}" = oc."${link}")`,
      );
      result.parentsWithRecurrenceRule = withRule?.n ?? null;
      result.parentsWithoutRecurrenceRule = withoutRule?.n ?? null;
      result.cacheCoversNonRecurringItems = (withoutRule?.n ?? 0) > 0;
    }
    return result;
  });

  /**
   * (5) THE SET DIFF. Not a count — a count check is how the Notes decoder
   * passed while being wrong about half the corpus (docs/surfaces.md).
   *
   * Runs the two-leg range query the server would issue and diffs it against
   * the (uid, start) pairs Calendar itself reported for the same window. Two
   * diffs are reported: by uid, which finds events the store cannot see at all,
   * and by (uid, instant), which additionally finds occurrences landing on the
   * wrong time. Separating them matters — the fixes are different.
   */
  doc.findings.rangeAgreement = safe(() => {
    const truthDoc = doc.findings.rangeTruth;
    if (!truthDoc?.pairs) {
      return { tested: false, reason: "Apple Events did not return a truth set" };
    }
    const bridge = doc.findings.idBridge?.hits?.[0];
    const itemUuid =
      bridge?.table === "CalendarItem" ? bridge.column : pickCol("CalendarItem", ["UUID"]);
    const itemStart = pickCol("CalendarItem", ["start_date"]);
    const itemEnd = pickCol("CalendarItem", ["end_date"]);
    const link = doc.findings.links?.occurrenceToItem?.winner;
    const recLink = doc.findings.links?.recurrenceToItem?.winner;
    const occStart = pickCol("OccurrenceCache", [
      "occurrence_date",
      "start_date",
      "occurrence_start_date",
    ]);
    const resolved = {
      itemUuid,
      itemStart,
      itemEnd,
      occurrenceLink: link,
      occurrenceStart: occStart,
    };
    if (!itemUuid || !itemStart) {
      return {
        tested: false,
        reason: "could not resolve CalendarItem uuid/start columns",
        resolved,
      };
    }

    const fromApple = Math.round(new Date(from).getTime() / 1000) - APPLE_EPOCH;
    const toApple = Math.round(new Date(to).getTime() / 1000) - APPLE_EPOCH;

    // Leg 1: items with no recurrence rule. Correct at any horizon.
    const notRecurring = recLink
      ? `AND NOT EXISTS (SELECT 1 FROM "Recurrence" r WHERE r."${recLink}" = ci.ROWID)`
      : "";
    const leg1 = all(
      `SELECT ci."${itemUuid}" AS uuid, ci."${itemStart}" AS startDate
         FROM "CalendarItem" ci
        WHERE ci."${itemStart}" < ?
          AND COALESCE(${itemEnd ? `ci."${itemEnd}"` : "NULL"}, ci."${itemStart}") > ?
          ${notRecurring}`,
      toApple,
      fromApple,
    );

    // Leg 2: expanded occurrences, if the cache is there to expand them.
    const leg2 =
      link && occStart
        ? all(
            `SELECT ci."${itemUuid}" AS uuid, oc."${occStart}" AS startDate
               FROM "OccurrenceCache" oc
               JOIN "CalendarItem" ci ON ci.ROWID = oc."${link}"
              WHERE oc."${occStart}" >= ? AND oc."${occStart}" < ?`,
            fromApple,
            toApple,
          )
        : [];

    const key = (uuid, appleSeconds) =>
      `${String(uuid).toUpperCase()}|${Math.round(Number(appleSeconds) + APPLE_EPOCH)}`;
    const storePairs = new Set();
    const storeUids = new Set();
    for (const r of [...leg1, ...leg2]) {
      if (r.uuid === null || r.startDate === null) continue;
      storePairs.add(key(r.uuid, r.startDate));
      storeUids.add(String(r.uuid).toUpperCase());
    }

    const truthPairs = new Set();
    const truthUids = new Set();
    for (const raw of truthDoc.pairs) {
      const idx = String(raw).lastIndexOf("|");
      if (idx < 0) continue;
      const uid = uuidOf(String(raw).slice(0, idx)) ?? String(raw).slice(0, idx);
      truthPairs.add(`${uid.toUpperCase()}|${String(raw).slice(idx + 1)}`);
      truthUids.add(uid.toUpperCase());
    }

    return {
      tested: true,
      resolved,
      windowDays: DAYS,
      appleEventsTruncated: Boolean(truthDoc.truncated),
      leg1Rows: leg1.length,
      leg2Rows: leg2.length,
      storeUids: storeUids.size,
      truthUids: truthUids.size,
      // The gate. Non-zero here means the store cannot see events that exist.
      uidsMissingFromStore: missingFrom(truthUids, storeUids),
      uidsExtraInStore: missingFrom(storeUids, truthUids),
      // Non-zero here with zero above means the event is found but expanded to
      // the wrong instants — a recurrence bug rather than a visibility one.
      pairsMissingFromStore: missingFrom(truthPairs, storePairs),
      pairsExtraInStore: missingFrom(storePairs, truthPairs),
    };
  });

  /**
   * (6) The unexplained extra row — 1,350 store rows against 1,349 events.
   *
   * One row is not a class of drift, but "which row" decides whether leg 1
   * needs a type predicate: CalendarItem shares its schema with Reminders
   * (due_date, completion_date), so a reminder-shaped row sitting in it would
   * be a filter the server is currently missing. Reported as shape only —
   * which columns are populated, never what they hold.
   */
  doc.findings.itemShape = safe(() => {
    const dueCol = pickCol("CalendarItem", ["due_date"]);
    const doneCol = pickCol("CalendarItem", ["completion_date"]);
    const startCol = pickCol("CalendarItem", ["start_date"]);
    const entityCol = pickCol("CalendarItem", ["entity_type", "type", "item_type"]);
    const out = {
      rows: doc.findings.tableCounts.CalendarItem ?? null,
      dueDateColumn: dueCol,
      completionDateColumn: doneCol,
      entityTypeColumn: entityCol,
    };
    if (dueCol)
      out.rowsWithDueDate =
        one(`SELECT COUNT(*) AS n FROM "CalendarItem" WHERE "${dueCol}" IS NOT NULL`)?.n ?? null;
    if (doneCol)
      out.rowsWithCompletionDate =
        one(`SELECT COUNT(*) AS n FROM "CalendarItem" WHERE "${doneCol}" IS NOT NULL`)?.n ?? null;
    if (startCol)
      out.rowsWithoutStartDate =
        one(`SELECT COUNT(*) AS n FROM "CalendarItem" WHERE "${startCol}" IS NULL`)?.n ?? null;
    if (entityCol) {
      out.entityTypeHistogram = all(
        `SELECT "${entityCol}" AS v, COUNT(*) AS n FROM "CalendarItem" GROUP BY 1 ORDER BY n DESC LIMIT 8`,
      );
    }
    return out;
  });

  /**
   * (7) The floating-timezone sentinel.
   *
   * An all-day event names a DAY, not an instant, and rendering it in the
   * reader's zone moves it to the previous day for everyone east of Greenwich.
   * The server therefore needs to recognise a start_tz that is not a real zone.
   *
   * REDACTION: real IANA names are not printed — a timezone set describes where
   * someone lives and works. Only the count, and the values that FAIL to
   * validate as zones, which is the finding and identifies nobody.
   */
  doc.findings.timeZones = safe(() => {
    const tzCol = pickCol("CalendarItem", ["start_tz", "start_timezone", "timezone"]);
    if (!tzCol) return { tested: false, reason: "no timezone column on CalendarItem" };
    const rows = all(
      `SELECT DISTINCT "${tzCol}" AS v FROM "CalendarItem" WHERE "${tzCol}" IS NOT NULL`,
    );
    /**
     * MEASURED: this store holds TWO non-IANA values, `_float` and `GMT+0200`,
     * and they mean opposite things. `_float` is a floating date — an instant
     * deliberately without a zone. `GMT+0200` is a perfectly definite fixed
     * offset that merely is not an IANA name, and treating it as floating would
     * silently discard a two-hour offset.
     *
     * So classify rather than lump together: anything matching GMT±HHMM is a
     * fixed offset the renderer can honour directly.
     */
    const nonIana = rows.map((r) => r.v).filter((v) => !isIanaZone(v));
    const FIXED_OFFSET = /^(?:GMT|UTC)[+-]\d{2}:?\d{2}$/i;
    const fixedOffsets = nonIana.filter((v) => FIXED_OFFSET.test(String(v)));
    const sentinels = nonIana.filter((v) => !FIXED_OFFSET.test(String(v)));
    const nulls =
      one(`SELECT COUNT(*) AS n FROM "CalendarItem" WHERE "${tzCol}" IS NULL`)?.n ?? null;
    const allDayCol = pickCol("CalendarItem", ["all_day"]);
    return {
      tested: true,
      column: tzCol,
      distinctValues: rows.length,
      nullRows: nulls,
      // Printed in full: these are sentinels like "_float", not real places.
      nonIanaValues: sentinels,
      /** Definite zones that simply are not IANA names. NOT floating dates. */
      fixedOffsetValues: fixedOffsets,
      allDayColumn: allDayCol,
      allDayRows: allDayCol
        ? (one(`SELECT COUNT(*) AS n FROM "CalendarItem" WHERE "${allDayCol}" = 1`)?.n ?? null)
        : null,
    };
  });

  db.close();
} else if (chosen) {
  doc.findings.open = { ok: false, error: opened?.error ?? null };
  doc.notes.push(
    `Found a store but SQLite refused both open modes: ${opened?.error ?? "unknown"}.`,
  );
}

/**
 * `Extras.db` — 32 KB sitting beside the main store, listed as unexamined in
 * docs/calendar.md. Small enough that one schema dump closes it out, and an
 * unexamined file next to the one the server depends on is exactly the kind of
 * thing that turns out to hold the flag nobody could find.
 *
 * Schema only, like everything else here.
 */
doc.findings.extras = safe(() => {
  const extras = allStores.find((s) => /(^|\/)Extras\.db$/i.test(s.name));
  if (!extras) return { tested: false, reason: "no Extras.db found under either root" };
  if (!extras.readable)
    return { tested: false, reason: "found but not readable — needs Full Disk Access" };
  const extrasDb = openStore(extras.fullPath);
  if (!extrasDb.db) return { tested: false, reason: `could not open: ${extrasDb.error}` };
  const schema = dumpSchema(extrasDb.db);
  const { countOf } = tableTools(extrasDb.db);
  const out = {
    tested: true,
    sizeBytes: extras.sizeBytes,
    objectCount: schema.objectCount,
    fingerprint: schema.fingerprint,
    tables: schema.tables,
    rowCounts: Object.fromEntries(schema.tables.map((t) => [t, countOf(t)])),
  };
  extrasDb.db.close();
  return out;
});

// ─── Verdict ────────────────────────────────────────────────────────────────

const RANGE_BUDGET_MS = 3_000;

const groupRoot = doc.findings.roots.find((r) => r.label === "group container");
const legacyRoot = doc.findings.roots.find((r) => r.label === "legacy");

/** The specific sentence docs/distribution.md needs, produced from evidence. */
const tableCorrection = (() => {
  if (chosen) {
    return (
      `CORRECTION CONFIRMED. A readable store exists at ${groupRoot.path}/${chosen.name}. ` +
      `Update the surface table: the Store column should name the group container, and the Probe ` +
      `column should read the same as every other row. Calendar does NOT need EventKit for a file lane.`
    );
  }
  if (groupRoot?.status === "EPERM") {
    return (
      `CORRECTION CONFIRMED, LANE UNPROVEN. ${groupRoot.path} exists and returns EPERM — the same ` +
      `signature as Notes and Reminders, NOT "absent". The table's "absent" entry is wrong because it ` +
      `checked only ${legacyRoot.path}. Re-run with Full Disk Access to learn what the container holds; ` +
      `the EventKit conclusion is unsupported either way.`
    );
  }
  if (groupRoot?.status === "absent" && legacyRoot?.status === "absent") {
    return (
      `TABLE UPHELD. Neither ${legacyRoot.path} nor ${groupRoot.path} exists on this machine. ` +
      `The EventKit conclusion stands — but record BOTH paths in the table so the next reader does ` +
      `not have to re-derive it.`
    );
  }
  return `Inconclusive: legacy=${legacyRoot?.status}, group container=${groupRoot?.status}.`;
})();

const caps = doc.findings.capabilities ?? {};
const gained = Object.entries(caps)
  .filter(([, v]) => v.present)
  .map(([k]) => k);
const rich = doc.findings.richElements ?? {};

/**
 * PHASE 0.5 VERDICT: which recurrence strategy the evidence supports.
 *
 * Stated as a recommendation with its reasoning attached, because the next
 * reader needs to be able to disagree with it on the evidence rather than on
 * trust. The gate is the SET diff, not the row counts.
 */
const recurrenceVerdict = (() => {
  const agree = doc.findings.rangeAgreement;
  const cover = doc.findings.occurrenceCoverage;
  if (!opened?.db) {
    return { decidable: false, reason: "no file lane — re-run with Full Disk Access." };
  }
  if (!agree?.tested) {
    return {
      decidable: false,
      reason: `the set diff did not run (${agree?.reason ?? "unknown"}). Without it there is no evidence either way — do not start the store lane.`,
    };
  }
  const clean = agree.uidsMissingFromStore === 0 && agree.pairsMissingFromStore === 0;
  // Coverage is read off whichever occurrence column reaches furthest: the
  // question is how far the expansion goes, not which column carries it.
  const spans = Object.values(cover?.columns ?? {})
    .map((c) => c.latestDaysFromToday)
    .filter((n) => typeof n === "number");
  const latest = spans.length ? Math.max(...spans) : null;
  const bounded = latest !== null && latest < 400;
  return {
    decidable: true,
    setDiffClean: clean,
    uidsMissingFromStore: agree.uidsMissingFromStore,
    pairsMissingFromStore: agree.pairsMissingFromStore,
    expansionLatestDaysFromToday: latest,
    expansionLooksBounded: bounded,
    strategy: !clean
      ? "BLOCKED"
      : bounded
        ? "hybrid, coverage published"
        : "hybrid, coverage published (cache reaches far)",
    recommendation: !clean
      ? `BLOCKED. The store's range query misses ${agree.uidsMissingFromStore} uid(s) and ${agree.pairsMissingFromStore} (uid, instant) pair(s) that Calendar reports for the same window. Do not build the store lane on this shape — find out what it cannot see first.`
      : bounded
        ? `Two-leg hybrid, and the cache is NOT an authority beyond its edge: the furthest expanded occurrence is ${latest} days from today, which is a materialised window for the UI rather than a complete expansion. Leg 1 (items with no recurrence rule) is correct at any horizon; leg 2 (OccurrenceCache) is correct inside the window. A range past the edge must set a truncated flag naming what is missing — a short list is indistinguishable from a free calendar.`
        : `Two-leg hybrid. The set diff is clean and the cache reaches ${latest} days out, so it behaves like a real expansion rather than a UI window — but publish the coverage edge anyway, because nothing here guarantees the next machine's cache is as deep.`,
  };
})();

doc.verdict = {
  storeLocation: tableCorrection,
  fullDiskAccessGranted: Boolean(opened?.db),
  calendarCount: doc.findings.shape.calendarCount ?? null,
  eventTotal,
  rangeMs,
  rangeVia,
  whoseMs,
  bulkMs,
  // Reminders asked the same question about booleans; this is the date-range case.
  whoseWinsOnDateRange: whoseMs !== null && bulkMs !== null ? whoseMs < bulkMs : null,
  searchMs,
  rangeBudgetMs: RANGE_BUDGET_MS,
  attendeesOverAppleEvents: (rich.attendees ?? 0) > 0,
  alarmsOverAppleEvents: (rich.alarms ?? 0) > 0,
  capabilitiesGained: gained,
  msPerEvent: rangeMs !== null && eventTotal ? Number((rangeMs / eventTotal).toFixed(4)) : null,
  projection:
    rangeMs !== null && eventTotal
      ? [1_000, 5_000, 20_000, 100_000].map((n) => ({
          events: n,
          projectedMs: Math.round((rangeMs / eventTotal) * n),
        }))
      : null,
  appleEventsTested: aeLane.available,
  recurrence: recurrenceVerdict,
  recommendation: !aeLane.available
    ? `Speed UNMEASURED — ${aeLane.reason} The table's unsourced "slow" is still unsourced.`
    : rangeMs === null
      ? "The range query did not complete over Apple Events. Treat that as a blocker, not a nuance — it is the hot path."
      : rangeMs > RANGE_BUDGET_MS
        ? `Best range query took ${rangeMs} ms over ${eventTotal} events (${rangeVia}). Too slow for the hot path — Calendar needs an index lane, so where the store lives is now a blocking question rather than a curiosity.`
        : `Range query took ${rangeMs} ms over ${eventTotal} events via ${rangeVia}. The table's unsourced "slow" does not hold at this size — Calendar can ship on Apple Events alone, exactly as Notes did, and the file lane becomes a capability question rather than a speed one.`,
};

// ─── Report ─────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Calendar probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(
    `Search term: ${JSON.stringify(TERM)}   Window: ±${DAYS} days   Calendar was running: ${yn(aeLane.running)}`,
  );
  L.push("");
  L.push("WHERE IS THE STORE — the reason this probe exists");
  for (const r of doc.findings.roots) {
    L.push(
      `  ${r.label.padEnd(16)} ${String(r.status).padEnd(9)} ${r.path}` +
        `${r.exists ? `  (listable=${yn(r.listable)}, ${r.storeCount} store files)` : ""}`,
    );
    for (const s of r.stores ?? []) {
      L.push(
        `     ${s.name.padEnd(46)} ${String(s.sizeBytes ?? "?").padStart(9)} B  readable=${s.readable}`,
      );
    }
  }
  L.push("");
  L.push("Apple Events lane (Automation only)");
  if (!aeLane.available) {
    // Print nothing else: a row of "?" and a "no" read as measurements, and an
    // unmeasured surface reported as a measured one is how a probe misleads.
    L.push(`  SKIPPED               ${aeLane.reason}`);
  } else {
    L.push(`  calendars             ${doc.findings.shape.calendarCount ?? "?"}`);
    L.push(`  events (all)          ${eventTotal ?? "?"}`);
    L.push(
      `  range via whose       ${whoseMs ?? "failed"} ms  (${doc.findings.rangeWhose.hits ?? "?"} hits)`,
    );
    L.push(
      `  range via bulk scan   ${bulkMs ?? "failed"} ms  (${doc.findings.rangeBulk.hits ?? "?"} hits)`,
    );
    L.push(
      `     ^ date-range whose ${doc.verdict.whoseWinsOnDateRange === null ? "inconclusive" : doc.verdict.whoseWinsOnDateRange ? "WINS — push the filter into the app" : "loses — bulk fetch and filter in JS"}`,
    );
    L.push(
      `  summary search        ${searchMs ?? "failed"} ms  (${doc.findings.bulkSearch.hits ?? "?"} hits, ${doc.findings.bulkSearch.scanned ?? "?"} scanned)`,
    );
    const props = doc.findings.props?.props ?? {};
    if (Object.keys(props).length) {
      L.push(
        `  per-property bulk fetch on the busiest calendar (${doc.findings.props.busiestEventCount ?? "?"} events):`,
      );
      for (const [k, v] of Object.entries(props)) {
        L.push(
          `     ${k.padEnd(16)} ${v.ok ? `${String(v.ms).padStart(6)} ms  ${v.nonNull}/${v.count} non-null` : `FAILED  ${v.error}`}`,
        );
      }
    }
    L.push(
      `  attendees / alarms    ${rich.attendees ?? "?"} / ${rich.alarms ?? "?"} across ${rich.checked ?? "?"} events` +
        `  ${JSON.stringify(rich.alarmClasses ?? {})}`,
    );
    L.push(
      `     ^ both reachable WITHOUT Full Disk Access: attendees=${yn(doc.verdict.attendeesOverAppleEvents)} alarms=${yn(doc.verdict.alarmsOverAppleEvents)}`,
    );
  }
  L.push("");
  if (opened?.db) {
    L.push("File lane (Full Disk Access)");
    L.push(`  chosen                ${doc.findings.chosenStore.name}`);
    L.push(
      `  opened                ${doc.findings.open.mode} in ${doc.findings.open.ms} ms${doc.findings.open.walBlind ? "   (WAL-BLIND)" : ""}`,
    );
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  objects               ${doc.findings.schema.objectCount} (${doc.findings.schema.tables.length} tables)`,
    );
    L.push(
      `  entities              ${doc.findings.entities.style}; event-ish: ${(doc.findings.entities.eventish ?? []).join(", ") || "none"}`,
    );
    L.push(`  event-ish tables by rows (which one actually holds the events):`);
    for (const t of (doc.findings.eventTables ?? []).slice(0, 6)) {
      L.push(
        `     ${t.table.padEnd(24)} ${String(t.rows ?? "?").padStart(7)} rows  ` +
          `${t.dateColumns.length ? `${t.dateColumns.length} date cols` : "no date cols"}`,
      );
    }
    const bridge = doc.findings.idBridge ?? {};
    L.push("");
    L.push("  ID BRIDGE");
    if (bridge.tested) {
      L.push(`     uid shape          ${bridge.idShape}`);
      L.push(`     TEXT cols scanned  ${bridge.textColumnsScanned}`);
      if (bridge.hits?.length) {
        for (const h of bridge.hits) {
          L.push(`     MATCH              ${h.table}.${h.column}  (${h.form}, ${h.rows} rows)`);
        }
      } else {
        L.push(`     NO MATCH           the two lanes cannot be joined by uid`);
      }
    } else {
      L.push(`     not tested         ${bridge.reason}`);
    }
    const pred = doc.findings.eventPredicate ?? {};
    if (pred.tested) {
      L.push(
        `  predicate             ${pred.table}.${pred.column}: ${pred.storeRows} store rows, ` +
          `${pred.missingFromStore}/${pred.appleEventsSampled} sampled uids missing` +
          `${pred.allSampledIdsFound ? "   ALL FOUND" : "   MISMATCH"}`,
      );
    }
    L.push("");
    L.push("  WHAT THE STORE BUYS (absent from the scripting dictionary)");
    for (const [k, v] of Object.entries(caps)) {
      L.push(
        `     ${k.padEnd(18)} ${v.present ? "PRESENT" : "absent "}  ${v.tables.join(", ") || `${v.columnCount} cols`}` +
          `${v.columns.length && !v.tables.length ? `  e.g. ${v.columns.slice(0, 3).join(", ")}` : ""}`,
      );
    }
    L.push(
      `  epoch                 ${
        doc.findings.epoch?.tested
          ? `${doc.findings.epoch.consensus ?? "COLUMNS DISAGREE"} on ${doc.findings.epoch.table}`
          : (doc.findings.epoch?.reason ?? "?")
      }`,
    );
    for (const [col, e] of Object.entries(doc.findings.epoch?.columns ?? {})) {
      L.push(
        `     ${col.padEnd(24)} ${e.tested ? `${e.epoch}${e.latestYear ? `  (${e.via === "MAX" ? "latest" : "earliest"} ${e.latestYear})` : ""}` : e.reason}` +
          `${e.exceedsSafeInteger ? "  EXCEEDS JS SAFE INTEGER" : ""}` +
          `${e.via && e.via !== "MAX" ? `  via ${e.via}` : ""}`,
      );
      // An "unknown" that shows its working is diagnosable; one that does not
      // just looks like the probe giving up.
      if (e.epoch === "unknown" && e.considered) {
        L.push(
          `        readings: ${e.considered.map((c) => `${c.epoch}→${c.year ?? "?"}`).join(", ")}`,
        );
      }
    }

    // ─── PHASE 0.5 ────────────────────────────────────────────────────────
    L.push("");
    L.push("  RECURRENCE — the question that decides whether a range query is CORRECT");
    const links = doc.findings.links ?? {};
    for (const [name, l] of Object.entries(links)) {
      L.push(
        `     ${name.padEnd(26)} ${
          l.tested ? (l.winner ? `${l.winner}  (resolves 100%)` : "NO CLEAN LINK") : l.reason
        }`,
      );
      // A partial resolve rate is the interesting case: it means the column
      // looks like a foreign key and is not one.
      for (const r of l.ranked ?? []) {
        if (r.resolveRate < 1 && r.resolveRate > 0.05) {
          L.push(
            `        suspect         ${r.column}: resolves ${(r.resolveRate * 100).toFixed(1)}% over ${r.distinctValues} distinct`,
          );
        }
      }
    }
    const cover = doc.findings.occurrenceCoverage ?? {};
    if (cover.tested && cover.columns) {
      L.push(`     expansion window   ${cover.rows} cached occurrence rows`);
      for (const [col, c] of Object.entries(cover.columns)) {
        L.push(
          `        ${col.padEnd(24)} ${String(c.earliestDaysFromToday ?? "?").padStart(7)} → ${String(c.latestDaysFromToday ?? "?").padStart(7)} days from today  (${c.epoch ?? "?"})`,
        );
      }
    } else {
      L.push(`     expansion window   ${cover.reason ?? cover.note ?? "?"}`);
    }
    const scope = doc.findings.occurrenceScope ?? {};
    if (scope.tested) {
      L.push(
        `     cache parents      ${scope.distinctParents ?? "?"} of ${scope.itemRows ?? "?"} items` +
          (scope.cacheCoversNonRecurringItems === undefined
            ? ""
            : `; ${scope.parentsWithoutRecurrenceRule} have NO recurrence rule` +
              (scope.cacheCoversNonRecurringItems
                ? "  — the legs OVERLAP, dedupe is load-bearing"
                : "  — the legs are disjoint")),
      );
    }
    const agree = doc.findings.rangeAgreement ?? {};
    L.push("");
    L.push(`  SET DIFF vs Apple Events (±${DAYS} days) — the gate`);
    if (agree.tested) {
      L.push(
        `     columns used       ${Object.entries(agree.resolved)
          .map(([k, v]) => `${k}=${v ?? "—"}`)
          .join("  ")}`,
      );
      L.push(`     store rows         leg1=${agree.leg1Rows}  leg2=${agree.leg2Rows}`);
      L.push(`     uids               store ${agree.storeUids} vs Calendar ${agree.truthUids}`);
      L.push(
        `     MISSING from store ${agree.uidsMissingFromStore} uids, ${agree.pairsMissingFromStore} (uid, instant) pairs` +
          `${agree.uidsMissingFromStore === 0 && agree.pairsMissingFromStore === 0 ? "   CLEAN" : "   *** BLOCKER ***"}`,
      );
      L.push(
        `     extra in store     ${agree.uidsExtraInStore} uids, ${agree.pairsExtraInStore} pairs` +
          `${agree.appleEventsTruncated ? "   (Apple Events truth set was capped)" : ""}`,
      );
      // Extras are EXPECTED, and reading them as a defect would be the wrong
      // lesson entirely. `cal.events` hands back MASTER events, and the truth
      // query filters them by the master's own startDate — so a weekly meeting
      // that began in 2023 contributes nothing to the truth set while having
      // real occurrences inside the window. Expanding those is the entire point
      // of leg 2. The diff is therefore evidence in ONE direction only:
      // "missing" means the store cannot see something, "extra" means it can
      // see something Apple Events cannot express.
      L.push(
        `        ^ extras are expected: Apple Events reports masters by their own start date, so`,
      );
      L.push(
        `          occurrences of a series that began before the window exist only on this side.`,
      );
      L.push(
        `          Only the MISSING count is a defect signal; "extra" is leg 2 doing its job.`,
      );
    } else {
      L.push(`     not tested         ${agree.reason}`);
    }
    const tz = doc.findings.timeZones ?? {};
    if (tz.tested) {
      L.push("");
      L.push(
        `  TIMEZONES            ${tz.column}: ${tz.distinctValues} distinct, ${tz.nullRows} null rows, ${tz.allDayRows ?? "?"} all-day events`,
      );
      L.push(
        `     floating sentinel  ${tz.nonIanaValues.length ? JSON.stringify(tz.nonIanaValues) : "none — every value is a real IANA zone"}`,
      );
      if (tz.fixedOffsetValues?.length) {
        L.push(
          `     fixed offsets      ${JSON.stringify(tz.fixedOffsetValues)} — definite zones, NOT floating; render with the offset`,
        );
      }
    }
    const shape = doc.findings.itemShape ?? {};
    if (shape.rows) {
      L.push(
        `  ITEM SHAPE           ${shape.rows} rows; ${shape.rowsWithDueDate ?? 0} with a due date, ` +
          `${shape.rowsWithCompletionDate ?? 0} completed, ${shape.rowsWithoutStartDate ?? 0} with no start`,
      );
      if (shape.entityTypeHistogram) {
        L.push(
          `     ${shape.entityTypeColumn}      ${shape.entityTypeHistogram.map((r) => `${r.v}×${r.n}`).join("  ")}`,
        );
      }
    }
    const extras = doc.findings.extras ?? {};
    L.push(
      `  Extras.db            ${
        extras.tested
          ? `${extras.sizeBytes} B, ${extras.tables.length} tables: ${extras.tables.join(", ") || "none"}`
          : extras.reason
      }`,
    );
    L.push("");
    const rv = doc.verdict.recurrence ?? {};
    L.push("  STRATEGY");
    for (const line of String(rv.recommendation ?? rv.reason ?? "?").split(/(?<=\.) (?=[A-Z])/)) {
      L.push(`     ${line}`);
    }
    L.push("");
  }
  if (doc.verdict.projection) {
    L.push("Projected Apple Events range-query cost at scale (no index — paid every query)");
    for (const row of doc.verdict.projection) {
      const v =
        row.projectedMs < 300
          ? "instant"
          : row.projectedMs < 1000
            ? "noticeable"
            : row.projectedMs < 5000
              ? "too slow"
              : "unusable";
      L.push(
        `  ${String(row.events).padStart(7)} events    ${String(row.projectedMs).padStart(7)} ms   ${v}`,
      );
    }
    L.push("");
  }
  L.push("VERDICT");
  L.push(`  store      : ${doc.verdict.storeLocation}`);
  L.push(`  speed      : ${doc.verdict.recommendation}`);
  // Printed unconditionally, including when the file lane never opened. The
  // recurrence section above lives inside the FDA branch, so without this line
  // a run with no grant is silent about the one question that blocks the build
  // — and silence reads as "nothing to report" rather than "not measured".
  L.push(
    `  recurrence : ${doc.verdict.recurrence.recommendation ?? doc.verdict.recurrence.reason}`,
  );
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "calendar",
    file: "calendar-store.sql",
    ddlRows,
    macos: doc.macos,
    fingerprint: doc.findings.schema?.fingerprint,
    tool: "scripts/probe-calendar.mjs",
  });
}
