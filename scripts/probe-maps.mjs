#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-maps.
//
// ── HOW THIS SURFACE WAS NEARLY LOST ─────────────────────────────────────────
//
// Maps was declared "no file lane" three times before the store was found. Each
// time the reasoning was wrong in a way `docs/surfaces.md` already warns about,
// and all three failures share one cause: a probing process WITHOUT Full Disk
// Access cannot tell an empty directory from a forbidden one.
//
//   1. `find` over the group container returned only the directory itself. That
//      was read as "empty". It was EPERM.
//   2. A sweep for `*.db` / `*.sqlite*` missed the store because **it has no
//      file extension**: `MapsSync_0.0.1`. Search by MAGIC BYTES, not by name.
//   3. `Data/Maps/` — the one directory that holds everything — was the single
//      unreadable directory in the container, and its absence from the listing
//      read as absence of data.
//
// The store is `~/Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1`,
// a 3.3 MB Core Data store with 54 entities, of which these carry the surface:
//
//     FavoriteItem 23   Collection 10   CollectionItem 29
//     HistoryItem  33   MixinMapItem 68  ReviewedPlace 24   UserRoute 3
//
// There is NO Apple Events lane — Maps.app ships no `.sdef`, checked directly.
// So this is a file-lane-only surface, like Contacts' read path, and unlike
// every other surface it has no second lane to degrade to.
//
// ── THE QUESTIONS ────────────────────────────────────────────────────────────
//
//     0. CAN THIS PROCESS SEE THE STORE AT ALL? Asked first, and a failure here
//        stops the run. See above for why that is not paranoia.
//     1. WHERE DOES A PLACE'S NAME AND COORDINATE LIVE? The Accessibility lane
//        yielded neither, which is what disqualified it. If the file lane has
//        real columns for both, that is the whole argument for this surface.
//     2. WHAT IS THE ID BRIDGE? `FavoriteItem` almost certainly does not hold a
//        place; it references one. Which entity, and by which key, decides
//        whether the surface is one query or an unjoinable pile.
//     3. IS THE PAYLOAD A BLOB? Notes hid its body in gzipped protobuf and
//        Messages in a typedstream. If place data is a blob here, that is a
//        decoder project and it must be known NOW, not after the package exists.
//     4. WHAT EPOCH ARE THE DATES? Core Data seconds since 2001, which read as
//        plausible-but-wrong dates if treated as Unix. `docs/surfaces.md` calls
//        dates the richest source of silent errors.
//     5. HOW WAL-BLIND IS IT? The spike flagged this store WAL-BLIND. A read
//        that cannot see the WAL misses exactly the recent changes a user will
//        test the tool with first.
//     6. WHAT DOES A READ COST? For comparison against the 14 s the
//        Accessibility lane needed for less data.
//
// PRIVACY. Schema, column names, row counts, null counts and value LENGTHS.
// It never prints a place name, an address, or a coordinate — not even a range,
// because a bounding box around someone's favourites is their home town and a
// latitude to three decimals is their street. Coordinate columns are reported as
// "present, N non-null", never as numbers.
//
//   node scripts/probe-maps.mjs           # human-readable report
//   node scripts/probe-maps.mjs --json
//   node scripts/probe-maps.mjs --write   # capture the schema fixture

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectEpoch,
  dumpSchema,
  fileFacts,
  isTextType,
  looksLikeDateColumn,
  macosVersion,
  maxNumericAsText,
  openStore,
  parseArgs,
  safe,
  writeFixture,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const H = homedir();

const DEFAULT_STORE = join(
  H,
  "Library",
  "Containers",
  "com.apple.Maps",
  "Data",
  "Maps",
  "MapsSync_0.0.1",
);
// `--store=` points this at a synthetic fixture so the code path can be exercised
// on a machine with no Full Disk Access. The blind gate below applies only to the
// real store: a caller who names a path has already answered the question it asks.
const STORE = args.valueOf("store", DEFAULT_STORE);
const USING_DEFAULT = STORE === DEFAULT_STORE;
const LOCAL_CACHE = `${STORE}_deviceLocalCache.db`;
// Gated, and known to exist because shipped surfaces read them daily. If these
// are unreadable the run is blind and must say so rather than report a negative.
const CONTROLS = {
  safari: join(H, "Library", "Safari", "History.db"),
  messages: join(H, "Library", "Messages", "chat.db"),
};

// The entities that carry the surface. Core Data prefixes tables with Z and
// upper-cases the entity name.
const CORE = [
  "FavoriteItem",
  "Collection",
  "CollectionItem",
  "HistoryItem",
  "MixinMapItem",
  "ReviewedPlace",
  "UserRoute",
];
const tableFor = (entity) => `Z${entity.toUpperCase()}`;

// ─── Q0 ──────────────────────────────────────────────────────────────────────

const controls = Object.fromEntries(Object.entries(CONTROLS).map(([k, p]) => [k, fileFacts(p)]));
const blind = Object.values(controls).some((c) => c.exists && !c.readable);

const store = fileFacts(STORE);
const wal = fileFacts(`${STORE}-wal`);

if (USING_DEFAULT && (blind || !store.readable)) {
  const doc = {
    tool: "scripts/probe-maps.mjs",
    blind,
    controls,
    store,
    verdict: blind
      ? "BLIND — this process cannot read stores that shipped surfaces read daily. Grant Full Disk Access and re-run. A negative from here means nothing."
      : "the store is present but not readable — grant Full Disk Access and re-run",
  };
  console.log(args.json ? JSON.stringify(doc, null, 2) : `Maps probe\n\n  ${doc.verdict}`);
  process.exit(3);
}

// ─── open ────────────────────────────────────────────────────────────────────

const opened = openStore(STORE);
if (!opened?.db) {
  console.error(`could not open the store: ${opened?.error ?? "unknown"}`);
  process.exit(4);
}
const db = opened.db;
const schema = dumpSchema(db);
const { ddlRows, fingerprint, objectCount } = schema;

/**
 * probe-kit's `safe(fn, onErr)` takes an error HANDLER, not a fallback value —
 * passing `[]` makes it try to CALL the array, and passing `null` makes it fall
 * through to a `{ok:false}` object that is not the empty value the caller meant.
 * This wrapper gives the value semantics the call sites here actually want.
 */
const attempt = (fn, fallback = null) => safe(fn, () => fallback);

const columnsOf = (table) => attempt(() => db.prepare(`PRAGMA table_info("${table}")`).all(), []);
const countOf = (table) => attempt(() => db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c);
const nonNull = (table, col) =>
  attempt(() => db.prepare(`SELECT COUNT("${col}") c FROM "${table}"`).get().c);

// Q1 + Q2 + Q3, asked per entity and answered in SHAPES only.
const NAMEISH = /NAME|TITLE|LABEL|DISPLAY/i;
const COORDISH = /LAT|LON|LNG|COORD|LONGITUDE|LATITUDE/i;
const ADDRISH = /ADDRESS|STREET|LOCALITY|THOROUGHFARE|CITY|COUNTRY|POSTAL/i;

const entities = CORE.map((entity) => {
  const table = tableFor(entity);
  const cols = columnsOf(table);
  if (!cols.length) return { entity, table, present: false };
  const rows = countOf(table);
  const describe = (col) => ({
    name: col.name,
    type: col.type,
    nonNull: rows ? nonNull(table, col.name) : 0,
  });
  return {
    entity,
    table,
    present: true,
    rows,
    columnCount: cols.length,
    // Q1
    nameColumns: cols.filter((c) => NAMEISH.test(c.name)).map(describe),
    coordColumns: cols.filter((c) => COORDISH.test(c.name)).map(describe),
    addressColumns: cols.filter((c) => ADDRISH.test(c.name)).map(describe),
    // Q2 — CAUTION: Core Data names a foreign key after the RELATIONSHIP, not
    // the entity, so `ZMAPITEM` points at MixinMapItem and no naming rule can
    // tell it apart from a scalar like `ZHIDDEN` or `ZRATING`. These are simply
    // the integer columns; which of them actually JOIN is answered by the
    // idBridge section below, by running the join and counting matches.
    integerColumns: cols
      .filter(
        (c) =>
          /^Z[A-Z]+$/.test(c.name) && /INTEGER/i.test(c.type ?? "") && !c.name.startsWith("Z_"),
      )
      .filter((c) => !["ZPK", "ZENT", "ZOPT"].includes(c.name))
      .map(describe),
    // Q3
    blobColumns: cols.filter((c) => /BLOB/i.test(c.type ?? "")).map(describe),
    // Q4
    dateColumns: cols.filter((c) => looksLikeDateColumn(c.name, c.type)).map(describe),
    textColumns: cols.filter((c) => isTextType(c.type)).length,
  };
});

/**
 * Q2, answered by JOINING rather than by reading names.
 *
 * `docs/surfaces.md`: "Ask the id-bridge question early. Whether a store row can
 * be joined to the identifier Apple Events returns decides whether the surface
 * has two lanes or two disconnected halves." There is no Apple Events lane here,
 * but the same question decides whether a favourite can reach its place.
 */
const idBridge = ["ZFAVORITEITEM", "ZCOLLECTIONITEM", "ZHISTORYITEM", "ZREVIEWEDPLACE"]
  .map((table) => {
    const rows = countOf(table);
    if (!rows) return null;
    const linked = attempt(
      () =>
        db
          .prepare(
            `SELECT COUNT(*) c FROM "${table}" t JOIN "ZMIXINMAPITEM" m ON m.Z_PK = t.ZMAPITEM`,
          )
          .get().c,
    );
    return linked == null ? { table, rows, joins: false } : { table, rows, linked, joins: true };
  })
  .filter(Boolean);

// Q4: the 2001 anchor, tested on the busiest date column available.
const dateProbe = (() => {
  for (const e of entities) {
    if (!e.present || !e.rows) continue;
    for (const d of e.dateColumns ?? []) {
      if (!d.nonNull) continue;
      // maxNumericAsText returns {raw, digits, value, exceedsSafeInteger} — the
      // object exists BECAUSE of the overflow trap: node:sqlite throws on an
      // INTEGER too large for a JS double, which is the common case for
      // nanosecond epochs, so the reading is carried as TEXT and reported.
      const max = maxNumericAsText(db, e.table, d.name);
      if (max?.value == null) continue;
      const verdict = detectEpoch(max.value);
      return {
        table: e.table,
        column: d.name,
        digits: max.digits,
        exceedsSafeInteger: max.exceedsSafeInteger,
        ...verdict,
      };
    }
  }
  return { reason: "no populated date column found" };
})();

// Q6
const timed = (label, fn) => {
  const t = performance.now();
  const value = attempt(fn);
  return { label, ms: Math.round(performance.now() - t), value };
};
const timings = [
  timed("count favourites", () => countOf("ZFAVORITEITEM")),
  timed("join favourites -> map items", () =>
    attempt(
      () =>
        db
          .prepare(
            'SELECT COUNT(*) c FROM "ZFAVORITEITEM" f LEFT JOIN "ZMIXINMAPITEM" m ON m.Z_PK = f.ZMAPITEM',
          )
          .get().c,
    ),
  ),
  timed("all history rows", () => countOf("ZHISTORYITEM")),
];

const localCache = fileFacts(LOCAL_CACHE);

const doc = {
  tool: "scripts/probe-maps.mjs",
  macos: macosVersion(),
  node: process.version,
  at: new Date().toISOString(),
  findings: {
    store: {
      ...store,
      openMode: opened.mode,
      // openStore already timed the open and judged WAL-blindness; taking a
      // second opinion here is how the two disagree later.
      openMs: opened.openMs,
      walBytes: wal.sizeBytes,
      walBlind: opened.walBlind,
    },
    localCache: { path: localCache.path, sizeBytes: localCache.sizeBytes },
    schema: { fingerprint, objectCount },
    entities,
    idBridge,
    dateProbe,
    timings,
  },
  verdict: {},
  notes: [],
};

const withCoords = entities.filter((e) => e.present && (e.coordColumns?.length ?? 0) > 0);
const withNames = entities.filter((e) => e.present && (e.nameColumns?.length ?? 0) > 0);
const withBlobs = entities.filter((e) => e.present && (e.blobColumns?.length ?? 0) > 0);

doc.verdict.lane = "file lane only — Maps.app ships no .sdef, so there is no Apple Events lane";
doc.verdict.coordinates = withCoords.length
  ? `PRESENT as real columns in ${withCoords.map((e) => e.entity).join(", ")}`
  : "NOT found as columns — check the blob columns, place data may be encoded";
doc.verdict.names = withNames.length
  ? `present in ${withNames.map((e) => e.entity).join(", ")}`
  : "no name-shaped column — likely inside a blob";
doc.verdict.blobs = withBlobs.length
  ? `blob columns in ${withBlobs.map((e) => `${e.entity}(${e.blobColumns.map((b) => b.name).join(",")})`).join(", ")} — decoder work`
  : "no blob columns: the data is in ordinary columns";
doc.verdict.walBlind = doc.findings.store.walBlind
  ? `WAL (${wal.sizeBytes} B) EXCEEDS the store (${store.sizeBytes} B) — an immutable read misses recent changes`
  : "wal is smaller than the store";
doc.verdict.epoch = dateProbe.epoch ?? dateProbe.reason ?? "unknown";

if (opened.mode === "immutable")
  doc.notes.push(
    "opened immutable: the live store was locked, so this reading may lag what Maps has written",
  );

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Maps probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(`Store: ${store.sizeBytes} B, opened ${opened.mode} in ${opened.openMs} ms`);
  L.push(`Schema fingerprint ${fingerprint}, ${objectCount} objects`);
  L.push("");
  L.push("ENTITIES — shapes only, never a place");
  for (const e of entities) {
    if (!e.present) {
      L.push(`  ${e.entity.padEnd(18)} ABSENT (${e.table})`);
      continue;
    }
    L.push(`  ${e.entity.padEnd(18)} ${String(e.rows).padStart(5)} rows  ${e.columnCount} cols`);
    const show = (label, list) => {
      if (!list?.length) return;
      L.push(
        `      ${label.padEnd(10)} ${list.map((c) => `${c.name}(${c.nonNull}/${e.rows})`).join(", ")}`,
      );
    };
    show("name", e.nameColumns);
    show("coord", e.coordColumns);
    show("address", e.addressColumns);
    show("int", e.integerColumns);
    show("blob", e.blobColumns);
    show("date", e.dateColumns);
  }
  L.push("");
  L.push("ID BRIDGE — verified by joining, not by column names");
  for (const b of idBridge) {
    L.push(
      b.joins
        ? `  ${b.table.padEnd(18)} ${b.linked}/${b.rows} rows reach a MixinMapItem`
        : `  ${b.table.padEnd(18)} NO ZMAPITEM column — cannot join`,
    );
  }
  L.push("");
  L.push("DATES");
  L.push(
    `  ${dateProbe.table ? `${dateProbe.table}.${dateProbe.column}` : "-"}  ${doc.verdict.epoch}` +
      `${dateProbe.digits ? `  ${dateProbe.digits} chars of text` : ""}` +
      `${dateProbe.exceedsSafeInteger ? "  EXCEEDS SAFE INTEGER — read as BigInt or TEXT" : ""}` +
      `${dateProbe.latestYear ? `  latest row ${dateProbe.latestYear}` : ""}`,
  );
  for (const c of dateProbe.considered ?? []) {
    L.push(
      `      rejected: ${String(c.epoch).padEnd(20)} year ${c.year}  plausible=${c.plausible}`,
    );
  }
  L.push("");
  L.push("COST");
  for (const t of timings) L.push(`  ${t.label.padEnd(28)} ${t.ms} ms  -> ${t.value}`);
  L.push("");
  L.push("VERDICT");
  for (const [k, v] of Object.entries(doc.verdict)) L.push(`  ${k.padEnd(12)}: ${v}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "maps",
    file: "maps-store.sql",
    ddlRows,
    macos: doc.macos,
    fingerprint,
    tool: "scripts/probe-maps.mjs",
  });
}
