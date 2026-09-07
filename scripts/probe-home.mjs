#!/usr/bin/env node
// Phase 0 spike for a PROSPECTIVE `home` (HomeKit) surface.
//
// No `packages/home` exists and none should until this probe has run. There is
// deliberately no entry in `surfaces.json` either: one there generates Swift, a
// bridge allow-list, two Makefile regions, a CI handshake loop and a bundler
// entry for a package that is not there.
//
// ── THREE OF THE FOUR LANES ARE ALREADY DECIDED ──────────────────────────────
//
//   HomeKit.framework      CLOSED. `HMHomeManager.h` in the iOS SDK is
//                          API_AVAILABLE(ios, watchos, tvos, macCatalyst(14.0))
//                          / API_UNAVAILABLE(macos). There is no HomeKit in the
//                          public macOS SDK; on macOS it exists only under
//                          /System/Library/PrivateFrameworks. And the
//                          `com.apple.developer.homekit` entitlement carries
//                          distribution types AD_HOC, DEVELOPMENT and STORE and
//                          NO DEVELOPER_ID — checked in Xcode's
//                          DVTPortalCachedPortalCapabilities.json, where App
//                          Groups, iCloud, Push and Personal VPN all DO list it.
//                          Cupertino ships Developer ID. So even a Mac Catalyst
//                          helper could not be signed for the channel this app
//                          ships on, and `docs/distribution.md` marks the App
//                          Store decision settled. The app also links no data
//                          frameworks by design.
//
//   Apple Events           CLOSED. Home.app ships no .sdef and no
//                          NSAppleScriptEnabled, checked directly.
//                          `docs/surfaces.md` already lists Home under "not
//                          scriptable — file lane or nothing".
//
//   File lane              THIS PROBE. `homed`
//                          (HomeKitDaemon.framework/Support/homed) holds
//                          ~/Library/HomeKit open. Full-Disk-Access gated.
//
//   Shortcuts              THIS PROBE, §9. /usr/bin/shortcuts has only
//                          run/list/view/sign. It cannot enumerate accessories,
//                          and HomeAppIntents.framework is private. But
//                          `shortcuts list` SUCCEEDS WITH NO FULL DISK ACCESS,
//                          measured — so the control lane and the read lane sit
//                          behind different grants, which no other surface here
//                          does.
//
// ── THE QUESTIONS ────────────────────────────────────────────────────────────
//
//     0. CAN THIS PROCESS SEE ANYTHING? Asked first, and a failure stops the
//        run. Maps was declared "no file lane" three times by processes holding
//        no grant, because EPERM and "empty" look identical from outside. This
//        probe measures its own blindness against stores that shipped surfaces
//        read daily before it believes a single negative about HomeKit.
//     1. WHICH FILE IS THE STORE? Five candidates, and the answer is decided by
//        MAGIC BYTES and by schema vocabulary, not by which name looks best.
//        Maps' store is `MapsSync_0.0.1` — no extension at all.
//     2. IS THE PAYLOAD ENCRYPTED? THE GO/NO-GO. HomeKit data is sensitive and
//        `homed` may well keep it sealed with a key in the keychain, which this
//        repo does not touch. If names and rooms are ciphertext there is no
//        surface, and that must be known NOW, not after a package exists.
//        See `scripts/lib/blob-stats.mjs`, which is tested, because a wrong
//        answer here kills a surface by arithmetic.
//     3. CONFIGURATION, OR LIVE STATE? Whether the store holds "the bedroom lamp
//        is on at 40%" or only "there is a bedroom lamp". Those are two
//        different products and both are shippable; conflating them is not.
//        Answered by reading twice, seconds apart, not by reading column names.
//     4. IS THERE HISTORY? `eventstore-beta.sqlite`, its retention window, and
//        whether an event row can reach an accessory. The `-beta` in the name
//        Apple chose is itself a finding.
//     5. WHAT IS THE ID BRIDGE? home -> room -> accessory -> service. A broken
//        hop is not a detail: it means "turn off the kitchen" is unsayable,
//        permanently. Mechanisms are enumerated and SCORED by joining, never
//        guessed from column names.
//     6. WHAT EPOCH ARE THE DATES? `docs/surfaces.md` calls dates the richest
//        source of silent errors. Core Data seconds since 2001 read as
//        plausible-but-wrong dates when taken as Unix.
//     7. HOW WAL-BLIND IS IT? `homed` never lets go of these files, so this
//        matters more here than on any surface probed so far. Measured as a
//        row-count delta between mode=ro and immutable=1, not asserted.
//     8. WHAT DOES A READ COST? Against the repo's yardsticks: Maps 0 ms,
//        Safari 16 ms, Calendar 3.4 s, Mail 74 s.
//     9. CAN SHORTCUTS CARRY CONTROL? Enumeration is free and grant-free.
//        RUNNING one is opt-in, and the hazard is physical — see below.
//
// ── PRIVACY ──────────────────────────────────────────────────────────────────
//
// Schema, table names, column names, entity names, row counts, null counts,
// value LENGTHS and byte-level statistics. It never prints a home name, a room
// name, a zone name, an accessory name, a service name, a serial number, a MAC
// address, a coordinate, a shortcut name or a shortcut's contents.
//
// A LIST OF SOMEONE'S ACCESSORIES IS A MAP OF THEIR HOUSE — how many rooms,
// whether there is a lock and a camera, and when the bedroom light goes on. That
// is a floor plan, a burglary window and a sleep schedule, and it is the most
// sensitive thing any surface in this repo would hold.
//
// Concretely: blob first-bytes are printed only when uniform across the sample
// or on a container allow-list, because a magic that differs per row is user
// data or an IV. Shortcut names are hashed, never printed. `-wal` and `-shm` are
// sized, never read. There is no `--term` and no LIKE search, because
// constructing a needle here means naming something in the house. Entity and
// table names ARE printed, deliberately: they are Apple's schema, identical on
// every Mac. And `assertRedacted` walks the finished document and FAILS the run
// if a uuid, MAC or email shape reached it.
//
//   node scripts/probe-home.mjs              # human-readable report
//   node scripts/probe-home.mjs --json       # the raw document
//   node scripts/probe-home.mjs --write      # capture the schema fixture
//   node scripts/probe-home.mjs --dir=<path> # a copied snapshot, or --store=<file>
//   node scripts/probe-home.mjs --samples=24 --twice=30 --needle=<uuid>
//   node scripts/probe-home.mjs --no-shortcuts
//   node scripts/probe-home.mjs --shortcut="Cupertino Probe No-Op"   # RUNS IT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { classifySamples } from "./lib/blob-stats.mjs";
import {
  aggNumericAsText,
  detectEpoch,
  dumpSchema,
  exists,
  fileFacts,
  findIdBridge,
  isRunning,
  isTextType,
  listable,
  looksLikeDateColumn,
  macosVersion,
  maskIdentity,
  maxNumericAsText,
  openStore,
  parseArgs,
  safe,
  tableTools,
  toFileUri,
  writeFixture,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const H = homedir();

/** probe-kit's `safe` takes an error HANDLER, not a fallback value. */
const attempt = (fn, fallback = null) => safe(fn, () => fallback);

const DEFAULT_DIR = join(H, "Library", "HomeKit");
const DIR = args.valueOf("dir", DEFAULT_DIR);
const ONE_STORE = args.valueOf("store", "");
const USING_DEFAULT = DIR === DEFAULT_DIR && !ONE_STORE;
/** `Number(x) || dflt` throws away a deliberate 0, so --twice=0 would still sleep. */
const num = (name, dflt) => {
  const v = Number(args.valueOf(name, String(dflt)));
  return Number.isFinite(v) ? v : dflt;
};
const SAMPLES = Math.max(2, num("samples", 12));
const TWICE_MS = Math.max(0, num("twice", 20)) * 1000;
const NEEDLE = args.valueOf("needle", "");
const SKIP_SHORTCUTS = args.has("--no-shortcuts");
const RUN_SHORTCUT = args.valueOf("shortcut", "");
const SHORTCUT_TIMEOUT = num("shortcut-timeout", 30_000);
const ACK_REAL_DEVICES = args.has("--i-understand-real-devices");

/**
 * Gated, and known to exist because shipped surfaces read them daily. If these
 * are unreadable the run is blind and every negative below means nothing.
 * Same list as `scripts/spike-maps-store.mjs`.
 */
const CONTROLS = {
  safari: join(H, "Library", "Safari", "History.db"),
  messages: join(H, "Library", "Messages", "chat.db"),
  notes: join(H, "Library", "Group Containers", "group.com.apple.notes"),
  calendar: join(H, "Library", "Group Containers", "group.com.apple.calendar"),
};

/**
 * The vocabulary of HomeKit's object model. Used to SCORE a candidate store, so
 * that "this is the real one" is an auditable number rather than an assertion,
 * and to name a table's role in §5. Never used to conclude anything on its own:
 * `docs/surfaces.md` records four separate failures caused by trusting a name.
 */
const VOCAB =
  /HOME|ROOM|ZONE|ACCESSOR|SERVICE|CHARACTERISTIC|ACTIONSET|SCENE|TRIGGER|CAMERA|MEDIA|NETWORK|USER/i;
/**
 * MOST SPECIFIC FIRST. Order is load-bearing: Core Data entity names compose, so
 * a table called ZHOMEACCESSORY matches both "home" and "accessory" and the
 * first rule wins. Putting the broadest term (home) last is the difference
 * between a chain that resolves and one that reports every hop broken.
 */
const ROLES = [
  ["characteristic", /CHARACTERISTIC/i],
  ["service", /SERVICE/i],
  ["accessory", /ACCESSOR/i],
  ["zone", /ZONE/i],
  ["room", /ROOM/i],
  ["scene", /ACTIONSET|SCENE/i],
  ["trigger", /TRIGGER/i],
  ["home", /HOME/i],
];
/**
 * NSPersistentCloudKitContainer's own bookkeeping, measured on a real store.
 *
 * `ANSCK*`, `ACHANGE`, `ATRANSACTION*` and the `Z_` metadata tables belong to
 * the sync machinery, not to HomeKit, and they must never be given a role. The
 * first real run scored `ANSCKRECORDZONEMETADATA` as the "zone" end of the
 * zone -> home hop and reported the hop RESOLVED at coverage 1.000. A CloudKit
 * *record zone* is not a HomeKit zone; the answer was fiction with a perfect
 * score, which is the same failure `scoreJoin`'s BOOKKEEPING filter exists for,
 * arriving one level higher up.
 */
const BOOKKEEPING_TABLE = /^(ANSCK|ACHANGE|ATRANSACTION|Z_METADATA|Z_MODELCACHE|Z_PRIMARYKEY)/i;
const roleOf = (name) =>
  BOOKKEEPING_TABLE.test(name) ? null : (ROLES.find(([, re]) => re.test(name))?.[0] ?? null);

/** Columns that would carry live state rather than configuration. */
const STATEISH = /VALUE|STATE|READING|LASTKNOWN|CURRENT|REACHAB|ONLINE|BATTERY|FIRMWARE/i;
/**
 * Columns that would mean the payload is sealed and the key is elsewhere.
 *
 * SUFFIX-ANCHORED, and restricted to columns that could actually HOLD a key.
 * The substring version listed 27 columns per store on the first real run, and
 * most were noise of exactly the kind `looksLikeDateColumn` documents:
 * `ZKEYUPDATEDTIME` is a date, `ZSUPPORTSMATTERWALLETKEY` is a boolean,
 * `ZDISMISSEDWALLETKEYUWBUNLOCKONBOARDING` is a UI flag. Real key material is a
 * BLOB or TEXT column whose name ENDS in the word — `ZPUBLICKEY`,
 * `ZBROADCASTKEY`, `ZNFCREADERKEY`, `ZKEY`. A list that cries wolf 27 times is
 * a list nobody reads, and this one is supposed to be the tell that the surface
 * is dead.
 */
const KEYISH = /(KEY|SECRET|NONCE|CIPHERTEXT|SEAL|WRAP)$|CRYPT|CIPHER/i;
const canHoldKeyMaterial = (type) => /BLOB/i.test(String(type ?? "")) || isTextType(type);
/** A shortcut name that might touch a real device. Weak by construction — see §9b. */
const HOMEISH =
  /home|light|lamp|thermostat|heat|cool|lock|door|garage|blind|shade|scene|hvac|switch|plug|outlet|fan|camera|sensor|alarm/i;

/**
 * A path, home-relative, and MASKED when it did not come from the default
 * location.
 *
 * `--dir=` and `--store=` are typed by hand and point at a snapshot the caller
 * made — on this machine that path runs through a temp directory containing a
 * session uuid. A probe report is the kind of thing that gets pasted into an
 * issue, so a path the caller supplied is not this probe's to publish. The
 * default location is Apple's and is printed in full.
 */
const pad = (s, n) => String(s ?? "-").padEnd(n);

/**
 * ONLY IDENTIFIER-SHAPED VALUES JOIN.
 *
 * Measured: this reported "best join 81% to ACHANGE.ZTRANSACTIONID" on a real
 * store, and it was noise. `ZTRANSACTIONID` is a small-integer sequence and so
 * are the event store's keys, so two unrelated counters overlap heavily by
 * construction — a high match rate that carries no information at all. It is
 * the same failure as `Z_ENT` scoring a perfect join and a CloudKit record
 * zone resolving against a HomeKit zone: an arithmetic coincidence wearing the
 * costume of a finding.
 *
 * A 16-byte blob or a dashed uuid string is a value with enough entropy that
 * agreement means something. An integer is not.
 */
const identifierShaped = (v) =>
  (v instanceof Uint8Array && v.length === 16) ||
  (typeof v === "string" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-/.test(v));

/** A uuid can be stored as TEXT or as 16 raw bytes; a Set needs one spelling. */
const keyOf = (v) =>
  v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v).toLowerCase();

/**
 * Shapes that must never reach the report. Declared here rather than beside
 * `assertRedacted` because the masking below and the final gate have to agree:
 * a check that fires on something nothing masks is a probe that cannot run.
 */
const SHAPES = [
  [/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/, "uuid"],
  [/\b([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/, "mac address"],
  [/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, "email"],
];

/**
 * A FILENAME IS DATA HERE, which no other surface in this repo has had to
 * assume.
 *
 * Measured on the first granted run: `~/Library/HomeKit` holds files named after
 * accessory MAC ADDRESSES, and the redaction gate stopped the report before it
 * printed them. A MAC identifies one physical device and is geolocatable through
 * public wifi databases, so a bare directory listing of this surface is already
 * a partial inventory of someone's house — before a single store is opened.
 *
 * Apple's own names (datastore3.sqlite, core-cloudkit.sqlite) pass through
 * untouched; anything shaped like an identifier is replaced by its shape. The
 * COUNT is reported, because "37 files are named after a device" is exactly the
 * finding, and the names themselves add nothing to it.
 *
 * No count is kept here — `doc.findings.files` counts the swept files that were
 * masked, because a counter inside this function saw the same basename several
 * times per file and once reported "14 of 7 files". No length is
 * included either — for a uuid or a MAC the length is fixed by the format, so it
 * says nothing, and it survived into the output as "00 chars" once maskIdentity
 * had flattened its digits.
 */
const safeName = (name) => {
  const hit = SHAPES.find(([re]) => re.test(name));
  return hit ? `<${hit[1]}-named>` : name;
};

const rel = (p) => {
  const s = String(p)
    .replace(`${H}/`, "~/")
    .split("/")
    .map((part) => safeName(part))
    .join("/");
  return USING_DEFAULT ? s : maskIdentity(s);
};
const sleepSync = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Progress, on STDERR so `--json` stdout stays machine-readable.
 *
 * Added after the first hand-run reported a hang. Two of these sections take
 * real time on a real store and the report only prints at the end, so silence
 * is indistinguishable from a lock-up — and a probe nobody dares leave running
 * is a probe that does not get run.
 */
const startedAt = Date.now();
const step = (label) =>
  process.stderr.write(
    `  [${String(Math.round((Date.now() - startedAt) / 1000)).padStart(4)}s] ${label}\n`,
  );

const doc = {
  tool: "scripts/probe-home.mjs",
  macos: macosVersion(),
  node: process.version,
  dir: rel(DIR),
  findings: {},
  verdict: {},
  notes: [],
};

if (args.launch) {
  doc.notes.push("--launch ignored: this surface has no Apple Events lane to launch anything for");
}

// ─── Q0 ──────────────────────────────────────────────────────────────────────
// Two halves. The instrument first — a probe that cannot read Safari's history
// cannot report anything about HomeKit, and must say so instead of reporting a
// negative. Then the target, with FOUR outcomes that are four different
// findings, not one.

const controls = Object.fromEntries(Object.entries(CONTROLS).map(([k, p]) => [k, fileFacts(p)]));
const blind = Object.values(controls).some((c) => c.exists && !c.readable);
const dirExists = exists(DIR);
const dirListable = listable(DIR);

doc.findings.q0 = { controls, blind, dir: rel(DIR), dirExists, dirListable };

if (USING_DEFAULT && !dirListable) {
  const verdict = !dirExists
    ? "ABSENT — ~/Library/HomeKit does not exist, so this Mac has never run HomeKit. That is a fact about THIS MAC, not a verdict about the surface: re-run on a Mac with a configured home."
    : blind
      ? "BLIND — this process cannot read stores that shipped surfaces read daily, so it cannot tell an empty HomeKit directory from a forbidden one. A negative from here means nothing."
      : "GATED BY SOMETHING THAT IS NOT FULL DISK ACCESS — the control stores read fine and ~/Library/HomeKit still refuses. That is the Contacts shape: its own TCC service. Permissions.swift models only Full Disk Access and would owe a third state.";
  doc.verdict.lane = verdict;
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(
      [
        `Home probe — macOS ${doc.macos}`,
        "",
        `  ${verdict}`,
        "",
        "  Full Disk Access: System Settings > Privacy & Security > Full Disk Access,",
        "  add your terminal (or the node binary), then FULLY QUIT AND REOPEN the",
        "  terminal — the grant is read at process start, so a running shell keeps the",
        "  old answer and the re-run looks identical.",
        "",
        "  This repo's agent shell holds no Full Disk Access, so this probe is hand-run",
        "  by design. To exercise the code path without the grant, copy the directory",
        "  somewhere readable and pass --dir=<path>, or point --store=<file> at one file.",
      ].join("\n"),
    );
  }
  process.exit(3);
}

// ─── Q1: which file is the store ─────────────────────────────────────────────
// Magic bytes, not extensions, and every directory's listability recorded so an
// EPERM subdirectory can never read as an empty one — failure #1 from the Maps
// probe, which `walkDir` would silently reproduce because it swallows readdir
// errors.

const magicOf = (p, n = 16) =>
  attempt(() => {
    const fd = openSync(p, "r");
    try {
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, 0);
      return b;
    } finally {
      closeSync(fd);
    }
  }, Buffer.alloc(0));

const looksLikeSqlite = (p) => magicOf(p).toString("latin1").startsWith("SQLite format 3");

const KNOWN_MAGICS = [
  ["bplist", (b) => b.toString("latin1").startsWith("bplist00")],
  ["gzip", (b) => b[0] === 0x1f && b[1] === 0x8b],
  ["typedstream", (b) => b[0] === 0x04 && b[1] === 0x0b],
  ["xml/plist", (b) => b.toString("latin1").startsWith("<?xml")],
  ["ascii", (b) => b.length > 0 && b.every((c) => c >= 0x09 && c <= 0x7e)],
];
const classifyFile = (p) => {
  if (looksLikeSqlite(p)) return "sqlite";
  const b = magicOf(p, 8);
  if (!b.length) return "unreadable";
  // Four bytes, not eight: for a file matching nothing on the list, the "header"
  // may simply be the first bytes of the payload.
  return (
    KNOWN_MAGICS.find(([, test]) => test(b))?.[0] ?? `unknown(${b.subarray(0, 4).toString("hex")})`
  );
};

const sweep = (root, maxDepth = 3) => {
  const files = [];
  const dirs = [];
  const walk = (dir, depth) => {
    const ok = listable(dir);
    dirs.push({ dir: rel(dir), listable: ok });
    if (!ok || depth > maxDepth) return;
    for (const e of attempt(() => readdirSync(dir, { withFileTypes: true }), [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else files.push(p);
    }
  };
  walk(root, 0);
  return { files, dirs };
};

step("sweeping the directory");
const swept = ONE_STORE ? { files: [ONE_STORE], dirs: [] } : sweep(DIR);
const seen = swept.files.map((p) => ({
  name: rel(p),
  base: safeName(basename(p)),
  // Flagged per file rather than inferred from the count, which briefly included
  // a masked component of the --dir path and reported "3 of 7 files".
  identifierNamed: safeName(basename(p)) !== basename(p),
  kind: /-(wal|shm)$/.test(p) ? "sqlite-sidecar" : classifyFile(p),
  sizeBytes: fileFacts(p).sizeBytes,
}));
doc.findings.files = {
  dirs: swept.dirs,
  count: seen.length,
  // See `safeName`: this number IS a finding, not a redaction footnote.
  identifierNamedFiles: seen.filter((f) => f.identifierNamed).length,
  seen,
};

const sqlitePaths = swept.files.filter((p) => !/-(wal|shm)$/.test(p) && looksLikeSqlite(p));

// ─── the shared per-store analysis ───────────────────────────────────────────

const openMode = (path, mode) =>
  attempt(() => {
    const db = new DatabaseSync(toFileUri(path, mode === "ro" ? "mode=ro" : "immutable=1"), {
      readOnly: true,
      allowExtension: false,
    });
    db.exec("PRAGMA query_only = 1");
    return db;
  });

/** Sample from three ROWID windows, never `LIMIT n` off the top. */
const sampleBlobs = (T, table, column, n) => {
  const k = Math.max(1, Math.ceil(n / 3));
  const q = (order, offset) =>
    T.all(
      `SELECT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL AND LENGTH("${column}") > 0` +
        ` ORDER BY ROWID ${order} LIMIT ${k} OFFSET ${offset}`,
    ).map((r) => Buffer.from(r.v ?? []));
  const total = T.countOf(table) ?? 0;
  // Top, bottom and middle: the top of a Core Data table is its oldest rows, and
  // the outliers cluster there.
  return [...q("ASC", 0), ...q("DESC", 0), ...q("ASC", Math.max(0, Math.floor(total / 2)))].filter(
    (b) => b.length,
  );
};

const analyseStore = (path) => {
  const facts = fileFacts(path);
  const opened = openStore(path);
  if (!opened?.db) {
    return {
      file: basename(path),
      fullPath: path,
      facts,
      opened: false,
      error: opened?.error ?? "unknown",
    };
  }
  const db = opened.db;
  const schema = dumpSchema(db);
  const T = tableTools(db);
  const isCoreData = schema.tables.includes("Z_PRIMARYKEY");
  const entities = isCoreData
    ? T.all("SELECT Z_NAME AS n FROM Z_PRIMARYKEY ORDER BY Z_NAME").map((r) => r.n)
    : [];

  const tables = schema.tables.map((name) => {
    const columns = T.columnInfo(name);
    return {
      name,
      role: roleOf(name),
      rows: T.countOf(name),
      columnCount: columns.length,
      columns,
      textColumns: columns.filter((c) => isTextType(c.type)).map((c) => c.name),
      blobColumns: columns.filter((c) => /BLOB/i.test(String(c.type ?? ""))).map((c) => c.name),
      dateColumns: columns.filter((c) => looksLikeDateColumn(c.name, c.type)).map((c) => c.name),
      stateColumns: columns.filter((c) => STATEISH.test(c.name)).map((c) => c.name),
      // A table carrying both `key` and `value` is a key/value STORE, and its
      // `key` column is a lookup name, not key material. `eventstore.key` was
      // flagged on the first real run purely for being called key.
      keyColumns: (columns.some((c) => /^key$/i.test(c.name)) &&
      columns.some((c) => /^value$/i.test(c.name))
        ? columns.filter((c) => !/^key$/i.test(c.name))
        : columns
      )
        .filter((c) => KEYISH.test(c.name) && canHoldKeyMaterial(c.type))
        .map((c) => c.name),
    };
  });

  // Q1: score by vocabulary, and print the score so the choice is arguable.
  const vocabHits = [...entities, ...schema.tables].filter((n) => VOCAB.test(n));
  const totalRows = tables.reduce((a, t) => a + (t.rows ?? 0), 0);
  /**
   * Rows sitting in tables that actually carry a HomeKit ROLE, which is what
   * "this is the real store" means and what the vocabulary score only proxies.
   *
   * The first real run chose `core-cloudkit.sqlite` over `core.sqlite` on a
   * score of 131 to 127 — a four-point margin outranking a 27x difference in
   * rows (4,970 against 136,390). The CloudKit store mirrors the same entity
   * names with a CK infix, so it scores marginally HIGHER on names while
   * holding a fraction of the data and no service table at all. Every
   * downstream answer inherited that: the service -> accessory hop was reported
   * NOT FOUND because the mirror has nothing to join.
   */
  const roleRows = tables.reduce((a, t) => a + (t.role ? (t.rows ?? 0) : 0), 0);

  // Q2: is any of it legible?
  const textTotals = tables.flatMap((t) =>
    t.textColumns.map((c) => ({
      table: t.name,
      column: c,
      ...T.one(
        `SELECT COUNT(*) AS total, COUNT("${c}") AS nonNull, MIN(LENGTH("${c}")) AS minLen,` +
          ` MAX(LENGTH("${c}")) AS maxLen, SUM(LENGTH("${c}")) AS sumLen FROM "${t.name}"`,
      ),
    })),
  );
  const textBytes = textTotals.reduce((a, c) => a + Number(c.sumLen ?? 0), 0);

  const blobVerdicts = [];
  for (const t of tables) {
    if (!t.rows) continue;
    for (const c of t.blobColumns) {
      const samples = sampleBlobs(T, t.name, c, SAMPLES);
      if (!samples.length) continue;
      const r = classifySamples(samples);
      blobVerdicts.push({
        table: t.name,
        column: c,
        sampled: samples.length,
        verdict: r.verdict,
        reason: r.reason,
        compressed: r.compressed,
        magic: r.magic,
        // Statistics only. The bytes themselves never leave this function.
        stats: r.samples.map((s) => ({
          length: s.length,
          entropy: s.entropy,
          printableRatio: s.printableRatio,
          runExcess: s.runExcess,
          container: s.container,
        })),
      });
    }
  }
  const keyColumns = tables.flatMap((t) => t.keyColumns.map((c) => `${t.name}.${c}`));

  return {
    file: safeName(basename(path)),
    fullPath: path,
    path: rel(path),
    facts,
    opened: true,
    mode: opened.mode,
    openMs: opened.openMs,
    walBlind: opened.walBlind,
    sqlite: opened.sqlite,
    fingerprint: schema.fingerprint,
    objectCount: schema.objectCount,
    isCoreData,
    entities,
    tableCount: schema.tables.length,
    tables,
    vocabScore: vocabHits.length,
    vocabHits,
    totalRows,
    roleRows,
    triggers: schema.ddlRows.filter((r) => r.type === "trigger").map((r) => r.name),
    encryption: { textBytes, textTotals, blobVerdicts, keyColumns },
    db,
    schema,
  };
};

step("opening candidates, and sampling blobs for the encryption verdict");
const stores = sqlitePaths.map(analyseStore);
const usable = stores.filter((s) => s.opened);
if (!usable.length) {
  console.error(
    `no candidate opened. ${stores.map((s) => `${s.file}: ${s.error}`).join("; ") || "no sqlite files found"}`,
  );
  process.exit(4);
}

/**
 * The main store is the one holding the most rows IN ROLE-BEARING TABLES.
 *
 * Not the vocabulary score, which every mirror of the same schema ties or beats
 * — see `roleRows` above for the run that got this wrong. Not raw row count
 * either, since sync bookkeeping can dwarf the data. Rows that are actually a
 * home, a room, an accessory or a service is the thing being asked about.
 */
const main =
  usable
    .filter((s) => s.totalRows > 0)
    .toSorted((a, b) => b.roleRows - a.roleRows || b.vocabScore - a.vocabScore)[0] ?? usable[0];
const eventStore = usable.find((s) => /event/i.test(s.file) && s !== main) ?? null;

doc.findings.stores = usable.map((s) => ({
  file: s.file,
  sizeBytes: s.facts.sizeBytes,
  walSizeBytes: s.facts.walSizeBytes,
  mode: s.mode,
  openMs: s.openMs,
  isCoreData: s.isCoreData,
  objectCount: s.objectCount,
  fingerprint: s.fingerprint,
  tableCount: s.tableCount,
  entityCount: s.entities.length,
  totalRows: s.totalRows,
  roleRows: s.roleRows,
  vocabScore: s.vocabScore,
  isMain: s === main,
}));
doc.findings.entities = { file: main.file, entities: main.entities, vocabHits: main.vocabHits };
doc.findings.tables = main.tables.map((t) => ({
  name: t.name,
  role: t.role,
  rows: t.rows,
  columnCount: t.columnCount,
  textColumns: t.textColumns.length,
  blobColumns: t.blobColumns.length,
  stateColumns: t.stateColumns,
  dateColumns: t.dateColumns,
}));

// ─── Q2: the go/no-go ────────────────────────────────────────────────────────

doc.findings.encryption = Object.fromEntries(
  usable.map((s) => [
    s.file,
    {
      textBytes: s.encryption.textBytes,
      textColumns: s.encryption.textTotals.length,
      // A name column is short and human-scale. A base64 ciphertext column is
      // long and uniform. Neither the values nor a single character of them.
      humanScaleTextColumns: s.encryption.textTotals.filter(
        (c) => Number(c.nonNull) > 0 && Number(c.maxLen) <= 128,
      ).length,
      longestTextColumn: Math.max(0, ...s.encryption.textTotals.map((c) => Number(c.maxLen ?? 0))),
      blobVerdicts: s.encryption.blobVerdicts,
      keyColumns: s.encryption.keyColumns,
    },
  ]),
);

const tallyOf = (store) => {
  const t = {};
  for (const b of store.encryption.blobVerdicts) t[b.verdict] = (t[b.verdict] ?? 0) + 1;
  return t;
};
const tally = tallyOf(main);
const encryptedCols = main.encryption.blobVerdicts
  .filter((b) => b.verdict === "ENCRYPTED")
  .map((b) => `${b.table}.${b.column}`);
const humanScale = main.encryption.textTotals.filter(
  (c) => Number(c.nonNull) > 0 && Number(c.maxLen) <= 128,
).length;
const legibleText = main.encryption.textBytes > 0;

/**
 * Counts, not an adjective.
 *
 * The first real run headlined "SOME BLOBS READ AS ENCRYPTED" on the strength of
 * two columns out of ninety, both CloudKit share assets — which reads as a
 * no-go for a store whose names are sitting there in plain bplist. What decides
 * this surface is whether the NAME-BEARING columns are legible; a sealed
 * thumbnail or share token is survivable and always will be.
 */
doc.verdict.encrypted = !legibleText
  ? `OPAQUE — every TEXT column in ${main.file} sums to 0 bytes. Whatever this store holds is not in its text columns, and no entropy statistic is needed to say so.`
  : `LEGIBLE — ${main.encryption.textBytes} B of text across ${main.encryption.textTotals.length} columns, ${humanScale} of them human-scale (a name is short; a base64 ciphertext column is long and uniform). Blobs: ` +
    Object.entries(tally)
      .map(([k, v]) => `${v} ${k.toLowerCase()}`)
      .join(", ") +
    (encryptedCols.length
      ? `. Sealed: ${encryptedCols.join(", ")} — survivable unless one of those carries a name.`
      : ". Nothing sealed.");
doc.notes.push(
  "high entropy does NOT distinguish encrypted from compressed — both sit at 7.9-8.0 bits/byte. Every verdict above tried an inflate first.",
);

// ─── Q7: WAL-blindness, measured before Q3 relies on it ──────────────────────

const countAll = (db, tables) =>
  Object.fromEntries(
    tables.map((t) => [t, attempt(() => db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c)]),
  );

step("wal: counting every table under both open modes");
const roDb = openMode(main.fullPath, "ro");
const immDb = openMode(main.fullPath, "immutable");
const names = main.tables.map((t) => t.name);
const roCounts = roDb ? countAll(roDb, names) : null;
const immCounts = immDb ? countAll(immDb, names) : null;
const walDeltas =
  roCounts && immCounts
    ? names
        .map((t) => ({ table: t, ro: roCounts[t], immutable: immCounts[t] }))
        .filter((d) => d.ro !== d.immutable)
    : [];
doc.findings.wal = {
  roOpened: Boolean(roDb),
  immutableOpened: Boolean(immDb),
  walSizeBytes: main.facts.walSizeBytes,
  dbSizeBytes: main.facts.sizeBytes,
  walRatio:
    main.facts.sizeBytes && main.facts.walSizeBytes
      ? Number((main.facts.walSizeBytes / main.facts.sizeBytes).toFixed(3))
      : null,
  deltas: walDeltas,
};
doc.verdict.walBlind = !roDb
  ? "mode=ro FAILED while homed holds the file — every count here is immutable and lags whatever homed has not checkpointed"
  : walDeltas.length
    ? `${walDeltas.length} table(s) differ between mode=ro and immutable=1 — an immutable read is measurably blind`
    : "ro and immutable agree on every table right now";

// ─── Q3: configuration, or live state? ───────────────────────────────────────
// Structure first, then the only honest test: read twice.

const stateTables = main.tables.filter((t) => t.stateColumns.length && t.dateColumns.length);
const snapshot = (db) =>
  Object.fromEntries(
    main.tables.map((t) => {
      const dateCol = t.dateColumns[0];
      return [
        t.name,
        {
          rows: attempt(() => db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get().c),
          maxDate: dateCol ? maxNumericAsText(db, t.name, dateCol).raw : null,
        },
      ];
    }),
  );

const first = snapshot(main.db);
let liveResult;
if (main.walBlind || !roDb) {
  liveResult = {
    tested: false,
    reason:
      "opened immutable — this test would be blind to the WAL and could only report a false negative",
  };
} else if (TWICE_MS === 0) {
  liveResult = { tested: false, reason: "--twice=0" };
} else {
  step(`live state: waiting ${TWICE_MS / 1000}s for the second reading (--twice=0 skips this)`);
  sleepSync(TWICE_MS);
  const second = openStore(main.fullPath);
  const after = second?.db ? snapshot(second.db) : null;
  const moved = after
    ? Object.entries(after)
        .filter(([t, v]) => v.rows !== first[t]?.rows || v.maxDate !== first[t]?.maxDate)
        .map(([t, v]) => ({
          table: t,
          rowDelta: Number(v.rows ?? 0) - Number(first[t]?.rows ?? 0),
          dateMoved: v.maxDate !== first[t]?.maxDate,
          /**
           * SYNC CHURN IS NOT LIVE STATE, and the test for it is an ALLOWLIST.
           *
           * First attempt counted any table that moved, and a 60-second window
           * duly reported "LIVE STATE CACHED — 3 tables changed": they were
           * `ACHANGE` and `ATRANSACTION`, CloudKit's change-tracking tables,
           * which grow on an idle Mac with nothing touched (measured: +6 rows
           * between two probe runs minutes apart).
           *
           * Second attempt excluded those by name and reported "LIVE STATE
           * CACHED — ZRESIDENTSYNCMETADATA". That is HomeKit's OWN resident sync
           * bookkeeping — `ZLASTSEENTOKEN`, `ZLASTSYNCTOKEN` — and it is no more
           * a fact about the home than `ACHANGE` is.
           *
           * A denylist of bookkeeping names is unbounded: there is always
           * another sync table. The question is not "which tables should not
           * count" but "did a table holding one of the home's OBJECTS move", and
           * `roleOf` already answers that. So the signal is role-bearing, and
           * everything else is reported but never claimed.
           */
          role: roleOf(t),
          bookkeeping: BOOKKEEPING_TABLE.test(t),
        }))
    : [];
  liveResult = {
    tested: Boolean(after),
    windowSeconds: TWICE_MS / 1000,
    moved,
    movedRoles: moved.filter((m) => m.role),
    movedOther: moved.filter((m) => !m.role && !m.bookkeeping),
    movedBookkeeping: moved.filter((m) => m.bookkeeping),
  };
  second?.db?.close?.();
}
doc.findings.liveState = {
  structural: stateTables.map((t) => ({
    table: t.name,
    stateColumns: t.stateColumns,
    dateColumns: t.dateColumns,
    rows: t.rows,
  })),
  temporal: liveResult,
};
const describeMoved = (list) =>
  list
    .map(
      (m) =>
        `${m.table}${m.rowDelta ? ` ${m.rowDelta > 0 ? "+" : ""}${m.rowDelta}` : ""}${m.dateMoved ? " (date advanced)" : ""}`,
    )
    .join(", ");

const noise = [...(liveResult.movedOther ?? []), ...(liveResult.movedBookkeeping ?? [])];
doc.verdict.liveState = !liveResult.tested
  ? `INCONCLUSIVE — ${liveResult.reason}`
  : liveResult.movedRoles?.length
    ? `LIVE STATE CACHED — ${describeMoved(liveResult.movedRoles)} changed within ${liveResult.windowSeconds}s` +
      (noise.length ? ` (sync tables also moved and are ignored: ${describeMoved(noise)})` : "")
    : noise.length
      ? `NO ROLE-BEARING TABLE MOVED in ${liveResult.windowSeconds}s — only sync tables: ${describeMoved(noise)}. Those track replication, not the home, and they move on an idle Mac. IF AN ACCESSORY WAS ACTUALLY TOGGLED during the window, this is evidence the store holds CONFIGURATION ONLY and live characteristic values stay in homed's memory. If nothing was toggled, the run proves nothing — do it again and change something.`
      : `NOTHING MOVED AT ALL in ${liveResult.windowSeconds}s, not even sync tables. Suspect the window was simply quiet. Re-run with a larger --twice, and toggle something.`;

// ─── Q4: history ─────────────────────────────────────────────────────────────

let history = { present: false };
if (eventStore) {
  const T = tableTools(eventStore.db);
  const biggest = eventStore.tables.toSorted((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0];
  const dateCol = biggest?.dateColumns?.[0];
  const lo = dateCol ? aggNumericAsText(eventStore.db, biggest.name, dateCol, "MIN") : null;
  const hi = dateCol ? aggNumericAsText(eventStore.db, biggest.name, dateCol, "MAX") : null;
  const epoch = hi?.value ? detectEpoch(hi.value) : { tested: false };
  const span =
    lo?.value && hi?.value && epoch.divisor
      ? Number(((hi.value - lo.value) / epoch.divisor / 86_400).toFixed(1))
      : null;

  /**
   * Can an event reach the main store? Scored by joining IN MEMORY — never
   * ATTACH, which would open a second store under a handle outliving this
   * question, and never printing a key.
   *
   * THE FIRST VERSION OF THIS HUNG, and the shape of the mistake is worth
   * keeping: it ran one `SELECT ... WHERE col = ?` per sampled value, inside a
   * `filter` callback that recompiled the statement every time, for every
   * (event column x main table x main column) triple. Neither side is indexed on
   * these columns, so each of those is a full table scan — 500 values x ~30
   * tables x ~20 columns is on the order of a million scans, and the report only
   * prints at the end. It did not look slow. It looked broken.
   *
   * One pass per column, into a Set, then intersect. Bounded, so a huge column
   * cannot eat memory either — and `truncated` is reported, because a capped
   * comparison that silently understates a match rate is exactly the kind of
   * quiet wrong number this file exists to avoid.
   */
  const IDISH = /UUID|IDENT|ID$/i;
  const CAP = 20_000;
  const joinable = [];
  const unjoinable = [];
  const eventCols = (biggest?.columns ?? []).filter((c) => IDISH.test(c.name));
  const parentCols = main.tables
    // Sync bookkeeping is not a join target: see BOOKKEEPING_TABLE.
    .filter((t) => !BOOKKEEPING_TABLE.test(t.name))
    .flatMap((t) =>
      t.columns
        .filter((pc) => IDISH.test(pc.name))
        .map((pc) => ({ table: t.name, column: pc.name })),
    );
  if (eventCols.length && parentCols.length) {
    step(
      `history: intersecting ${eventCols.length} event column(s) against ${parentCols.length} store column(s)`,
    );
  }
  // Read each parent column ONCE, not once per value.
  const parentSets = parentCols.map((pc) => {
    const rows = tableTools(main.db).all(
      `SELECT DISTINCT "${pc.column}" AS v FROM "${pc.table}" WHERE "${pc.column}" IS NOT NULL LIMIT ${CAP + 1}`,
    );
    return {
      ...pc,
      set: new Set(rows.slice(0, CAP).map((r) => keyOf(r.v))),
      truncated: rows.length > CAP,
    };
  });
  for (const c of eventCols) {
    const raw = T.all(
      `SELECT DISTINCT "${c.name}" AS v FROM "${biggest.name}" WHERE "${c.name}" IS NOT NULL LIMIT 500`,
    );
    const vals = raw.filter((r) => identifierShaped(r.v)).map((r) => keyOf(r.v));
    if (!vals.length) {
      unjoinable.push({ column: `${biggest.name}.${c.name}`, sampled: raw.length });
      continue;
    }
    for (const pc of parentSets) {
      if (!pc.set.size) continue;
      const hits = vals.filter((v) => pc.set.has(v)).length;
      if (hits) {
        joinable.push({
          from: `${biggest.name}.${c.name}`,
          to: `${pc.table}.${pc.column}`,
          matchRate: Number((hits / vals.length).toFixed(3)),
          sampled: vals.length,
          truncated: pc.truncated,
        });
      }
    }
  }
  history = {
    present: true,
    file: eventStore.file,
    table: biggest?.name,
    rows: biggest?.rows,
    epoch: epoch.epoch ?? null,
    retentionDays: span,
    joinable: joinable.toSorted((a, b) => b.matchRate - a.matchRate).slice(0, 5),
    // Columns whose values are not identifier-shaped, so no match rate over them
    // would have meant anything. Reported, so their absence is not read as a
    // failure to look.
    notIdentifierShaped: unjoinable,
  };
}
doc.findings.history = history;
doc.verdict.history = !history.present
  ? "no separate event store opened"
  : `${history.rows ?? "?"} rows over ${history.retentionDays ?? "?"} days` +
    (history.joinable?.length
      ? `, best join ${Math.round(history.joinable[0].matchRate * 100)}% to ${history.joinable[0].to}`
      : history.notIdentifierShaped?.length
        ? `, and none of its key columns hold identifier-shaped values (${history.notIdentifierShaped.map((u) => u.column).join(", ")}), so nothing can be joined to the store — an integer key would match by coincidence, not by reference`
        : ", and NOTHING joins back to the main store") +
    (/beta/i.test(history.file)
      ? ". Apple named this file -beta: that is a schema Apple has not committed to, and anything built on it inherits the label."
      : "");

// ─── Q5: the id bridge ───────────────────────────────────────────────────────
// Mechanisms, enumerated and SCORED by joining. Never guessed from a name.

const T = tableTools(main.db);
const declaredFks = main.tables.flatMap((t) =>
  attempt(() => main.db.prepare(`PRAGMA foreign_key_list("${t.name}")`).all(), []).map((f) => ({
    from: `${t.name}.${f.from}`,
    to: `${f.table}.${f.to ?? "rowid"}`,
  })),
);

const pkOf = (t) => (main.isCoreData ? "Z_PK" : (t.columns.find((c) => c.pk)?.name ?? "rowid"));
/**
 * Core Data's own bookkeeping, which is NOT a foreign key and joins anyway.
 *
 * Measured on the synthetic fixture before this filter existed: `ZSERVICE.Z_ENT`
 * scored coverage 1.000 against `ZACCESSORY.Z_PK` and won the hop, because every
 * service carries entity id 4 and an accessory happens to have Z_PK 4. A
 * perfect score, an entirely fictional relationship, and the report stated it as
 * the answer. `docs/surfaces.md` warns about naming; this is the same error
 * arriving through arithmetic instead.
 */
const BOOKKEEPING = /^Z_(PK|ENT|OPT)$/i;

const scoreJoin = (child, childCol, parent, parentCol) => {
  const rows = child.rows ?? 0;
  if (!rows) return null;
  const row = attempt(() =>
    main.db
      .prepare(
        `SELECT COUNT(*) AS matched, COUNT(DISTINCT p."${parentCol}") AS parents` +
          ` FROM "${child.name}" c JOIN "${parent.name}" p ON c."${childCol}" = p."${parentCol}"`,
      )
      .get(),
  );
  if (!row) return null;
  return {
    mechanism: "scalar",
    from: `${child.name}.${childCol}`,
    to: `${parent.name}.${parentCol}`,
    matched: row.matched,
    rows,
    // THE TIE-BREAKER, and the reason coverage alone is not enough: a constant
    // column reaches exactly ONE parent however perfectly it joins, while a real
    // foreign key spreads across many.
    distinctParents: row.parents,
    coverage: Number((row.matched / rows).toFixed(3)),
  };
};

const CHAIN = [
  ["service", "accessory"],
  ["accessory", "room"],
  ["room", "home"],
  ["zone", "home"],
];
step("id bridge: scoring joins");
const bridge = CHAIN.map(([childRole, parentRole]) => {
  const children = main.tables.filter((t) => t.role === childRole);
  const parents = main.tables.filter((t) => t.role === parentRole);
  if (!children.length || !parents.length) {
    return {
      hop: `${childRole} -> ${parentRole}`,
      resolved: false,
      reason: "no table for one end",
    };
  }
  const candidates = [];
  for (const child of children) {
    for (const parent of parents) {
      const parentPk = pkOf(parent);
      // 1. declared foreign keys, which Core Data never emits but a plain
      //    schema might — free and authoritative, so asked first.
      for (const f of declaredFks) {
        if (f.from.startsWith(`${child.name}.`) && f.to.startsWith(`${parent.name}.`)) {
          candidates.push({ mechanism: "declared-fk", from: f.from, to: f.to, coverage: 1 });
        }
      }
      // 2. scalar integer columns against the parent's primary key.
      for (const c of child.columns) {
        if (!/INT/i.test(String(c.type ?? "")) || c.pk || BOOKKEEPING.test(c.name)) continue;
        const s = scoreJoin(child, c.name, parent, parentPk);
        if (s?.matched) candidates.push(s);
      }
      // 3. UUID-valued columns, TEXT or 16-byte BLOB. HomeKit's object model is
      //    UUID-addressed, which no surface probed so far has needed.
      for (const c of child.columns) {
        if (!/UUID|IDENT/i.test(c.name)) continue;
        for (const pc of parent.columns) {
          if (!/UUID|IDENT/i.test(pc.name)) continue;
          const s = scoreJoin(child, c.name, parent, pc.name);
          if (s?.matched) candidates.push({ ...s, mechanism: "uuid" });
        }
      }
    }
  }
  // 4. Z_<ordinal><RELATIONSHIP> join tables. A many-to-many leaves no column on
  //    either entity, so no list of column names can contain the answer.
  const joinTables = main.tables.filter(
    (t) => t.name.startsWith("Z_") && !/^Z_(METADATA|MODELCACHE|PRIMARYKEY)$/.test(t.name),
  );
  for (const jt of joinTables) {
    const hitsChild = jt.columns.some((c) => new RegExp(childRole, "i").test(c.name));
    const hitsParent = jt.columns.some((c) => new RegExp(parentRole, "i").test(c.name));
    if (hitsChild && hitsParent) {
      candidates.push({
        mechanism: "join-table",
        from: jt.name,
        to: `${childRole}+${parentRole}`,
        rows: jt.rows,
        coverage: null,
      });
    }
  }
  const best =
    candidates.toSorted(
      (a, b) =>
        (b.coverage ?? 0) - (a.coverage ?? 0) ||
        (b.distinctParents ?? 0) - (a.distinctParents ?? 0),
    )[0] ?? null;
  return {
    hop: `${childRole} -> ${parentRole}`,
    resolved: Boolean(best),
    best,
    candidateCount: candidates.length,
  };
});

/**
 * Triggers that name two tables are Apple stating a relationship outright, which
 * beats any oracle this probe could construct. `writeFixture` drops them from the
 * captured schema, so they are recorded here or nowhere.
 */
const relationshipTriggers = main.schema.ddlRows
  .filter((r) => r.type === "trigger")
  .map((r) => ({
    name: r.name,
    mentions: main.tables.map((t) => t.name).filter((t) => String(r.sql).includes(t)),
  }))
  .filter((t) => t.mentions.length >= 2);

const shortcutNeedles = [];
doc.findings.idBridge = {
  declaredFks: declaredFks.length,
  chain: bridge,
  relationshipTriggers,
  ordered: main.tables.filter((t) => t.name.startsWith("Z_FOK")).map((t) => t.name),
};
const brokenHops = bridge.filter((h) => !h.resolved).map((h) => h.hop);
doc.verdict.idBridge = brokenHops.length
  ? `PARTIAL — no mechanism found for: ${brokenHops.join(", ")}. A broken accessory->room hop means "turn off the kitchen" is unsayable, forever.`
  : "RESOLVED — every hop in the chain scores a mechanism";

// ─── Q6: the epoch ───────────────────────────────────────────────────────────

const dateCandidates = main.tables
  .filter((t) => t.rows && t.dateColumns.length)
  .toSorted((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
const dateTable = dateCandidates[0] ?? null;
const dateColumn = dateTable?.dateColumns?.[0] ?? null;
const dateMax = dateTable ? maxNumericAsText(main.db, dateTable.name, dateColumn) : null;
const epochProbe = dateMax?.value
  ? detectEpoch(dateMax.value)
  : { tested: false, reason: "no dates" };
doc.findings.dates = {
  table: dateTable?.name ?? null,
  column: dateColumn,
  // The DECLARED TYPE, because a REAL holding fractional CFAbsoluteTime renders
  // `digits` misleading — it counts the decimal point.
  declaredType: dateTable?.columns?.find((c) => c.name === dateColumn)?.type ?? null,
  digits: dateMax?.digits ?? null,
  exceedsSafeInteger: dateMax?.exceedsSafeInteger ?? false,
  ...epochProbe,
};
doc.verdict.epoch = epochProbe.epoch ?? epochProbe.reason ?? "unknown";

// ─── Q8: cost ────────────────────────────────────────────────────────────────

const timed = (label, fn) => {
  const started = performance.now();
  const value = attempt(fn, "error");
  return { label, ms: Math.round(performance.now() - started), value };
};
const biggestTable = main.tables.toSorted((a, b) => (b.rows ?? 0) - (a.rows ?? 0))[0];
const accessoryTable = main.tables.find((t) => t.role === "accessory");
step("cost");
const timings = [
  timed("open", () => {
    const o = openStore(main.fullPath);
    o?.db?.close?.();
    return o?.mode;
  }),
  timed("schema dump", () => dumpSchema(main.db).objectCount),
  timed(`count ${biggestTable?.name ?? "-"}`, () => T.countOf(biggestTable?.name)),
  timed("inventory query", () =>
    accessoryTable ? T.all(`SELECT * FROM "${accessoryTable.name}"`).length : "no accessory table",
  ),
];
doc.findings.cost = timings;
doc.verdict.cost = `${timings.reduce((a, t) => a + t.ms, 0)} ms total (Maps 0 ms, Safari 16 ms, Calendar 3.4 s, Mail 74 s)`;

// ─── Q9: the Shortcuts lane ──────────────────────────────────────────────────

const sh = (cliArgs, timeout = 10_000) =>
  attempt(() =>
    execFileSync("/usr/bin/shortcuts", cliArgs, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

let shortcuts = { tested: false, reason: "--no-shortcuts" };
if (!SKIP_SHORTCUTS) {
  step("shortcuts: enumerating, then scanning workflows for Home action identifiers");
  const listed = sh(["list", "--show-identifiers"]);
  const lines = String(listed ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // A shortcut NAME IS USER DATA — this machine's own list includes personal
  // ones. Only a length, a hash and two booleans ever reach the document.
  const entries = lines.map((line) => {
    const m = /^(.*?)\s*\(([0-9A-Fa-f-]{36})\)$/.exec(line);
    const name = m ? m[1] : line;
    if (m) shortcutNeedles.push({ value: m[2], form: "shortcut-identifier" });
    return {
      nameLength: name.length,
      nameHash: createHash("sha256").update(name).digest("hex").slice(0, 8),
      homeRelated: HOMEISH.test(name),
      identifierPresent: Boolean(m),
    };
  });
  shortcuts = {
    tested: listed !== null,
    // If `list` worked while the store did not, that is the headline: the control
    // lane needs no Full Disk Access at all. Recorded as a MEASUREMENT of this
    // run, not asserted — `blind` comes from the control stores in Q0.
    enumeratedWhileBlind: blind,
    total: entries.length,
    parsed: entries.filter((e) => e.identifierPresent).length,
    unparsed: entries.filter((e) => !e.identifierPresent).length,
    homeRelated: entries.filter((e) => e.homeRelated).length,
    entries,
    classification: {
      method: "name heuristic",
      strength:
        "WEAK — a guess about an English string. `shortcuts view` was rejected: it opens Shortcuts.app and steals focus. The strong method is reading each shortcut's serialised actions for com.apple.HomeKitUI / is.workflow.actions.homeaccessory, attempted below.",
    },
  };

  // The strong classification: action identifiers are Apple constants, safe to
  // print. Best-effort — if the workflow blobs are compressed or sealed, say so
  // and stop rather than build a decoder in phase 0.
  /**
   * RECORD the listability rather than filtering on it. Silently dropping an
   * unreadable directory is failure #1 from the Maps probe reproduced inside
   * this one: without Full Disk Access ~/Library/Shortcuts is EPERM, and a
   * filtered list reports "no action identifiers found" when the truth is "could
   * not look".
   */
  const shortcutDirs = [
    join(H, "Library", "Shortcuts"),
    join(H, "Library", "Group Containers", "group.com.apple.shortcuts"),
  ].map((d) => ({ dir: rel(d), path: d, exists: exists(d), listable: listable(d) }));
  const ACTION_NEEDLES = [
    "com.apple.HomeKitUI",
    "is.workflow.actions.homeaccessory",
    "com.apple.Home",
    "HomeKit",
  ];
  const actionHits = [];
  for (const shortcutDir of shortcutDirs.filter((entry) => entry.listable)) {
    for (const p of sweep(shortcutDir.path, 3).files) {
      if (/-(wal|shm)$/.test(p) || !looksLikeSqlite(p)) continue;
      const o = openStore(p);
      if (!o?.db) continue;
      const ST = tableTools(o.db);
      for (const t of dumpSchema(o.db).tables) {
        for (const c of ST.columnInfo(t)) {
          if (!/BLOB/i.test(String(c.type ?? ""))) continue;
          for (const needle of ACTION_NEEDLES) {
            const hits = ST.one(
              `SELECT COUNT(*) AS c FROM "${t}" WHERE instr(CAST("${c.name}" AS BLOB), CAST(? AS BLOB)) > 0`,
              needle,
            )?.c;
            if (hits)
              actionHits.push({
                file: safeName(basename(p)),
                column: `${t}.${c.name}`,
                needle,
                rows: hits,
              });
          }
          const samples = sampleBlobs(ST, t, c.name, 6);
          if (samples.length && !actionHits.length) {
            const r = classifySamples(samples);
            if (r.verdict !== "PLAINTEXT") {
              actionHits.push({
                file: safeName(basename(p)),
                column: `${t}.${c.name}`,
                needle: null,
                opaque: r.verdict,
                note: "no action identifier found and the blob is not plaintext — classification without running is not possible from here",
              });
            }
          }
        }
      }
      o.db.close?.();
    }
  }
  shortcuts.actionScan = {
    dirs: shortcutDirs.map(({ dir, exists: e, listable: l }) => ({ dir, exists: e, listable: l })),
    searched: shortcutDirs.some((d) => d.listable),
    hits: actionHits,
  };
}

// §9c — RUNNING one. Opt-in, never defaulted, and the hazard is physical.
if (RUN_SHORTCUT) {
  if (HOMEISH.test(RUN_SHORTCUT) && !ACK_REAL_DEVICES) {
    console.error(
      [
        "",
        "REFUSING to run that shortcut.",
        "",
        `  The name you gave matches this probe's home vocabulary, so it may control a`,
        "  REAL DEVICE: a light, a lock, a garage door. This probe only needs to time the",
        "  CLI, which any empty shortcut does.",
        "",
        '  Create a shortcut containing one "Nothing" action, name it',
        '  "Cupertino Probe No-Op", and pass that instead.',
        "",
        "  If you genuinely meant it, re-run with --i-understand-real-devices.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
  console.error(
    `\nrunning a shortcut. This executes real automation and MAY ACTUATE A PHYSICAL DEVICE.\n`,
  );
  const wasRunning = isRunning("com.apple.shortcuts");
  const runOnce = () => {
    const started = performance.now();
    try {
      execFileSync("/usr/bin/shortcuts", ["run", RUN_SHORTCUT], {
        encoding: "utf8",
        timeout: SHORTCUT_TIMEOUT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, ms: Math.round(performance.now() - started) };
    } catch (err) {
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        // An error can echo the shortcut's own name.
        error: maskIdentity(String(err?.stderr || err?.message || err)).slice(0, 300),
      };
    }
  };
  const runs = [runOnce(), runOnce()];
  const nowRunning = isRunning("com.apple.shortcuts");
  // A TCC dialog manifests as the child blocking. Slow-then-fast IS the prompt.
  const outcome = runs.every((r) => r.ok)
    ? runs[0].ms > 2000 && runs[1].ms < runs[0].ms / 2
      ? "PROMPTED"
      : "SILENT"
    : "REFUSED";
  doc.findings.shortcutRun = {
    nameLength: RUN_SHORTCUT.length,
    nameHash: createHash("sha256").update(RUN_SHORTCUT).digest("hex").slice(0, 8),
    runs,
    outcome,
    launchedShortcutsApp: !wasRunning && nowRunning,
  };
  doc.verdict.shortcutRun =
    outcome === "SILENT"
      ? "SILENT — the escape hatch is viable unattended, and it needed no Full Disk Access"
      : outcome === "PROMPTED"
        ? "PROMPTED — the first run blocked on a grant dialog. Permissions.swift would owe a new state, the way Safari's JavaScript-from-Apple-Events toggle already does."
        : "REFUSED — a child process cannot run one, so the surface is read-only";
}

// The one place the two lanes touch: does anything in the HomeKit store
// reference a Shortcut? Hits are reported as table.column, never the needle.
// findIdBridge costs one full scan per (text column x needle), so the needle
// list is capped: 200 shortcuts would otherwise turn a cheap question into the
// slowest section of the run.
const NEEDLE_CAP = 12;
const needles = [
  ...shortcutNeedles.slice(0, NEEDLE_CAP),
  ...(NEEDLE ? [{ value: NEEDLE, form: "--needle" }] : []),
];
doc.findings.crossLane = findIdBridge(
  main.db,
  main.tables.map((t) => t.name),
  (t) => T.columnInfo(t),
  needles,
);
doc.findings.shortcuts = shortcuts;
doc.verdict.shortcuts = !shortcuts.tested
  ? "not enumerated"
  : `${shortcuts.total} shortcuts, ${shortcuts.homeRelated} home-related by name (weak), ` +
    `${shortcuts.actionScan?.hits?.filter((h) => h.needle).length ?? 0} confirmed by action identifier`;

doc.verdict.lane =
  "file lane only for reads; Shortcuts for control. HomeKit.framework and Apple Events are both closed — see the header.";
doc.verdict.store = `${main.file} — ${main.totalRows} rows, ${main.tableCount} tables, vocabulary score ${main.vocabScore}`;

// ─── redaction gate ──────────────────────────────────────────────────────────
// The --json document must be as safe to paste as the human report. This is the
// belt to `delete doc.findings.liveTabs.urls`'s braces in probe-safari.mjs: a
// walk that FAILS the run rather than trusting every call site above.

const assertRedacted = (node, path = "$") => {
  if (typeof node === "string") {
    for (const [re, what] of SHAPES) {
      if (re.test(node)) {
        console.error(
          `\nREDACTION FAILURE at ${path}: the document contains something shaped like a ${what}.\n` +
            "Refusing to print it. Fix the section that produced it rather than relaxing this check.\n",
        );
        process.exit(5);
      }
    }
    return;
  }
  if (Array.isArray(node)) return node.forEach((v, i) => assertRedacted(v, `${path}[${i}]`));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) assertRedacted(v, `${path}.${k}`);
  }
};
step("done");
assertRedacted(doc);

// ─── report ──────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Home probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(`Directory: ${doc.dir}`);
  L.push("");
  L.push("FILES — classified by magic bytes, not by extension");
  if (doc.findings.files.identifierNamedFiles) {
    L.push(
      `  ${doc.findings.files.identifierNamedFiles} of ${doc.findings.files.count} files are NAMED AFTER A DEVICE IDENTIFIER —`,
    );
    L.push("  the listing alone is a partial inventory of the house. Names masked below.");
  }
  for (const f of doc.findings.files.seen) {
    L.push(`  ${pad(f.base, 30)} ${pad(f.kind, 18)} ${String(f.sizeBytes ?? "-").padStart(10)} B`);
  }
  for (const unreadable of doc.findings.files.dirs.filter((entry) => !entry.listable)) {
    L.push(`  ${unreadable.dir}  NOT LISTABLE — this is EPERM, not emptiness`);
  }
  L.push("");
  L.push(
    "STORES — MAIN is the store with most rows in role-bearing tables, not the best name score",
  );
  for (const s of doc.findings.stores) {
    L.push(
      `  ${pad(s.file, 28)} ${pad(`${s.tableCount}t/${s.entityCount}e`, 10)} ` +
        `${String(s.totalRows).padStart(7)} rows  ${String(s.roleRows).padStart(6)} in roles  ` +
        `score ${String(s.vocabScore).padStart(3)}  ${pad(s.mode, 8)} ${s.isMain ? "<-- MAIN" : ""}`,
    );
  }
  L.push("");
  L.push("ENCRYPTION — THE GO/NO-GO. Statistics only; no value is ever read out.");
  L.push(`  ${doc.verdict.encrypted}`);
  for (const [file, e] of Object.entries(doc.findings.encryption)) {
    L.push(
      `  ${pad(file, 28)} text ${String(e.textBytes).padStart(9)} B in ${e.textColumns} cols, ` +
        `${e.humanScaleTextColumns} human-scale, longest ${e.longestTextColumn}`,
    );
    for (const b of e.blobVerdicts) {
      L.push(
        `      ${pad(`${b.table}.${b.column}`, 40)} ${pad(b.verdict, 26)} ${b.sampled} samples` +
          (b.magic?.show
            ? `  magic ${b.magic.magic ?? b.magic.containers?.join("/")}`
            : `  ${b.magic?.reason ?? ""}`),
      );
    }
    if (e.keyColumns.length) L.push(`      KEY MATERIAL: ${e.keyColumns.join(", ")}`);
  }
  L.push("  Reminder: high entropy does not separate ENCRYPTED from COMPRESSED. Every");
  L.push("  verdict above tried to inflate first, and re-scored the inflated bytes.");
  L.push("");
  L.push("TABLES — Apple's schema, safe to print. Row counts, never a row.");
  for (const t of doc.findings.tables.filter((entry) => entry.rows)) {
    L.push(
      `  ${pad(t.name, 34)} ${pad(t.role, 15)} ${String(t.rows).padStart(7)} rows  ` +
        `${t.columnCount} cols  ${t.blobColumns} blob` +
        (t.stateColumns.length ? `  state: ${t.stateColumns.join(",")}` : ""),
    );
  }
  L.push("");
  L.push("LIVE STATE");
  L.push(`  ${doc.verdict.liveState}`);
  for (const m of doc.findings.liveState.temporal.moved ?? []) {
    L.push(
      `      ${pad(m.table, 34)} ${String(m.rowDelta > 0 ? `+${m.rowDelta}` : m.rowDelta).padStart(6)} rows` +
        `${m.dateMoved ? "  date advanced" : ""}` +
        `${m.role ? `   <-- ${m.role.toUpperCase()}, this is the signal` : "   (sync table, ignored)"}`,
    );
  }
  L.push("");
  L.push("EVENT HISTORY");
  L.push(`  ${doc.verdict.history}`);
  L.push("");
  L.push("ID BRIDGE — scored by joining, never by column name");
  for (const h of doc.findings.idBridge.chain) {
    L.push(
      `  ${pad(h.hop, 26)} ${h.resolved ? `${h.best.mechanism} ${h.best.from} -> ${h.best.to} (${h.best.coverage ?? "?"})` : `NOT FOUND — ${h.reason ?? "no candidate scored"}`}`,
    );
  }
  for (const t of doc.findings.idBridge.relationshipTriggers) {
    L.push(
      `      trigger ${t.name} names ${t.mentions.join(" + ")} — Apple stating the relationship`,
    );
  }
  L.push("");
  L.push("DATES");
  L.push(
    `  ${doc.findings.dates.table ?? "-"}.${doc.findings.dates.column ?? "-"} ` +
      `(${doc.findings.dates.declaredType ?? "?"})  ${doc.verdict.epoch}` +
      (doc.findings.dates.exceedsSafeInteger
        ? "  EXCEEDS SAFE INTEGER — read as BigInt or TEXT"
        : ""),
  );
  for (const c of doc.findings.dates.considered ?? []) {
    const chosen = c.epoch === doc.findings.dates.epoch;
    L.push(
      `      ${chosen ? "CHOSEN:  " : "rejected:"} ${pad(c.epoch, 20)} year ${c.year}  plausible=${c.plausible}`,
    );
  }
  L.push("");
  L.push("WAL");
  L.push(`  ${doc.verdict.walBlind}`);
  L.push("");
  L.push("COST");
  for (const t of doc.findings.cost) L.push(`  ${pad(t.label, 28)} ${t.ms} ms -> ${t.value}`);
  L.push("");
  L.push("SHORTCUTS — the control lane");
  L.push(`  ${doc.verdict.shortcuts}`);
  L.push(`  names are hashed, never printed: ${shortcuts.entries?.length ?? 0} recorded`);
  if (shortcuts.actionScan && !shortcuts.actionScan.searched) {
    L.push(
      "      action scan COULD NOT LOOK — " +
        shortcuts.actionScan.dirs
          .map((entry) => `${entry.dir} ${entry.exists ? "EPERM" : "absent"}`)
          .join(", ") +
        ". That is not the same as finding nothing.",
    );
  }
  for (const h of shortcuts.actionScan?.hits ?? []) {
    L.push(`      ${pad(h.column, 34)} ${h.needle ?? h.opaque}  ${h.rows ?? ""} ${h.note ?? ""}`);
  }
  if (doc.verdict.shortcutRun) L.push(`  run: ${doc.verdict.shortcutRun}`);
  L.push("");
  L.push("VERDICT");
  for (const [k, v] of Object.entries(doc.verdict)) L.push(`  ${pad(k, 12)}: ${v}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "home",
    file: "home-store.sql",
    ddlRows: main.schema.ddlRows,
    macos: doc.macos,
    fingerprint: main.fingerprint,
    tool: "scripts/probe-home.mjs",
  });
}
