// Shared mechanism for the phase-0 probes.
//
// The first three probes (envelope-index, notes, reminders) each carried their
// own copy of this code, which was fine at three and stops being fine at six.
// What lives here is only the part that is genuinely identical across surfaces:
// the osascript boundary, the exists-vs-readable split, the read-only SQLite
// ladder, the schema dump, the id-bridge scan and the fixture writer.
//
// What does NOT live here is every question a probe actually asks. Those are
// surface-shaped by definition, and hoisting them would turn a spike into a
// framework. A probe should still read top-to-bottom as an argument about one
// app.
//
// Dependency-free on purpose (node builtins only), like the probes themselves.
// Nothing here writes to a store, ever.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Core Data stores seconds since 2001-01-01. */
export const APPLE_EPOCH_OFFSET = 978_307_200;

/** Outside this range an epoch guess is wrong, however plausible the number looks. */
export const sane = (d) => d instanceof Date && d.getFullYear() >= 2001 && d.getFullYear() <= 2100;

/** Core Data spells strings VARCHAR; LENGTH() on an INTEGER lies, so check the type. */
export const isTextType = (t) => /CHAR|CLOB|TEXT/i.test(String(t ?? ""));

/** Apple Events ids often arrive as `x-apple-<thing>://<uuid>`; stores keep the bare uuid. */
export const uuidOf = (id) => /([0-9A-Fa-f-]{36})/.exec(String(id))?.[1] ?? null;

export const yn = (b) => (b === null || b === undefined ? "?" : b ? "yes" : "no");

export const safe = (fn, onErr) => {
  try {
    return fn();
  } catch (err) {
    return onErr ? onErr(err) : { ok: false, error: String(err?.message ?? err) };
  }
};

/**
 * The exists-vs-readable split, which is the whole shape of a TCC failure and
 * the reason `packages/core/src/fs.ts` exists.
 *
 * `stat` SUCCEEDS on a file the sandbox will not let you open — the same trap
 * `app/Cupertino/Permissions.swift` documents. So "the file is not there" and
 * "you may not read it" are different findings and a probe must never conflate
 * them: one means the surface has no file lane, the other means run it again
 * with Full Disk Access.
 */
export const readable = (p) =>
  safe(
    () => {
      accessSync(p, constants.R_OK);
      return true;
    },
    () => false,
  );

export const exists = (p) =>
  safe(
    () => Boolean(statSync(p)),
    () => false,
  );

const sizeOf = (p) =>
  safe(
    () => statSync(p).size,
    () => null,
  );

/** Everything worth saying about a candidate store file without opening it. */
export const fileFacts = (path) => ({
  path,
  exists: exists(path),
  readable: readable(path),
  sizeBytes: sizeOf(path),
  // A -wal that dwarfs the database means an immutable=1 read would be blind to
  // most of the content. Worth knowing before trusting any count below.
  walSizeBytes: sizeOf(`${path}-wal`),
  shmSizeBytes: sizeOf(`${path}-shm`),
});

export const macosVersion = () =>
  safe(
    () => execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    () => null,
  );

// ─── osascript, exactly as packages/core/src/osascript.ts does it ─────────────
// The script is a static constant piped to stdin; every variable input arrives
// as argv[0]. Nothing is interpolated into script text, ever — `assertStaticScript`
// rejects a script containing a template placeholder, and these obey the same rule
// so that what a probe measures is what a server will run.

export const osascript = (script, params, timeout = 180_000) => {
  const out = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", JSON.stringify(params ?? {})],
    { input: script, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
};

/** Time an Apple Event round trip. A timeout is itself an answer, so record it. */
export const timed = (label, script, params, timeout) => {
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

/**
 * Is the target app already running?
 *
 * Asked through NSRunningApplication rather than by talking to the app, so it
 * does NOT itself trigger an Automation prompt and does not launch anything.
 * Every probe checks this first for the reason the read tools do: launching an
 * Apple app steals focus and kicks off a sync, which is a rude thing to do to
 * someone who only asked for a measurement.
 */
const IS_RUNNING = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("AppKit");
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(p.bundleId);
  return JSON.stringify({ running: apps.count > 0 });
}
`;

export const isRunning = (bundleId) =>
  safe(
    () => osascript(IS_RUNNING, { bundleId }, 10_000).running,
    () => false,
  );

/**
 * Whether the Apple Events half may run, WITHOUT launching anything.
 *
 * Refusing to launch is the same courtesy the read tools extend: starting an
 * Apple app steals focus and kicks off a sync, which is a rude thing to do to
 * someone who only asked for a measurement.
 *
 * But refusing to launch is NOT a reason to abandon the whole probe. The
 * earlier probes exited here, which was right for them — Reminders' questions
 * are all Apple Events questions. It is wrong for a probe whose central question
 * is where a store lives, because that needs no Apple Event at all. So this
 * reports a status and lets the caller degrade, which is the same rule the
 * probes already apply to a missing permission: print the finding, do not crash.
 *
 * The caller is expected to record `reason` in its report, so a run that skipped
 * half its questions never reads as a run that answered them.
 */
export const appleEventsLane = (bundleId, appName, allowLaunch) => {
  const running = isRunning(bundleId);
  if (running) return { running: true, available: true, reason: null };
  if (allowLaunch) {
    return { running: false, available: true, reason: `${appName} will be launched (--launch)` };
  }
  return {
    running: false,
    available: false,
    reason:
      `${appName} is not running, and this probe will not launch it — that steals focus and ` +
      `kicks off a sync. Open ${appName} and re-run, or pass --launch. The file lane below still ran.`,
  };
};

// ─── read-only SQLite ────────────────────────────────────────────────────────

/**
 * SQLite URI filenames need percent-encoding — Mail's path contains a space
 * ("Envelope Index"), and `?`/`#` would otherwise read as URI syntax.
 * Same function as `packages/core/src/sqlite.ts`, kept in step deliberately.
 */
export const toFileUri = (path, query) =>
  `file:${encodeURI(path).replaceAll("?", "%3f").replaceAll("#", "%23")}?${query}`;

/**
 * The ro → immutable ladder from `packages/core/src/sqlite.ts`, and the reason
 * it is a ladder rather than a choice:
 *
 * `immutable=1` tells SQLite the file cannot change and to skip the `-wal`
 * entirely, so a read silently misses anything not yet checkpointed. Measured on
 * a live Mail index, the two modes disagreed by exactly one newly-arrived
 * message. A probe that opened immutable and did not say so would publish counts
 * that cannot be reproduced.
 *
 * So: try `mode=ro` first, fall back, and RECORD WHICH ONE WON. A store that
 * only opens immutable is a finding about that surface, not an implementation
 * detail to swallow.
 */
export const openStore = (path) => {
  let lastError = null;
  for (const attempt of ["ro", "immutable"]) {
    try {
      const started = performance.now();
      const db = new DatabaseSync(toFileUri(path, attempt === "ro" ? "mode=ro" : "immutable=1"), {
        readOnly: true,
        allowExtension: false,
      });
      // Belt and braces: nothing below can issue DML even by accident.
      db.exec("PRAGMA query_only = 1");
      return {
        db,
        mode: attempt,
        openMs: Math.round(performance.now() - started),
        walBlind: attempt === "immutable",
        sqlite: safe(
          () => db.prepare("SELECT sqlite_version() AS v").get().v,
          () => null,
        ),
      };
    } catch (err) {
      lastError = err;
    }
  }
  return { db: null, mode: null, error: String(lastError?.message ?? lastError) };
};

/**
 * Every CREATE statement, ordered so the dump is replayable.
 *
 * sqlite_master's natural "type, name" ordering puts every CREATE INDEX before
 * the tables it indexes, which makes a straight dump fail on replay — and the
 * offline tests build their database from exactly this dump.
 */
export const dumpSchema = (db) => {
  const ddlRows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`,
    )
    .all()
    // sqlite_sequence is created implicitly by AUTOINCREMENT and cannot be declared.
    .filter((r) => r.name !== "sqlite_sequence");
  return {
    ddlRows,
    objectCount: ddlRows.length,
    tables: ddlRows.filter((r) => r.type === "table").map((r) => r.name),
    views: ddlRows.filter((r) => r.type === "view").map((r) => r.name),
    fingerprint: createHash("sha256")
      .update(ddlRows.map((r) => r.sql).join("\n"))
      .digest("hex")
      .slice(0, 12),
  };
};

/** Table-shaped helpers bound to one database, each swallowing its own errors. */
export const tableTools = (db) => ({
  columnInfo: (t) =>
    safe(
      () => db.prepare(`PRAGMA table_info("${t}")`).all(),
      () => [],
    ),
  countOf: (t) =>
    safe(
      () => db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c,
      () => null,
    ),
  one: (sql, ...params) =>
    safe(
      () => db.prepare(sql).get(...params),
      () => null,
    ),
  all: (sql, ...params) =>
    safe(
      () => db.prepare(sql).all(...params),
      () => [],
    ),
});

/**
 * THE ID BRIDGE SCAN.
 *
 * Guessing which column joins a store row to the identifier Apple Events hands
 * back would be the same mistake the Notes decoder made: a plausible answer that
 * was silently wrong about half the corpus. So don't guess. Take a real
 * identifier from the live app and search every TEXT column of every table for
 * it. Whatever comes back IS the bridge, by construction.
 *
 * No bridge means the two lanes are two disconnected halves, and the file lane
 * can only ever answer queries it can also fully resolve by itself. That is a
 * design constraint, not a detail — which is why it gets its own section in
 * every report.
 */
export const findIdBridge = (db, tables, columnInfo, needles) => {
  const usable = needles.filter((n) => n.value);
  if (!usable.length) return { tested: false, reason: "no live identifier to search for" };
  const hits = [];
  let scanned = 0;
  for (const t of tables) {
    for (const c of columnInfo(t)) {
      if (!isTextType(c.type)) continue;
      scanned += 1;
      for (const n of usable) {
        const found = safe(
          () => db.prepare(`SELECT COUNT(*) AS c FROM "${t}" WHERE "${c.name}" = ?`).get(n.value).c,
          () => null,
        );
        if (found) hits.push({ table: t, column: c.name, form: n.form, rows: found });
      }
    }
  }
  return { tested: true, textColumnsScanned: scanned, hits, found: hits.length > 0 };
};

/**
 * Which epoch a numeric date column uses, decided by whether the result is a
 * plausible date rather than by what the column is named.
 *
 * Three candidates, because Apple uses all three: seconds since 2001 (Core
 * Data), nanoseconds since 2001 (Messages since macOS 10.13), and plain Unix
 * seconds. Getting this wrong is a 31-year error that still renders as a date.
 */
export const detectEpoch = (maxValue) => {
  if (!maxValue || !Number.isFinite(Number(maxValue))) {
    return { tested: false, reason: "no dates present" };
  }
  const n = Number(maxValue);
  const candidates = [
    {
      name: "apple-nanoseconds",
      date: new Date((n / 1e9 + APPLE_EPOCH_OFFSET) * 1000),
      divisor: 1e9,
      offset: APPLE_EPOCH_OFFSET,
    },
    {
      name: "apple-seconds",
      date: new Date((n + APPLE_EPOCH_OFFSET) * 1000),
      divisor: 1,
      offset: APPLE_EPOCH_OFFSET,
    },
    { name: "unix-seconds", date: new Date(n * 1000), divisor: 1, offset: 0 },
    { name: "unix-milliseconds", date: new Date(n), divisor: 1e-3, offset: 0 },
  ];
  const won = candidates.find((c) => sane(c.date));
  return won
    ? {
        tested: true,
        epoch: won.name,
        divisor: won.divisor,
        offset: won.offset,
        latestYear: won.date.getFullYear(),
      }
    : { tested: true, epoch: "unknown", checked: candidates.map((c) => c.name) };
};

/**
 * Bounded directory walk. Every probe needs one and every probe needs it capped:
 * these trees can be enormous, and a probe that takes ten minutes to count files
 * nobody asked about will simply not be run.
 */
export const walkDir = (root, { maxDepth = 3, onFile } = {}) => {
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else onFile?.(p, e, depth);
    }
  };
  walk(root, 0);
};

export const listable = (dir) =>
  safe(
    () => {
      readdirSync(dir);
      return true;
    },
    () => false,
  );

/**
 * `--write`: capture the DDL as the fixture the offline tests build from.
 *
 * Schema only. Never a row. The whole point of the offline test suite is that it
 * runs on a machine with no Full Disk Access and nobody's real data.
 */
export const writeFixture = ({ root, pkg, file, ddlRows, macos, fingerprint, tool }) => {
  if (!ddlRows) {
    console.error("\n--write needs the file lane. Grant Full Disk Access and re-run.");
    process.exit(3);
  }
  const dest = join(root, "packages", pkg, "test", "fixtures", file);
  mkdirSync(dirname(dest), { recursive: true });
  const sql = [
    `-- Captured from a real store by ${tool} --write.`,
    `-- macOS ${macos}, fingerprint ${fingerprint}, ${ddlRows.length} objects.`,
    "-- Schema only. No data.",
    "",
    ...ddlRows.map((r) => `${r.sql};`),
  ].join("\n");
  writeFileSync(dest, `${sql}\n`);
  console.log(`\nwrote ${dest.replace(`${root}/`, "")}`);
};

/** The flag set every probe shares. */
export const parseArgs = (argv) => {
  const has = (f) => argv.includes(f);
  const valueOf = (name, fallback) =>
    (argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).slice(
      name.length + 3,
    );
  return {
    json: has("--json"),
    launch: has("--launch"),
    write: has("--write"),
    term: valueOf("term", "a"),
    has,
    valueOf,
  };
};
