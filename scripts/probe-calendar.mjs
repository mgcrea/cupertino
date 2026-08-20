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
// framework in `app/`, which today is a pure broker: it would add a TCC grant,
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
  appleEventsLane,
  detectEpoch,
  dumpSchema,
  fileFacts,
  findIdBridge,
  listable,
  macosVersion,
  maxNumericAsText,
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
  const { columnInfo, countOf, all } = tableTools(db);
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
          .filter((c) => /START|END|CREAT|MODIF|DATE/i.test(c.name))
          .map((c) => c.name),
      }))
      .toSorted((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
  });

  /** Which epoch, so dates are not silently 31 years off. */
  doc.findings.epoch = safe(() => {
    const bridge = doc.findings.idBridge?.hits?.[0];
    // Prefer the bridge table when there is one; otherwise the busiest event-ish
    // table that actually carries a date column. Never the first name to match.
    const ranked = doc.findings.eventTables ?? [];
    const table = bridge?.table ?? ranked.find((t) => t.dateColumns.length)?.table;
    if (!table) {
      return {
        tested: false,
        reason: `no event table with a date column among ${ranked.length} candidates`,
      };
    }
    const dateCol = columnInfo(table).find((c) => /START|CREAT|MODIF|DATE/i.test(c.name));
    if (!dateCol) return { tested: false, reason: `no date column on ${table}` };
    // Read as TEXT: Calendar dates are floats today, but a column that overflows
    // a JS double throws in node:sqlite and looks exactly like an empty one.
    const max = maxNumericAsText(db, table, dateCol.name);
    return {
      table,
      column: dateCol.name,
      ...detectEpoch(max.value),
      exceedsSafeInteger: max.exceedsSafeInteger,
    };
  });

  db.close();
} else if (chosen) {
  doc.findings.open = { ok: false, error: opened?.error ?? null };
  doc.notes.push(
    `Found a store but SQLite refused both open modes: ${opened?.error ?? "unknown"}.`,
  );
}

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
      `  epoch                 ${doc.findings.epoch?.epoch ?? doc.findings.epoch?.reason ?? "?"}`,
    );
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
