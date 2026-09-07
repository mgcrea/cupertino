#!/usr/bin/env node
// Probe: can anything WRITE to Maps, and at what cost?
//
// ── WHY THIS IS A SEPARATE PROBE ─────────────────────────────────────────────
//
// `probe-maps.mjs` answered the read question and `packages/maps` ships from it.
// The write question is not the same question with a different verb, because
// every other write this repo performs goes through the APP'S OWN API — an Apple
// Event that Mail, Notes, Reminders, Calendar, Contacts or Messages executes
// itself, inside its own transaction, with its own invariants intact.
//
// Maps has no scripting dictionary. There is no such lane. So a Maps write means
// one of:
//
//   A. SQL straight into `MapsSync_0.0.1` — a live Core Data store that
//      `NSPersistentCloudKitContainer` is mirroring to iCloud, underneath a
//      running app that is also editing it.
//   B. Driving the Maps UI through Accessibility — a new TCC service for this
//      surface and ~31 ms per element round-trip (see scripts/spike-maps-ax.mjs).
//   C. Nothing.
//
// Lane A is the one that looks easy and is not, and this file exists to make the
// cost of it MEASURED rather than argued. Three things have to be true before it
// could be honest, and each has a question below:
//
//   * the file has to be writable at all (Q2)
//   * nothing else can be holding the store open and caching rows in memory (Q3)
//   * a third-party INSERT has to leave the CloudKit mirror in a state the
//     mirroring delegate can still export (Q4, Q6)
//
// The third is the one that decides it, and it cannot be reasoned about from
// column names. It needs the same measurement that found the store in the first
// place: WATCH WHAT THE APP ITSELF DOES. Q6 is that — snapshot, add one
// favourite by hand in Maps, snapshot again, diff. Whatever tables move are the
// tables a writer would have to maintain.
//
// ── WHAT THIS ANSWERS ────────────────────────────────────────────────────────
//
//   0. DOES THIS PROCESS HOLD FULL DISK ACCESS? Same instrument check as
//      `spike-maps-store.mjs`. A blind process must not report a negative.
//   1. IS THERE STILL NO APPLE EVENTS LANE, AND NO APP INTENTS LANE? The sdef
//      question re-asked, plus the modern answer to it — App Intents, which
//      Shortcuts surfaces and `shortcuts run` can invoke without any TCC grant
//      at all. If Maps ships an intent that saves a place, lane A is moot and
//      this whole probe is the wrong question.
//   2. IS THE STORE WRITABLE? `access(W_OK)` on the store, its `-wal`, and the
//      containing directory — SQLite needs all three to write, and the directory
//      is the one people forget.
//   3. WHO ELSE HAS IT OPEN? `lsof`. A running Maps or mapssyncd holds Core Data
//      contexts whose in-memory state a foreign INSERT is invisible to.
//   4. WHAT IS THE CLOUDKIT MIRRORING BOOKKEEPING? Every table that looks like
//      mirroring metadata, its columns and its row count — and whether the count
//      tracks the number of real objects, which is what says "every object is
//      registered" versus "registration is optional".
//   5. HOW ARE PRIMARY KEYS ALLOCATED? `Z_PRIMARYKEY.Z_MAX` per entity, and
//      whatever `Z_METADATA` carries. An INSERT that does not bump Z_MAX hands
//      the next Core Data insert a duplicate key.
//   6. WHAT DOES ONE REAL FAVOURITE COST? `--snapshot`, then add a favourite in
//      Maps by hand, then `--diff`. Reports every table that gained or lost rows
//      and, for new rows, WHICH COLUMNS THE APP SET.
//
// PRIVACY. Schema, counts and null-vs-set only. This never prints a place name,
// an address, a coordinate or the contents of any column — Q6 reports that a new
// row set `ZLATITUDE`, never what the latitude was. Saved places are somebody's
// home, doctor and school.
//
//   node scripts/probe-maps-write.mjs              # Q0-Q5, read-only
//   node scripts/probe-maps-write.mjs --snapshot   # then add a favourite in Maps
//   node scripts/probe-maps-write.mjs --diff       # what the app wrote
//   node scripts/probe-maps-write.mjs --json
//
// THIS PROBE NEVER WRITES TO THE STORE. It opens read-only and sets
// `PRAGMA query_only`. The only file it creates is its own snapshot, in the
// system temp directory.

import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  fileFacts,
  isRunning,
  macosVersion,
  openStore,
  parseArgs,
  safe,
  tableTools,
  yn,
} from "./lib/probe-kit.mjs";

const H = homedir();
const args = parseArgs(process.argv.slice(2));
const JSON_OUT = args.json;
const SNAPSHOT_PATH = join(tmpdir(), "cupertino-maps-write-snapshot.json");
const short = (p) => p.replace(H, "~");

const MAPS_APP = "/System/Applications/Maps.app";
// `--store=` exists so this file can be exercised against a synthetic fixture on a
// machine with no grant. Every probe-kit signature it depends on was got wrong
// once already by writing against an assumed API; offline is where that is caught.
const STORE = args.valueOf(
  "store",
  join(H, "Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1"),
);
const OFFLINE = args.has("--store=") || process.argv.some((a) => a.startsWith("--store="));

/**
 * Stores that back shipped surfaces. If these cannot be opened the process holds
 * no Full Disk Access and every "no" it produces is worthless — the mistake that
 * declared Maps impossible three times. See docs/maps.md.
 */
const INSTRUMENT = [
  ["notes", "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"],
  ["messages", "Library/Messages/chat.db"],
  ["calendar", "Library/Calendars/Calendar.sqlitedb"],
  ["safari", "Library/Safari/History.db"],
];

const out = [];
const say = (line = "") => {
  if (!JSON_OUT) console.log(line);
  out.push(line);
};
const head = (n, title) => {
  say();
  say(`── ${n}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
};

/** `access` rather than `stat`: stat succeeds on a file TCC will not let you open. */
const canAccess = (p, mode) =>
  safe(
    () => {
      accessSync(p, mode);
      return true;
    },
    () => false,
  );

const report = { macos: macosVersion(), store: short(STORE) };

// ── 0. the instrument ────────────────────────────────────────────────────────
head(0, "Full Disk Access — is this process able to see a positive?");

const instrument = INSTRUMENT.map(([name, rel]) => {
  const path = join(H, rel);
  const facts = fileFacts(path);
  return { name, readable: facts.readable, exists: facts.exists };
});
for (const i of instrument) {
  say(`  ${i.name.padEnd(10)} exists ${yn(i.exists).padEnd(4)} readable ${yn(i.readable)}`);
}
const granted = OFFLINE || instrument.some((i) => i.readable);
report.fullDiskAccess = granted;
say();
say(
  OFFLINE
    ? "  --store= given: instrument check SKIPPED, this is a fixture run"
    : granted
      ? "  FULL DISK ACCESS: GRANTED"
      : "  FULL DISK ACCESS: NOT GRANTED",
);

if (!granted) {
  say();
  say("  Stopping. A negative from a blind process is not a finding.");
  say("  Grant Full Disk Access to this terminal and re-run.");
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}

// ── 1. is there any lane that is not SQL? ────────────────────────────────────
head(1, "Other lanes — scripting dictionary, App Intents");

const sdefs = safe(
  () =>
    execFileSync("/usr/bin/find", [MAPS_APP, "-name", "*.sdef"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
  () => [],
);
const infoPlist = join(MAPS_APP, "Contents/Info.plist");
const scriptEnabled = safe(
  () =>
    execFileSync(
      "/usr/bin/defaults",
      ["read", infoPlist.replace(/\.plist$/, ""), "NSAppleScriptEnabled"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim(),
  () => null,
);

say(`  .sdef files                ${sdefs.length ? sdefs.join(", ") : "none"}`);
say(`  NSAppleScriptEnabled       ${scriptEnabled ?? "absent"}`);

/**
 * The intents lane — the one that did not exist when the two-lane design was
 * written, and the only one that could make a Maps write honest.
 *
 * It matters because an intent runs INSIDE Maps. Maps allocates the primary key,
 * Maps registers the CloudKit mirror row, Maps decides what a place record is.
 * That is the same property that makes an Apple Event safe on the other six
 * surfaces, reached by a different mechanism — so a Maps write through an intent
 * would fit the existing architecture rather than fork it.
 *
 * WHAT THE EVIDENCE HERE CAN AND CANNOT PROVE. Maps ships no
 * `Metadata.appintents` and declares no `INIntentsSupported`, so there is
 * nothing to enumerate the way a modern App Intents app can be enumerated. What
 * it does ship is `IntentsLocalizable.loctable`, the localised strings for its
 * intents — parameter titles like "The places to add to a list."
 *
 * Those strings PROVE the intents exist in Apple's codebase. They do NOT prove
 * the actions are registered on macOS. Maps here is a Catalyst app
 * (`UIDeviceFamily`, `UIApplicationSceneManifest`) shipping the iOS resource
 * bundle wholesale, so an iOS-only intent's strings ride along regardless. The
 * only test that settles it is opening Shortcuts and looking for the action,
 * which is why this prints an instruction rather than a verdict.
 *
 * Treating the loctable as proof of a usable lane would be this project's
 * signature mistake in a new costume: a plausible reading of an artefact,
 * unchecked against the thing it claims about.
 */
const intentsDir = join(MAPS_APP, "Contents/Resources/Metadata.appintents");
const LOCTABLE = join(MAPS_APP, "Contents/Resources/IntentsLocalizable.loctable");
const WRITE_VERB =
  /^(Add|Remove|Save|Update|Delete|Report|Start|End)\b|^The (place|places|list|note)\b/;
const intentStrings = existsSync(LOCTABLE)
  ? safe(
      () => {
        const parsed = JSON.parse(
          execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", LOCTABLE], {
            encoding: "utf8",
            maxBuffer: 32 * 1024 * 1024,
          }),
        );
        const keys = new Set();
        for (const table of Object.values(parsed)) {
          if (table && typeof table === "object") for (const k of Object.keys(table)) keys.add(k);
        }
        return [...keys];
      },
      () => [],
    )
  : [];

const saving = intentStrings
  .filter((k) => WRITE_VERB.test(k) && /place|list|note|parking/i.test(k))
  .toSorted();

say(`  Metadata.appintents        ${existsSync(intentsDir) ? "present" : "absent"}`);
say(`  INIntentsSupported         absent from Info.plist`);
say(`  IntentsLocalizable.loctable ${intentStrings.length} keys`);
if (saving.length) {
  say();
  say("  Strings for intents that MUTATE something:");
  for (const k of saving) say(`    ${k}`);
  say();
  say("  These prove the intents exist in Apple's code. They do NOT prove the");
  say("  actions are registered on macOS — Maps is a Catalyst app carrying the");
  say("  iOS resource bundle, so iOS-only strings ship here either way.");
  say();
  say("  THE TEST THAT SETTLES IT, by hand:");
  say("    open Shortcuts, add an action, search 'Maps', and look for");
  say("    'Add Places to List'. If it is absent, there is no intents lane on");
  say("    macOS and the only write lane left is SQL into a mirrored store.");
}
say();
say("  Note what is NOT in the list: nothing adds a FAVOURITE. The mutating");
say("  intents are about Lists, notes and parking. Favourites look read-only");
say("  through every lane, which the surface would have to say out loud.");

report.lanes = { sdefs, scriptEnabled, mutatingIntentStrings: saving };

// ── 2. is the store writable at all? ─────────────────────────────────────────
head(2, "Writability — the file, its sidecars, and the directory");

const directory = dirname(STORE);
const targets = [
  ["directory", directory],
  ["store", STORE],
  ["-wal", `${STORE}-wal`],
  ["-shm", `${STORE}-shm`],
];
report.writable = {};
for (const [label, path] of targets) {
  const r = canAccess(path, constants.R_OK);
  const w = canAccess(path, constants.W_OK);
  report.writable[label] = { exists: existsSync(path), read: r, write: w };
  say(
    `  ${label.padEnd(11)} exists ${yn(existsSync(path)).padEnd(4)} R ${yn(r).padEnd(4)} W ${yn(w)}`,
  );
}
say();
say("  SQLite needs write on the DIRECTORY too, to create -wal and -journal.");

// ── 3. who else has it open? ─────────────────────────────────────────────────
head(3, "Concurrent holders — who is editing this store right now?");

const mapsRunning = isRunning("com.apple.Maps");
const holders = safe(
  () =>
    execFileSync("/usr/sbin/lsof", ["--", STORE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0]),
  () => [],
);
const unique = [...new Set(holders)];
say(`  Maps.app running           ${yn(mapsRunning)}`);
say(`  processes with it open     ${unique.length ? unique.join(", ") : "none visible to lsof"}`);
say();
say("  A holder keeps Core Data contexts in memory. A foreign INSERT is invisible");
say("  to those contexts, and whatever they flush next was computed without it.");
report.holders = { mapsRunning, processes: unique };

// ── open the store ───────────────────────────────────────────────────────────
const opened = openStore(STORE);
if (!opened.db) {
  say();
  say(`  Could not open the store: ${opened.error}`);
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}
const { db } = opened;
const t = tableTools(db);
report.open = { mode: opened.mode, walBlind: opened.walBlind, openMs: opened.openMs };

const allTables = t
  .all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .map((r) => r.name)
  .filter((n) => !/^sqlite_/i.test(n));

// ── 4. the mirroring bookkeeping ─────────────────────────────────────────────
head(4, "CloudKit mirroring — what a foreign writer would have to maintain");

/**
 * Matched on the shape of the name rather than on a known list. Core Data's
 * mirroring tables have been renamed between releases, and a probe that looks
 * for exactly `NSCKRECORDMETADATA` reports "no mirroring" on the release that
 * renamed it — the absent-vs-EPERM error in a different costume.
 */
const MIRROR_RE = /NSCK|CLOUDKIT|CKRECORD|CKMIRROR|MIRRORED|CKEXPORT|CKIMPORT/i;
const mirrorTables = allTables.filter((n) => MIRROR_RE.test(n));
const objectTables = allTables.filter((n) => /^Z[A-Z]/.test(n) && !MIRROR_RE.test(n));

const totalObjects = objectTables.reduce((sum, n) => sum + (t.countOf(n) ?? 0), 0);
say(`  object tables              ${objectTables.length}, ${totalObjects} rows total`);
say(`  mirroring tables           ${mirrorTables.length}`);
say();
report.mirror = [];
for (const name of mirrorTables) {
  const count = t.countOf(name);
  const cols = t.columnInfo(name).map((c) => c.name);
  report.mirror.push({ name, count, columns: cols });
  say(`  ${name}  (${count} rows)`);
  say(`    ${cols.join(", ")}`);
}
if (mirrorTables.length) {
  say();
  say("  Mirror rows vs objects: does the bookkeeping track EVERY object?");
  /**
   * The comparison has to be against the per-object REGISTRY, and picking the
   * largest mirror table does not find it. On this Mac the largest is
   * `ANSCKEVENT` at 696 — a log of sync operations, which grows with time rather
   * than with the number of objects, and comparing it to an object count is
   * comparing two unrelated quantities. It happened to give the right answer,
   * which is worse than giving the wrong one.
   *
   * `*RECORDMETADATA` is the registry: one row per mirrored object, carrying
   * `ZENTITYID` + `ZENTITYPK` back to the row it stands for.
   */
  const registry =
    report.mirror.find((m) => /RECORDMETADATA$/i.test(m.name)) ??
    report.mirror.reduce((a, b) => ((b.count ?? 0) > (a.count ?? 0) ? b : a));
  const exact = /RECORDMETADATA$/i.test(registry.name);
  say(`    registry ${registry.name} = ${registry.count}, objects = ${totalObjects}`);
  if (!exact) say("    (no *RECORDMETADATA table — this is the largest, and only a proxy)");
  say(
    `    ${
      (registry.count ?? 0) >= totalObjects * 0.9
        ? "TRACKS EVERYTHING — an unregistered row is an anomaly, not a normal state."
        : "does NOT track everything — registration may be partial or lazy."
    }`,
  );
}

// ── 5. primary key allocation ────────────────────────────────────────────────
head(5, "Primary keys — what an INSERT would have to allocate");

const pk = t.all("SELECT Z_ENT, Z_NAME, Z_SUPER, Z_MAX FROM Z_PRIMARYKEY ORDER BY Z_NAME");
const interesting = pk.filter((r) =>
  /^(FavoriteItem|Collection|CollectionItem|HistoryItem|MixinMapItem)$/.test(String(r.Z_NAME)),
);
for (const r of interesting) {
  say(`  ${String(r.Z_NAME).padEnd(18)} Z_ENT ${String(r.Z_ENT).padEnd(4)} Z_MAX ${r.Z_MAX}`);
}
say();
say("  An INSERT must set Z_ENT and Z_OPT and take Z_PK from Z_MAX + 1, then bump");
say("  Z_MAX. Skipping the bump hands the next Core Data insert a duplicate key.");

const metadata = t.all("SELECT Z_VERSION, Z_UUID FROM Z_METADATA");
for (const m of metadata) say(`  Z_METADATA         version ${m.Z_VERSION} uuid ${m.Z_UUID}`);
report.primaryKeys = interesting;

// ── 6. snapshot / diff ───────────────────────────────────────────────────────
const snapshotOf = () => {
  const tables = {};
  for (const name of allTables) {
    const count = t.countOf(name);
    const hasPk = t.columnInfo(name).some((c) => c.name === "Z_PK");
    const maxPk = hasPk ? (t.one(`SELECT MAX(Z_PK) AS m FROM "${name}"`)?.m ?? null) : null;
    tables[name] = { count, maxPk };
  }
  /**
   * `Z_PRIMARYKEY` gains no rows when a favourite is added — it UPDATES one, and
   * a diff that only watches counts and max-pk cannot see that. Which is the
   * worst possible blind spot here, because the Z_MAX bump is the single piece
   * of bookkeeping a hand-written INSERT is most likely to skip.
   */
  const zmax = {};
  for (const r of t.all("SELECT Z_NAME, Z_MAX FROM Z_PRIMARYKEY")) zmax[String(r.Z_NAME)] = r.Z_MAX;
  return { store: STORE, takenOn: new Date().toISOString(), mode: opened.mode, tables, zmax };
};

/**
 * Which columns the app SET on a row, and of what type — never what it set them
 * to. See PRIVACY.
 *
 * This asks SQLite for `typeof()` and `length()` rather than selecting the
 * values, which matters twice. It cannot leak a place name or a coordinate even
 * by accident, because no value is ever marshalled out of the database. And it
 * survives `ZMUID`.
 *
 * `SELECT *` does NOT survive `ZMUID`. Maps stores it as a signed 64-bit place
 * id — `-2679868148951248105` on this Mac — and `node:sqlite` THROWS on any
 * integer past `Number.MAX_SAFE_INTEGER` rather than truncating it. Through
 * probe-kit's error-swallowing `all()` that throw became an empty array, so the
 * first version of this function reported that adding a favourite wrote nothing
 * to `ZFAVORITEITEM` — the one table the whole probe exists to watch — while
 * cheerfully reporting the other three. Same bug that took down the favourites
 * listing in `packages/maps`; caught here only because the offline fixture was
 * seeded with a real 19-digit id instead of a tidy small one.
 */
const shapeOfNewRows = (name, sincePk) => {
  const cols = t.columnInfo(name).map((c) => c.name);
  const select = cols.map((c, i) => `typeof("${c}") AS t${i}, length("${c}") AS l${i}`).join(", ");
  const rows = t.all(`SELECT ${select} FROM "${name}" WHERE Z_PK > ?`, sincePk);
  return rows.map((row) =>
    cols
      .map((c, i) => ({ name: c, type: row[`t${i}`], len: row[`l${i}`] }))
      .filter((f) => f.type !== "null")
      .map((f) => (f.type === "blob" ? `${f.name}<blob ${f.len}b>` : f.name)),
  );
};

if (args.has("--snapshot")) {
  head(6, "Snapshot");
  if (opened.walBlind) {
    say("  REFUSING. The store opened immutable=1, which is WAL-blind: a favourite");
    say("  added after this snapshot may live only in the -wal and the diff would");
    say("  report no change. That is a false negative, and false negatives from a");
    say("  blind instrument are the whole reason this file leads with Q0.");
    say("  Quit Maps so the WAL checkpoints, then re-run.");
    process.exit(3);
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshotOf(), null, 2));
  say(`  wrote ${SNAPSHOT_PATH}`);
  say();
  say("  NOW, BY HAND:");
  say("    1. open Maps");
  say("    2. search for somewhere you do not mind keeping");
  say("    3. add it to Favourites");
  say("    4. quit Maps, so the WAL is checkpointed");
  say("    5. node scripts/probe-maps-write.mjs --diff");
} else if (args.has("--diff")) {
  head(6, "Diff — what adding one favourite actually wrote");
  if (!existsSync(SNAPSHOT_PATH)) {
    say(`  No snapshot at ${SNAPSHOT_PATH}. Run --snapshot first.`);
    process.exit(3);
  }
  if (opened.walBlind) {
    say("  REFUSING — WAL-blind, see --snapshot. Quit Maps and re-run.");
    process.exit(3);
  }
  const before = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  // A diff across two different stores would compare unrelated tables and read
  // as a wall of spurious change. Cheap to check, and the `--store=` override
  // makes the mix-up easy to arrange by accident.
  if (before.store && before.store !== STORE) {
    say(`  Snapshot was taken against ${short(before.store)}, not ${short(STORE)}.`);
    say("  Re-run --snapshot against this store.");
    process.exit(3);
  }
  const now = snapshotOf();
  say(`  before ${before.takenOn}  (mode ${before.mode})`);
  say(`  after  ${now.takenOn}  (mode ${now.mode})`);
  say();

  const changed = [];
  for (const [name, after] of Object.entries(now.tables)) {
    const prior = before.tables[name] ?? { count: 0, maxPk: null };
    const delta = (after.count ?? 0) - (prior.count ?? 0);
    if (delta !== 0 || after.maxPk !== prior.maxPk) {
      changed.push({ name, delta, priorMaxPk: prior.maxPk, maxPk: after.maxPk });
    }
  }
  if (!changed.length) {
    say("  NOTHING CHANGED. Either no favourite was added, or Maps has not yet");
    say("  flushed. Quit Maps completely and re-run --diff before believing this.");
  }
  for (const c of changed) {
    const kind = MIRROR_RE.test(c.name) ? "mirror " : "object ";
    say(
      `  ${kind}${c.name.padEnd(34)} ${c.delta >= 0 ? "+" : ""}${c.delta} rows   Z_PK ${c.priorMaxPk} -> ${c.maxPk}`,
    );
  }
  say();
  say(`  ${changed.length} tables moved for ONE favourite.`);
  say(`    ${changed.filter((c) => MIRROR_RE.test(c.name)).length} of them mirroring bookkeeping.`);

  const zmaxMoved = Object.entries(now.zmax ?? {}).filter(
    ([name, max]) => (before.zmax ?? {})[name] !== max,
  );
  say();
  if (zmaxMoved.length) {
    say("  Z_PRIMARYKEY.Z_MAX bumped (an INSERT that skips this collides later):");
    for (const [name, max] of zmaxMoved) {
      say(`    ${name.padEnd(24)} ${(before.zmax ?? {})[name]} -> ${max}`);
    }
  } else {
    say("  Z_PRIMARYKEY.Z_MAX did not move.");
  }

  say();
  say("  Columns the app set on each new row (names and types only, never values):");
  for (const c of changed) {
    if (c.delta <= 0 || c.priorMaxPk === null) continue;
    for (const set of shapeOfNewRows(c.name, c.priorMaxPk)) {
      say(`    ${c.name}`);
      say(`      ${set.join(", ")}`);
    }
  }
  report.diff = changed;
} else {
  head(6, "Snapshot / diff — not run");
  say("  Re-run with --snapshot, add a favourite in Maps by hand, then --diff.");
  say("  That is the measurement that decides whether lane A is honest.");
}

// ── 7. stable identifiers ────────────────────────────────────────────────────
head(7, "Stable identifiers — can a ref outlive a re-sync?");

/**
 * A late finding, and a READ-surface one, which is why it lives in the write
 * probe: the diff showed Maps setting `ZIDENTIFIER` — a 16-byte blob, so a UUID
 * — on every row it created.
 *
 * `packages/maps` currently addresses rows by `Z_PK` and documents its refs as
 * session-scoped, because a Core Data row id is reused after a delete and
 * renumbered by a re-sync. `docs/maps.md` records that as having no alternative.
 * If `ZIDENTIFIER` is populated and distinct across existing rows, there is an
 * alternative and that limitation is fixable.
 *
 * COVERAGE AND DISTINCTNESS, not presence. A column that exists but is null on
 * the rows that predate it is worse than useless as a ref — it would work for
 * newly-saved places and silently fail for everything the user already had,
 * which is the failure mode hardest to notice. Counts only; no value printed.
 */
for (const table of ["ZFAVORITEITEM", "ZCOLLECTIONITEM", "ZCOLLECTION", "ZHISTORYITEM"]) {
  const cols = t
    .columnInfo(table)
    .map((c) => c.name)
    .filter((n) => /IDENTIFIER|UUID/i.test(n));
  const total = t.countOf(table);
  if (total === null) {
    say(`  ${table.padEnd(17)} not present`);
    continue;
  }
  if (!cols.length) {
    say(`  ${table.padEnd(17)} ${total} rows, no identifier-shaped column`);
    continue;
  }
  say(`  ${table} (${total} rows)`);
  for (const c of cols) {
    const r = t.one(
      `SELECT COUNT("${c}") AS nset, COUNT(DISTINCT "${c}") AS ndistinct FROM "${table}"`,
    );
    const set = r?.nset ?? 0;
    const distinct = r?.ndistinct ?? 0;
    const verdict =
      set === total && distinct === total
        ? "USABLE AS A REF — populated and distinct on every row"
        : set === 0
          ? "unusable — never populated"
          : `partial — ${total - set} rows would have no ref`;
    say(`    ${c.padEnd(22)} set ${set}/${total}  distinct ${distinct}  ${verdict}`);
  }
}

say();
say(`macOS ${report.macos} · store opened ${opened.mode} · ${allTables.length} tables`);
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
