#!/usr/bin/env node
// Measure what a watcher on Mail or Messages could trigger on, before building one.
//
// Usage: node scripts/spike-watch-arrivals.mjs <dir> <db> [--table message|messages]
//          [--debounce <ms>]
//
// Mail:     node scripts/spike-watch-arrivals.mjs ~/Library/Mail/V10/MailData \
//             "~/Library/Mail/V10/MailData/Envelope Index"
// Messages: node scripts/spike-watch-arrivals.mjs ~/Library/Messages \
//             ~/Library/Messages/chat.db
//
// The incoming-watches design needs three numbers it cannot guess: does
// `fs.watch` fire for the `-wal` file when a message arrives, how long after the
// message shows up in the app, and what the "anything new?" query costs. This
// logs one line per event and times that query, nothing else.
//
// ## What it does
//
// `fs.watch(<dir>)` logs `{ at, via, event, filename }` as JSON for every event,
// and so does a second watcher on `<db>-wal` itself (see the comment at
// `armWal`: a directory watch does not see appends). After 500 ms without a
// further event it opens `<db>` read-only, times
// `SELECT max(ROWID) FROM <table>`, closes it and logs `{ at, query }` with the
// elapsed milliseconds and the value. Mail's table is `messages`, Messages' is
// `message`; it is detected from `sqlite_master` unless `--table` is given.
//
// ## What it does not do
//
// No Apple Events, no driving, no writes. The database is opened with
// `mode=ro`, never `immutable=1`: an immutable handle skips the WAL, so it would
// not see the very rows this is trying to detect (see `toFileUri` and `openStore`
// in packages/core/src/sqlite.ts). Reading Mail's or Messages' directory needs
// Full Disk Access for the terminal running this.
//
// Stop with Ctrl-C. Timestamps are ISO, so `at` can be compared by eye with the
// moment a message appeared in the app.

import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const tableFlag = flag("--table");
const debounceMs = Number(flag("--debounce") ?? 500);
const expand = (p) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);
const [dirArg, dbArg] = args;
if (!dirArg || !dbArg || (tableFlag && !["message", "messages"].includes(tableFlag))) {
  console.error(
    "usage: spike-watch-arrivals.mjs <dir> <db> [--table message|messages] [--debounce <ms>]",
  );
  process.exit(2);
}
const dir = expand(dirArg);
const dbPath = expand(dbArg);

// Same encoding as packages/core/src/sqlite.ts: Mail's path has a space.
const toFileUri = (path, query) =>
  `file:${encodeURI(path).replaceAll("?", "%3f").replaceAll("#", "%23")}?${query}`;

const log = (record) => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));

const openRo = () => {
  const db = new DatabaseSync(toFileUri(dbPath, "mode=ro"), {
    readOnly: true,
    allowExtension: false,
  });
  db.exec("PRAGMA query_only = 1");
  return db;
};

const detectTable = (db) => {
  if (tableFlag) return tableFlag;
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const found = ["messages", "message"].find((name) => names.has(name));
  if (!found) throw new Error(`neither "messages" nor "message" in ${dbPath}`);
  return found;
};

let table;
{
  const db = openRo();
  try {
    table = detectTable(db);
  } finally {
    db.close();
  }
}
log({ start: { dir, db: dbPath, table, debounceMs } });

const query = () => {
  const db = openRo();
  try {
    const t0 = performance.now();
    const row = db.prepare(`SELECT max(ROWID) AS m FROM ${table}`).get();
    const ms = Number((performance.now() - t0).toFixed(3));
    log({ query: { ms, maxRowid: row.m } });
  } catch (err) {
    log({ queryError: err instanceof Error ? err.message : String(err) });
  } finally {
    db.close();
  }
};

let timer;
const trigger = () => {
  clearTimeout(timer);
  timer = setTimeout(query, debounceMs);
};

// A directory watch reports files being created, renamed and removed, but not
// bytes appended to a file that already exists, and a WAL commit is an append.
// So the `-wal` file gets its own watcher too, re-armed whenever the directory
// reports it appearing, because SQLite deletes it when the last connection
// closes. Events from it are tagged `via: "file"`.
const walName = `${basename(dbPath)}-wal`;
let walWatcher;
const armWal = () => {
  walWatcher?.close();
  try {
    walWatcher = watch(`${dbPath}-wal`, (event, filename) => {
      log({ via: "file", event, filename });
      trigger();
    });
    walWatcher.on("error", () => {});
  } catch {
    walWatcher = undefined; // no -wal yet; the directory watch re-arms on creation
  }
};
armWal();

const watcher = watch(dir, (event, filename) => {
  log({ via: "dir", event, filename });
  if (filename === walName) armWal();
  trigger();
});
watcher.on("error", (err) => {
  log({ watchError: err.message });
  process.exit(1);
});
process.on("SIGINT", () => {
  watcher.close();
  walWatcher?.close();
  process.exit(0);
});
