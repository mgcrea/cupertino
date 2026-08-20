#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-safari.
//
// Safari is the most conventional of the three surfaces being probed: both lanes
// exist, neither is in doubt, and the schema behind History.db is small. So the
// questions are not "is this buildable" — they are about what the two lanes are
// each FOR, because they see almost disjoint things:
//
//     Apple Events sees what is open RIGHT NOW and nothing else. No history, no
//     Reading List, no visit counts. It is a view of the present.
//
//     The file lane sees everything EXCEPT what is open right now. History,
//     visit counts, redirects, Reading List — the past, and only the past.
//
// That split is unlike Mail or Notes, where the two lanes were two routes to the
// same data and the choice was about speed. Here neither lane is a fallback for
// the other, which means `docs/distribution.md`'s "try before you grant" shape
// needs restating for this surface: an ungranted Safari server is not a slower
// Safari server, it is a different and much smaller one.
//
// The four questions:
//
//     1. WHAT DOES History.db ACTUALLY HOLD? Schema, visit counts, and the
//        epoch on `visit_time` — Core Data seconds since 2001, which renders as
//        a plausible date when read as Unix seconds and is wrong by 31 years.
//     2. WHERE IS THE READING LIST? It is not its own file: it lives inside
//        Bookmarks.plist as a folder named `com.apple.ReadingList`. A server
//        that looks for a database will not find it.
//     3. IS `do JavaScript` REACHABLE? It needs Safari's "Allow JavaScript from
//        Apple Events" developer toggle — a THIRD permission state beyond Full
//        Disk Access and Automation, and one `apps/apple/Cupertino/Permissions.swift`
//        does not model. If Safari ships, that file grows a case.
//     4. CAN A LIVE TAB BE ENRICHED FROM HISTORY? The two lanes only compose if
//        an open tab can be tied to its history row. The join key is the URL
//        itself, which is unusual and worth confirming rather than assuming.
//
// THE APPLE EVENTS HALF RUNS WITHOUT FULL DISK ACCESS.
//
// Dependency-free (node builtins + scripts/lib/probe-kit.mjs). Databases are
// opened read-only and NEVER written to. Bookmarks.plist is converted with
// `plutil` to a temporary in-memory JSON string, never rewritten.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, booleans, column
// names and DDL only. NO URLS, no page titles, no domains, no search terms.
// Browsing history is the most re-identifying data any of these surfaces holds —
// a single URL can name a person, an employer and a medical condition — so URLs
// are masked to a shape (`https://<host>/<2 segments>`) before they can reach
// the report, and never printed whole.
//
//   node scripts/probe-safari.mjs                 # human-readable report
//   node scripts/probe-safari.mjs --json          # the raw document
//   node scripts/probe-safari.mjs --term=docs     # word for the search timing
//   node scripts/probe-safari.mjs --launch        # allow launching Safari
//   node scripts/probe-safari.mjs --write         # also write the schema fixture

import { execFileSync } from "node:child_process";
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
  openStore,
  parseArgs,
  safe,
  tableTools,
  timed,
  writeFixture,
  yn,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TERM = args.term;

const SAFARI_DIR = join(homedir(), "Library", "Safari");
const HISTORY_DB = join(SAFARI_DIR, "History.db");
const BOOKMARKS = join(SAFARI_DIR, "Bookmarks.plist");
const CLOUD_TABS = join(SAFARI_DIR, "CloudTabs.db");
const DOWNLOADS = join(SAFARI_DIR, "Downloads.plist");

const tilde = (p) => p.replace(homedir(), "~");

/**
 * A URL reduced to its shape. Host is dropped entirely — it is the most
 * identifying part — leaving only scheme, host length and path depth, which is
 * all a schema discussion ever needs.
 */
const maskUrl = (u) => {
  const s = String(u ?? "");
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(s);
  if (!m) return `<${s.length} chars, no scheme>`;
  const segments = m[3].split("/").filter(Boolean).length;
  return `${m[1]}://<host:${m[2].length}>/${segments === 0 ? "" : `<${segments} segments>`}`;
};

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

// ─── Lane 1: Apple Events — the present tense ───────────────────────────────

/** Live windows and tabs. Counts and URL SHAPES only; nothing is printed whole. */
const LIVE_TABS = `
function run(argv) {
  var S = Application("Safari");
  var wins = S.windows();
  var tabs = 0;
  var urls = [];
  for (var i = 0; i < wins.length; i++) {
    var ts = [];
    try { ts = wins[i].tabs(); } catch (e) { ts = []; }
    tabs += ts.length;
    for (var j = 0; j < ts.length; j++) {
      try {
        var u = ts[j].url();
        if (u) urls.push(String(u));
      } catch (e) {}
    }
  }
  return JSON.stringify({ windows: wins.length, tabs: tabs, urls: urls });
}
`;

/**
 * `do JavaScript` on the front tab, with the most inert expression available.
 *
 * `1 + 1` touches nothing, navigates nowhere and leaves no trace. The point is
 * not the answer — it is the ERROR, which is how Safari reports that the
 * developer toggle is off, and that error text is what a diagnostics tool would
 * have to recognise.
 */
const DO_JAVASCRIPT = `
function run(argv) {
  var S = Application("Safari");
  var wins = S.windows();
  if (!wins.length) return JSON.stringify({ attempted: false, reason: "no open window" });
  var result = S.doJavaScript("1 + 1", { in: wins[0].currentTab() });
  return JSON.stringify({ attempted: true, ok: true, result: String(result) });
}
`;

// Skippable, not fatal: History.db and the Reading List are readable whether or
// not Safari is open, and they are most of what this surface is worth.
const aeLane = appleEventsLane("com.apple.Safari", "Safari", args.launch);
doc.findings.appleEventsLane = aeLane;

doc.findings.liveTabs = aeLane.available
  ? timed("liveTabs", LIVE_TABS, {}, 60_000)
  : { ok: false, skipped: true, reason: aeLane.reason };
const liveUrls = doc.findings.liveTabs?.urls ?? [];
// Shapes only, from here on. The raw list stays in memory for the bridge scan
// and is deleted from the document before anything can serialise it.
doc.findings.liveTabs = {
  ok: doc.findings.liveTabs?.ok ?? false,
  ms: doc.findings.liveTabs?.ms ?? null,
  windows: doc.findings.liveTabs?.windows ?? null,
  tabs: doc.findings.liveTabs?.tabs ?? null,
  urlShapes: liveUrls.slice(0, 5).map(maskUrl),
  skipped: doc.findings.liveTabs?.skipped ?? false,
  error: doc.findings.liveTabs?.error ?? null,
};

/**
 * The developer toggle, read rather than triggered.
 *
 * Asking `defaults` is a read; calling `do JavaScript` when the toggle is off
 * produces a user-visible failure. So check the preference first and only
 * attempt the call when it says yes — the probe should not be the thing that
 * teaches someone their browser can be scripted.
 *
 * Reading Safari's domain is itself TCC-protected on recent macOS, so a failure
 * here means "unknown", not "off".
 */
doc.findings.javaScriptToggle = safe(
  () => {
    const raw = execFileSync(
      "/usr/bin/defaults",
      ["read", "com.apple.Safari", "AllowJavaScriptFromAppleEvents"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return { readable: true, enabled: raw === "1" };
  },
  () => ({
    readable: false,
    enabled: null,
    reason: "preference not readable (Safari's container is TCC-protected)",
  }),
);

doc.findings.doJavaScript =
  aeLane.available && doc.findings.javaScriptToggle.enabled === true
    ? timed("doJavaScript", DO_JAVASCRIPT, {}, 30_000)
    : {
        skipped: true,
        reason:
          doc.findings.javaScriptToggle.enabled === false
            ? "toggle is off — not attempted, because the failure would be user-visible"
            : aeLane.available
              ? "toggle state unknown — not attempted"
              : aeLane.reason,
      };

// ─── Lane 2: the file lane — the past tense ─────────────────────────────────

doc.findings.files = {
  dirListable: listable(SAFARI_DIR),
  history: { ...fileFacts(HISTORY_DB), path: tilde(HISTORY_DB) },
  bookmarks: { ...fileFacts(BOOKMARKS), path: tilde(BOOKMARKS) },
  cloudTabs: { ...fileFacts(CLOUD_TABS), path: tilde(CLOUD_TABS) },
  downloads: { ...fileFacts(DOWNLOADS), path: tilde(DOWNLOADS) },
};

/**
 * Q2. The Reading List, which is NOT a database.
 *
 * It lives inside Bookmarks.plist as a folder whose Title is the literal
 * `com.apple.ReadingList`, and its entries carry a `ReadingList` dictionary with
 * `DateAdded` and, once opened, `DateLastViewed`. That last field is the whole
 * unread/read distinction, and it is the reason a Reading List tool is worth
 * having at all.
 *
 * REDACTION: this walks the entire bookmark tree and retains COUNTS ONLY. No
 * title, no URL and no preview text is ever copied out of the parsed structure.
 */
/**
 * The bookmark tree, walked as a native object graph.
 *
 * The obvious approach — `plutil -convert json` — FAILS on this file:
 *
 *     Bookmarks.plist: Invalid object in plist for JSON format
 *
 * Reading List entries carry `NSData` (preview images), and JSON has no
 * representation for it, so the whole conversion aborts. Converting to XML and
 * regexing it would work for counting fixed literals but cannot track nesting,
 * and nesting is the entire question: which leaves sit UNDER the Reading List
 * folder.
 *
 * So read the plist as an `NSDictionary` through the osascript boundary already
 * in use for everything else, and walk it with `objectForKey`/`objectAtIndex`.
 * The data keys are simply never touched, so their unrepresentability stops
 * mattering. osascript inherits Full Disk Access from whatever launched it,
 * exactly as the rest of the file lane does.
 *
 * REDACTION: counts only. No title, no URL and no preview text is copied out.
 */
const BOOKMARKS_WALK = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("Foundation");
  var root = $.NSDictionary.dictionaryWithContentsOfFile(p.path);
  if (!root || root.isNil()) return JSON.stringify({ ok: false, error: "plist could not be read" });

  var folders = 0, leaves = 0, maxDepth = 0;
  var rl = { found: false, items: 0, unread: 0, withPreview: 0 };

  function str(dict, key) {
    var v = dict.objectForKey(key);
    if (!v || v.isNil()) return null;
    try { return ObjC.unwrap(v); } catch (e) { return null; }
  }
  function has(dict, key) {
    var v = dict.objectForKey(key);
    return Boolean(v) && !v.isNil();
  }

  function walk(node, depth, within) {
    if (!node || node.isNil()) return;
    if (depth > maxDepth) maxDepth = depth;

    var type = str(node, "WebBookmarkType");
    // The container is identified by a fixed literal, never a user-facing name.
    var isReadingList = str(node, "Title") === "com.apple.ReadingList";
    if (isReadingList) rl.found = true;
    var inReadingList = within || isReadingList;

    if (type === "WebBookmarkTypeLeaf") {
      leaves++;
      if (inReadingList) {
        rl.items++;
        var d = node.objectForKey("ReadingList");
        if (d && !d.isNil()) {
          if (!has(d, "DateLastViewed")) rl.unread++;
          if (has(d, "PreviewText")) rl.withPreview++;
        }
      }
    } else if (type === "WebBookmarkTypeList") {
      folders++;
    }

    var kids = node.objectForKey("Children");
    if (kids && !kids.isNil()) {
      var n = kids.count;
      for (var i = 0; i < n; i++) walk(kids.objectAtIndex(i), depth + 1, inReadingList);
    }
  }
  walk(root, 0, false);
  return JSON.stringify({ ok: true, folders: folders, leaves: leaves, maxDepth: maxDepth,
                          readingList: rl });
}
`;

// Gated on the FILE being readable, not on Safari running: this talks to
// Foundation, not to Safari, so it needs Full Disk Access and no Automation.
doc.findings.bookmarks = !doc.findings.files.bookmarks.readable
  ? {
      tested: false,
      reason: doc.findings.files.bookmarks.exists
        ? "Bookmarks.plist exists but is not readable — Full Disk Access is not granted"
        : "Bookmarks.plist not present",
    }
  : (() => {
      const r = timed("bookmarks", BOOKMARKS_WALK, { path: BOOKMARKS }, 60_000);
      if (!r.ok) return { tested: false, reason: `walk failed: ${r.error}` };
      if (!r.readingList)
        return { tested: false, reason: r.error ?? "plist walk returned nothing" };
      return {
        tested: true,
        ms: r.ms,
        folders: r.folders,
        leaves: r.leaves,
        maxDepth: r.maxDepth,
        readingList: r.readingList,
      };
    })();

let ddlRows = null;
let opened = null;
if (doc.findings.files.history.readable) opened = openStore(HISTORY_DB);

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
  const hasTable = (t) => tables.includes(t);
  const colsOf = (t) => columnInfo(t).map((c) => c.name);

  doc.findings.tableCounts = Object.fromEntries(tables.map((t) => [t, countOf(t)]));

  /** Q1. The shape every third-party History.db reader assumes. Confirm it. */
  doc.findings.historyShape = {
    historyItems: hasTable("history_items"),
    historyVisits: hasTable("history_visits"),
    itemColumns: colsOf("history_items"),
    visitColumns: colsOf("history_visits"),
    tombstones: hasTable("history_tombstones"),
  };

  /**
   * Q1 continued. Epoch on `visit_time`.
   *
   * Core Data seconds since 2001. Read as Unix seconds it lands in 1970-something
   * — obviously wrong. But read the OTHER way round, a Unix timestamp treated as
   * Core Data lands 31 years in the future, which is exactly the error that
   * survives review because nobody scrolls to the year.
   */
  doc.findings.epoch = safe(() => {
    if (!hasTable("history_visits")) return { tested: false, reason: "no history_visits table" };
    const m = one("SELECT MAX(visit_time) AS m FROM history_visits");
    return { table: "history_visits", column: "visit_time", ...detectEpoch(m?.m) };
  });

  /** Q1 continued. Volume and search cost — the numbers that price the lane. */
  doc.findings.search = safe(() => {
    if (!hasTable("history_items")) return { tested: false, reason: "no history_items table" };
    const items = countOf("history_items");
    const visits = hasTable("history_visits") ? countOf("history_visits") : null;

    const urlStart = performance.now();
    const urlHits = one(
      "SELECT COUNT(*) AS c FROM history_items WHERE url LIKE ? ESCAPE '\\'",
      `%${TERM}%`,
    );
    const urlMs = Math.round(performance.now() - urlStart);

    const titleStart = performance.now();
    const titleHits = hasTable("history_visits")
      ? one("SELECT COUNT(*) AS c FROM history_visits WHERE title LIKE ? ESCAPE '\\'", `%${TERM}%`)
      : null;
    const titleMs = Math.round(performance.now() - titleStart);

    return {
      tested: true,
      historyItems: items,
      historyVisits: visits,
      urlSearchMs: urlMs,
      urlHits: urlHits?.c ?? null,
      titleSearchMs: titleMs,
      titleHits: titleHits?.c ?? null,
      indexes: all("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name).length,
    };
  });

  /**
   * Q4. THE JOIN. Can an open tab be enriched from history?
   *
   * Safari's bridge is unusual: there is no opaque id shared between the lanes,
   * only the URL. That makes the join trivially available and trivially fragile
   * — a tab whose page redirected, or whose URL carries a session parameter, has
   * a URL that never appears in history. So this measures the HIT RATE across
   * every open tab rather than proving a single match, because the failure mode
   * is partial, not total.
   */
  doc.findings.tabBridge = safe(() => {
    if (!liveUrls.length) return { tested: false, reason: "no open tabs to join" };
    if (!hasTable("history_items")) return { tested: false, reason: "no history_items table" };
    let matched = 0;
    let prefixOnly = 0;
    for (const u of liveUrls) {
      const exact = one("SELECT COUNT(*) AS c FROM history_items WHERE url = ?", u);
      if (exact?.c) {
        matched += 1;
        continue;
      }
      // Fall back to origin+path, dropping the query string — the usual reason
      // an exact match fails, and the shape a real lookup would have to use.
      const trimmed = u.split(/[?#]/)[0];
      const near = one(
        "SELECT COUNT(*) AS c FROM history_items WHERE url LIKE ? ESCAPE '\\'",
        `${trimmed.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
      );
      if (near?.c) prefixOnly += 1;
    }
    return {
      tested: true,
      tabs: liveUrls.length,
      exactMatches: matched,
      prefixMatches: prefixOnly,
      unmatched: liveUrls.length - matched - prefixOnly,
      // Also run the generic scan, so the doc can say which columns hold a URL.
      columnScan: findIdBridge(db, tables, columnInfo, [{ form: "tab url", value: liveUrls[0] }]),
    };
  });

  /**
   * What the file lane buys that Apple Events cannot see at any speed. Unlike
   * the other surfaces this is not a capability list so much as a TENSE list:
   * everything here is about the past, which the live lane has no access to.
   */
  doc.findings.capabilities = safe(() => {
    const probes = {
      visitTimestamps: { table: "history_visits", cols: /visit_time/i },
      visitCounts: { table: "history_items", cols: /visit_count/i },
      redirects: { table: "history_visits", cols: /redirect/i },
      pageTitles: { table: "history_visits", cols: /^title$/i },
      loadOutcome: { table: "history_visits", cols: /load_successful|http_non_get/i },
      syncedDeletions: { table: "history_tombstones", cols: /./ },
      attributedTo: { table: "history_visits", cols: /origin|attributed/i },
    };
    const out = {};
    for (const [key, p] of Object.entries(probes)) {
      const matched = hasTable(p.table) ? colsOf(p.table).filter((c) => p.cols.test(c)) : [];
      out[key] = { table: p.table, columns: matched, present: matched.length > 0 };
    }
    return out;
  });

  db.close();
} else {
  doc.findings.open = { ok: false, error: opened?.error ?? null };
  // Both of these are file-lane answers, and the file lane did not open. Saying
  // so beats leaving them undefined, which renders as "not tested: undefined".
  const noLane = doc.findings.files.history.readable
    ? "the history store did not open"
    : "History.db is not readable — Full Disk Access is not granted";
  doc.findings.tabBridge = { tested: false, reason: noLane };
  doc.findings.search = { tested: false, reason: noLane };
}

if (!opened?.db && doc.findings.files.history.exists) {
  doc.notes.push(
    doc.findings.files.history.readable
      ? `History.db is readable but SQLite refused both open modes: ${opened?.error ?? "unknown"}.`
      : "History.db exists and cannot be opened — Full Disk Access is not granted to this terminal. " +
          "The Apple Events half above still ran, and for Safari that half is not a degraded version " +
          "of the same server: it is a different one, with no history and no Reading List.",
  );
}

// ─── Verdict ────────────────────────────────────────────────────────────────

const s = doc.findings.search ?? {};
const bm = doc.findings.bookmarks ?? {};
const bridge = doc.findings.tabBridge ?? {};
const caps = doc.findings.capabilities ?? {};

const joinRate =
  bridge.tested && bridge.tabs
    ? Number((((bridge.exactMatches + bridge.prefixMatches) / bridge.tabs) * 100).toFixed(1))
    : null;

doc.verdict = {
  fullDiskAccessGranted: Boolean(opened?.db),
  automationTested: aeLane.available,
  automationWorked: doc.findings.liveTabs.ok,
  openTabs: doc.findings.liveTabs.tabs,
  historyItems: s.historyItems ?? null,
  historyVisits: s.historyVisits ?? null,
  urlSearchMs: s.urlSearchMs ?? null,
  titleSearchMs: s.titleSearchMs ?? null,
  readingListFound: bm.readingList?.found ?? null,
  readingListItems: bm.readingList?.items ?? null,
  readingListUnread: bm.readingList?.unread ?? null,
  javaScriptToggle: doc.findings.javaScriptToggle,
  capabilitiesGained: Object.entries(caps)
    .filter(([, v]) => v.present)
    .map(([k]) => k),
  tabJoinRate: joinRate,
  // The finding that turns into a Permissions.swift change if Safari ships.
  thirdPermissionState:
    "Safari needs THREE permission states, not two: Full Disk Access (history, bookmarks), " +
    "Automation for com.apple.Safari (live tabs), and the 'Allow JavaScript from Apple Events' " +
    "developer toggle (do JavaScript). apps/apple/Cupertino/Permissions.swift models only the first two, " +
    "so shipping Safari means teaching it a third — otherwise diagnostics will report a healthy " +
    "surface whose most powerful verb silently fails.",
  recommendation: !opened?.db
    ? "History unavailable — grant Full Disk Access and re-run. Note that the Apple Events half is " +
      "NOT a fallback here: it sees only open tabs, so an ungranted Safari server is a different " +
      "product rather than a slower one, and docs/distribution.md's 'try before you grant' framing " +
      "needs a caveat for this surface."
    : `${s.historyItems} history items searched by URL in ${s.urlSearchMs} ms and by title in ${s.titleSearchMs} ms. ` +
      `The file lane is cheap and the store is small — no index-vs-Apple-Events tradeoff to litigate here, ` +
      `because the two lanes see disjoint things.`,
  joinVerdict:
    joinRate === null
      ? bridge.reason
        ? `Not measured — ${bridge.reason}.`
        : "Not measured — no open tabs."
      : joinRate === 100
        ? `All ${bridge.tabs} open tabs resolved to a history row (${bridge.exactMatches} exact, ${bridge.prefixMatches} after dropping the query string). The lanes compose.`
        : `Only ${joinRate}% of open tabs resolved to a history row (${bridge.unmatched} of ${bridge.tabs} unmatched). ` +
          `The URL is the only join key Safari offers and it is lossy — a tool that enriches a tab from history ` +
          `must treat a miss as normal, not as an error.`,
};

// The raw tab URLs never reach the document. Belt and braces before serialising.
delete doc.findings.liveTabs.urls;

// ─── Report ─────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Safari probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(`Search term: ${JSON.stringify(TERM)}   Safari was running: ${yn(aeLane.running)}`);
  L.push("");
  L.push("Apple Events lane — the present tense (Automation only)");
  if (!aeLane.available) L.push(`  SKIPPED               ${aeLane.reason}`);
  L.push(
    `  windows / tabs        ${doc.findings.liveTabs.windows ?? "?"} / ${doc.findings.liveTabs.tabs ?? "?"}  in ${doc.findings.liveTabs.ms ?? "?"} ms`,
  );
  for (const shape of doc.findings.liveTabs.urlShapes ?? [])
    L.push(`     tab shape          ${shape}`);
  L.push(
    `  JS-from-AppleEvents   toggle ${doc.findings.javaScriptToggle.readable ? (doc.findings.javaScriptToggle.enabled ? "ON" : "OFF") : "unknown"}` +
      `${doc.findings.javaScriptToggle.reason ? `  (${doc.findings.javaScriptToggle.reason})` : ""}`,
  );
  L.push(
    `  do JavaScript         ${
      doc.findings.doJavaScript.skipped
        ? `skipped — ${doc.findings.doJavaScript.reason}`
        : doc.findings.doJavaScript.ok
          ? `works (${doc.findings.doJavaScript.ms} ms)`
          : `FAILED  ${doc.findings.doJavaScript.error}`
    }`,
  );
  L.push("");
  L.push("File lane — the past tense (Full Disk Access)");
  for (const [k, f] of Object.entries(doc.findings.files)) {
    if (k === "dirListable") continue;
    L.push(
      `  ${k.padEnd(12)} ${f.path.padEnd(34)} exists=${yn(f.exists)} readable=${yn(f.readable)} ${String(f.sizeBytes ?? "?").padStart(9)} B`,
    );
  }
  if (opened?.db) {
    L.push(
      `  opened                ${doc.findings.open.mode} in ${doc.findings.open.ms} ms${doc.findings.open.walBlind ? "   (WAL-BLIND)" : ""}`,
    );
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  objects               ${doc.findings.schema.objectCount} (${doc.findings.schema.tables.length} tables)`,
    );
    L.push(`  history items         ${s.historyItems ?? "?"}`);
    L.push(`  history visits        ${s.historyVisits ?? "?"}`);
    L.push(`  url LIKE search       ${s.urlSearchMs ?? "?"} ms  (${s.urlHits ?? "?"} hits)`);
    L.push(`  title LIKE search     ${s.titleSearchMs ?? "?"} ms  (${s.titleHits ?? "?"} hits)`);
    L.push(
      `  epoch                 ${doc.findings.epoch?.epoch ?? doc.findings.epoch?.reason ?? "?"}` +
        `${doc.findings.epoch?.latestYear ? `  (latest visit ${doc.findings.epoch.latestYear})` : ""}`,
    );
    L.push("");
    L.push("  WHAT THE FILE LANE BUYS (invisible to the live lane at any speed)");
    for (const [k, v] of Object.entries(caps)) {
      L.push(
        `     ${k.padEnd(18)} ${v.present ? "PRESENT" : "absent "}  ${v.columns.join(", ") || "-"}`,
      );
    }
  }
  L.push("");
  L.push("READING LIST — inside Bookmarks.plist, not a database");
  if (bm.tested) {
    L.push(`  bookmark folders      ${bm.folders}`);
    L.push(`  bookmark leaves       ${bm.leaves}  (tree depth ${bm.maxDepth})`);
    L.push(`  reading list found    ${yn(bm.readingList.found)}`);
    L.push(
      `  reading list items    ${bm.readingList.items}  (${bm.readingList.unread} unread, ${bm.readingList.withPreview} with preview text)`,
    );
  } else {
    L.push(`  not tested            ${bm.reason}`);
  }
  L.push("");
  L.push("TAB → HISTORY JOIN — the only key Safari offers is the URL itself");
  if (bridge.tested) {
    L.push(`  open tabs             ${bridge.tabs}`);
    L.push(`  exact url match       ${bridge.exactMatches}`);
    L.push(`  match after ?-strip   ${bridge.prefixMatches}`);
    L.push(`  unmatched             ${bridge.unmatched}`);
    const scanHits = bridge.columnScan?.hits ?? [];
    for (const h of scanHits) L.push(`  url column            ${h.table}.${h.column}`);
    if (!scanHits.length) L.push(`  url column            none found by scan`);
  } else {
    L.push(`  not tested            ${bridge.reason}`);
  }
  L.push("");
  L.push("VERDICT");
  L.push(`  lanes      : ${doc.verdict.recommendation}`);
  L.push(`  join       : ${doc.verdict.joinVerdict}`);
  L.push(`  permissions: ${doc.verdict.thirdPermissionState}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "safari",
    file: "safari-history.sql",
    ddlRows,
    macos: doc.macos,
    fingerprint: doc.findings.schema?.fingerprint,
    tool: "scripts/probe-safari.mjs",
  });
}
