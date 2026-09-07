#!/usr/bin/env node
// Spike: is there a Maps store behind the Full Disk Access grant?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// An earlier sweep concluded "Maps keeps nothing on disk". That conclusion was
// WRONG, and the way it was wrong is the exact trap `docs/surfaces.md` records:
//
//     "'Absent' and 'EPERM' are different findings — one means the surface has
//      no file lane, the other means run it again with the grant. Conflating
//      them is what put Calendar on a path toward EventKit it never needed."
//
// `find` was run over `~/Library/Group Containers/group.com.apple.Maps`, could
// not descend into it, returned only the directory itself, and that was read as
// "the directory is empty". It is not empty. It is `stat` OK and `access` EPERM
// — something is there that the probing process was not allowed to open — and
// the process doing the probing turned out to hold NO Full Disk Access at all.
// Every "no data" claim it made about a protected path was worthless.
//
// So this file leads with the instrument, not the measurement. It REFUSES to
// report a negative result unless it can first prove it could have seen a
// positive one.
//
// ── THE POSITIVE EVIDENCE THAT SOMETHING IS THERE ────────────────────────────
//
// Watching the filesystem while a place was saved by hand showed exactly one
// meaningful write: `com.apple.Maps/Data/CloudKit/cloudd_db/db-wal`, 0 -> 173 KB.
// That database holds one CloudKit record, in zone
// `com.apple.coredata.cloudkit.zone`, of record type **`CD_HistoryItem`**.
//
// The `CD_` prefix is `NSPersistentCloudKitContainer` — Core Data mirroring. It
// mirrors FROM a local Core Data store. So a local store should exist, and the
// only Maps-owned directory that has never been read is the group container.
//
// ── WHAT THIS ANSWERS ────────────────────────────────────────────────────────
//
//     0. DOES THIS PROCESS HOLD FULL DISK ACCESS? Tested against four stores
//        that are known to be gated and known to exist, because they back
//        shipped surfaces. If they are unreadable, the run stops: a negative
//        from a blind process is not a finding.
//     1. WHAT IS INSIDE group.com.apple.Maps? Every file, and every SQLite
//        found by MAGIC BYTES rather than by extension.
//     2. IS THERE A CORE DATA STORE, AND WHAT ENTITIES DOES IT HOLD? Entity
//        names come from `Z_PRIMARYKEY`. A `ZFAVORITE` / `ZCOLLECTION` /
//        `ZGUIDE` / `ZPLACE` entity is the whole question.
//     3. HOW MANY ROWS PER ENTITY? Counts only.
//     4. IS IT WAL-BLIND? A `-wal` larger than its database means an
//        `immutable=1` read is looking at history, which is how
//        `PDPlaceCache.db` produced a stale July snapshot earlier.
//     5. DOES STICKIES REALLY NEED FULL DISK ACCESS? Measured without the grant,
//        its container was READABLE while Notes' was EPERM. If that holds, the
//        planned `storePermission: "full-disk-access"` is wrong and Stickies is
//        the first surface that needs no grant. Run this file BOTH with and
//        without the grant; each run prints which it was.
//
// PRIVACY. Schema only: file names, table names, column names, entity names and
// row COUNTS. It never reads a row, and never prints a place, an address or a
// coordinate. Saved places are somebody's home, doctor and school.
//
//   node scripts/spike-maps-store.mjs
//   node scripts/spike-maps-store.mjs --json

import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { openSync, closeSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const H = homedir();
const JSON_OUT = process.argv.includes("--json");
const short = (p) => p.replace(H, "~");
const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

// `access` rather than `stat`: stat SUCCEEDS on a TCC-protected file.
const readable = (p) => safe(() => (accessSync(p, constants.R_OK), true), false);
const exists = (p) => safe(() => Boolean(statSync(p)), false);
const sizeOf = (p) => safe(() => statSync(p).size, null);

// ─── Q0: the instrument check ────────────────────────────────────────────────
// Four stores that are gated AND known to exist, because shipped surfaces read
// them. If these are EPERM, this process is blind and must say so.
const CONTROLS = {
  "Safari history": `${H}/Library/Safari/History.db`,
  "Messages chat.db": `${H}/Library/Messages/chat.db`,
  "Notes store": `${H}/Library/Group Containers/group.com.apple.notes`,
  "Calendar store": `${H}/Library/Group Containers/group.com.apple.calendar`,
};

const controls = Object.fromEntries(
  Object.entries(CONTROLS).map(([k, p]) => [
    k,
    { path: short(p), exists: exists(p), readable: readable(p) },
  ]),
);
const present = Object.values(controls).filter((c) => c.exists);
const grantedCount = present.filter((c) => c.readable).length;
const hasFDA = present.length > 0 && grantedCount === present.length;

// ─── the search ──────────────────────────────────────────────────────────────

const ROOTS = [
  `${H}/Library/Group Containers/group.com.apple.Maps`,
  `${H}/Library/Containers/com.apple.Maps`,
  `${H}/Library/Containers/com.apple.geod`,
  `${H}/Library/Containers/com.apple.Maps~iosmac`,
];

const isSqlite = (p) =>
  safe(() => {
    const fd = openSync(p, "r");
    try {
      const b = Buffer.alloc(15);
      readSync(fd, b, 0, 15, 0);
      return b.toString("latin1") === "SQLite format 3";
    } finally {
      closeSync(fd);
    }
  }, false);

const walk = (root, depth = 0, acc = []) => {
  if (depth > 8) return acc;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    acc.push({ dir: root, error: err.code });
    return acc;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, depth + 1, acc);
    else acc.push({ file: p, size: sizeOf(p) });
  }
  return acc;
};

// Entity names live in Z_PRIMARYKEY. That is SCHEMA, not anyone's data.
const WANTED = /FAVORIT|COLLECTION|GUIDE|PLACE|PIN|HISTORY|BOOKMARK|SAVED|CONTACT|MAPITEM/i;

const inspect = (p) => {
  const out = { path: short(p), sizeBytes: sizeOf(p), mode: null, walBytes: sizeOf(`${p}-wal`) };
  out.walBlind = out.walBytes != null && out.sizeBytes != null && out.walBytes > out.sizeBytes;
  let db = null;
  for (const [mode, uri] of [
    ["ro", `file://${encodeURI(p)}?mode=ro`],
    ["immutable", `file://${encodeURI(p)}?immutable=1`],
  ]) {
    try {
      db = new DatabaseSync(uri, { readOnly: true });
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      out.mode = mode;
      break;
    } catch (err) {
      out.error = err.message.slice(0, 80);
      db = null;
    }
  }
  if (!db) return out;
  const tables = safe(
    () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    [],
  );
  out.tableCount = tables.length;
  out.isCoreData = tables.includes("Z_PRIMARYKEY");
  if (out.isCoreData) {
    out.entities = safe(
      () =>
        db
          .prepare("SELECT Z_NAME AS name, Z_ENT AS ent FROM Z_PRIMARYKEY ORDER BY Z_NAME")
          .all()
          .map((r) => {
            const table = `Z${String(r.name).toUpperCase()}`;
            const rows = safe(() => db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get().c, null);
            return { name: r.name, rows };
          }),
      [],
    );
    out.interesting = (out.entities ?? []).filter((e) => WANTED.test(e.name));
  } else {
    out.interestingTables = tables.filter((t) => WANTED.test(t));
  }
  return out;
};

const roots = ROOTS.map((r) => {
  const listed = exists(r) ? walk(r) : [];
  const files = listed.filter((x) => x.file);
  const errors = listed.filter((x) => x.error);
  const sqlite = files.filter((f) => isSqlite(f.file)).map((f) => inspect(f.file));
  return {
    root: short(r),
    exists: exists(r),
    readable: readable(r),
    files: files.length,
    unreadableDirs: errors.length,
    firstError: errors[0]?.error ?? null,
    sqlite,
  };
});

// ─── Q5: does Stickies need the grant? ───────────────────────────────────────
const stickies = `${H}/Library/Containers/com.apple.Stickies/Data/Library/Stickies`;
const stickiesCheck = {
  path: short(stickies),
  exists: exists(stickies),
  readable: readable(stickies),
};

const allSqlite = roots.flatMap((r) => r.sqlite);
const coreData = allSqlite.filter((s) => s.isCoreData);
const hits = allSqlite.flatMap((s) =>
  (s.interesting ?? []).map((e) => ({ store: s.path, entity: e.name, rows: e.rows })),
);

const doc = {
  tool: "scripts/spike-maps-store.mjs",
  at: new Date().toISOString(),
  question0: { hasFullDiskAccess: hasFDA, controls },
  roots,
  coreDataStores: coreData.length,
  hits,
  stickies: stickiesCheck,
};

if (JSON_OUT) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push("Maps store spike");
  L.push("");
  L.push("QUESTION 0 — CAN THIS PROCESS SEE ANYTHING? (checked before any claim)");
  for (const [k, c] of Object.entries(controls)) {
    L.push(
      `  ${k.padEnd(18)} exists=${c.exists ? "yes" : "no "}  readable=${c.readable ? "YES" : "NO"}`,
    );
  }
  L.push(`  >> Full Disk Access: ${hasFDA ? "GRANTED" : "NOT GRANTED"}`);
  if (!hasFDA) {
    L.push("");
    L.push("  A NEGATIVE RESULT BELOW MEANS NOTHING. This process cannot open the");
    L.push("  stores that shipped surfaces read every day, so it cannot tell an");
    L.push("  empty directory from a forbidden one — which is exactly the mistake");
    L.push("  that produced the wrong answer the first time.");
    L.push("  Grant Full Disk Access to whatever runs this, then re-run.");
  }
  L.push("");
  for (const r of roots) {
    L.push(`ROOT ${r.root}`);
    if (!r.exists) {
      L.push("  absent");
      continue;
    }
    L.push(
      `  readable=${r.readable ? "yes" : "NO"}  files=${r.files}  unreadable dirs=${r.unreadableDirs}${r.firstError ? ` (${r.firstError})` : ""}`,
    );
    for (const s of r.sqlite) {
      L.push(
        `    ${s.path.split("/").slice(-2).join("/").padEnd(40)} ${String(s.sizeBytes ?? "?").padStart(9)} B  mode=${s.mode ?? "FAILED"}${s.walBlind ? "  WAL-BLIND" : ""}`,
      );
      if (s.isCoreData) {
        L.push(`      CORE DATA — ${s.entities?.length ?? 0} entities`);
        for (const e of s.entities ?? []) {
          L.push(
            `        ${WANTED.test(e.name) ? "*" : " "} ${String(e.name).padEnd(30)} ${e.rows ?? "?"} rows`,
          );
        }
      } else if (s.interestingTables?.length) {
        L.push(`      tables of interest: ${s.interestingTables.join(", ")}`);
      }
    }
  }
  L.push("");
  L.push("VERDICT");
  L.push(`  Core Data stores found : ${coreData.length}`);
  L.push(`  place/favourite entities: ${hits.length}`);
  for (const h of hits) L.push(`    ${h.entity} (${h.rows} rows) in ${h.store}`);
  if (!hits.length) {
    L.push(
      hasFDA
        ? "  none — with the grant held, so this IS a real negative"
        : "  none — but see question 0: this run is blind and proves nothing",
    );
  }
  L.push("");
  L.push("STICKIES — does it need the grant at all?");
  L.push(
    `  store readable=${stickiesCheck.readable ? "yes" : "no"} while Full Disk Access is ${hasFDA ? "GRANTED" : "NOT granted"}`,
  );
  L.push(
    hasFDA
      ? "  (run this again WITHOUT the grant to settle it — a granted run cannot)"
      : "  >> readable with NO grant: storePermission for Stickies should not be full-disk-access",
  );
  console.log(L.join("\n"));
}
