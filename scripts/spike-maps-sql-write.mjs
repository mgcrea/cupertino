#!/usr/bin/env node
// Spike: write a favourite into Maps' Core Data store with SQL — on a COPY.
//
// ── WHY A COPY, AND WHY THAT IS NOT TIMIDITY ────────────────────────────────
//
// `MapsSync_0.0.1` is mirrored to iCloud by `NSPersistentCloudKitContainer`. A
// malformed row is therefore not a local mistake: it propagates to every device
// the account owns, and if the persistent-history bookkeeping is wrong the export
// analyzer can wedge, which shows up as Maps silently no longer syncing rather
// than as an error anybody sees. There is no staging environment for that, and
// `mapssyncd` holds the store open even with Maps quit, so a live write also
// races a running writer.
//
// So stage one is a copy. It cannot prove Maps accepts the row and it cannot
// prove CloudKit mirrors it — both are stated below rather than glossed — but it
// proves the object graph is well-formed, the joins resolve, and the shipped
// reader in `packages/maps` sees exactly one new favourite. Those are the cheap
// failures, and they are worth eliminating before spending a real store on them.
//
// THIS FILE NEVER WRITES TO THE REAL STORE. It refuses to open the live path for
// writing at all; the copy is made by this script and everything happens there.
//
// ── WHAT AN INSERT ACTUALLY NEEDS ───────────────────────────────────────────
//
// Measured by `pnpm probe:maps-write --diff`, which watched Maps save one place:
//
//   ZFAVORITEITEM     21 columns, all ordinary values plus a UUID
//   ZMIXINMAPITEM     the place record, with ZMAPITEMSTORAGE — a ~1.2 KB GEO
//                     protobuf this repo has never decoded
//   Z_PRIMARYKEY      Z_MAX bumped for both entities
//   ACHANGE           per-row change journal, with ZTRANSACTIONID
//   ATRANSACTION      the transaction those changes belong to
//   ANSCK*            CloudKit mirror metadata
//
// The protobuf is the wall, and this spike goes around it rather than through:
// it COPIES an existing `ZMAPITEMSTORAGE` from a place already in the store. So
// the capability is "promote a place you already have to a favourite", not
// "favourite anything" — narrower, and the narrowness is what makes it possible.
//
// The `ANSCK*` rows are deliberately NOT written. They appeared in the same diff
// window as the object rows, which means Core Data's mirroring delegate creates
// them when it exports a locally-created object. Writing them by hand would mean
// minting a `CKRecord` with server-assigned fields, which is not possible and is
// also not the caller's job. What the exporter needs from us is the HISTORY rows,
// so it notices the object exists.
//
// ── WHAT THIS CANNOT TELL YOU ───────────────────────────────────────────────
//
//   * whether Maps.app accepts the row and shows it
//   * whether CloudKit mirrors it or chokes on it
//
// Both need a write to the real store, with Maps quit and its iCloud sync off,
// and both are stage two. A green run here is a necessary condition, not a
// sufficient one, and the report says so rather than implying otherwise.
//
// PRIVACY. Prints counts, column names and row ids. The place it promotes is
// chosen by row id and its name is never printed.
//
// ── STAGE TWO, AND WHY IT IS SPLIT ──────────────────────────────────────────
//
// `--apply` writes to the REAL store. The two risks are separable, so they are
// separated:
//
//   2a  insert WITHOUT history rows. `ACHANGE`/`ATRANSACTION` are how the
//       CloudKit exporter learns an object exists, so omitting them keeps the
//       row LOCAL: it cannot propagate to the account's other devices, and the
//       blast radius collapses to this Mac. It still answers the question that
//       matters most — does Maps display it?
//   2b  add history and watch whether it syncs. Only worth doing if 2a works.
//
// `--apply` is 2a. It refuses while Maps is running, backs the store up first,
// prints the backup path and the new row's identifier, and `--undo=<hex>`
// removes exactly that row again. `Z_MAX` is deliberately NOT rolled back:
// Core Data never reuses a primary key, and pretending it might is how a later
// insert collides.
//
//   node scripts/spike-maps-sql-write.mjs            # copy, insert, verify
//   node scripts/spike-maps-sql-write.mjs --keep     # leave the copy for inspection
//   node scripts/spike-maps-sql-write.mjs --apply    # STAGE 2a: the real store
//   node scripts/spike-maps-sql-write.mjs --undo=<hex>   # remove what --apply added

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { fileFacts, isRunning, macosVersion, parseArgs, safe, yn } from "./lib/probe-kit.mjs";

const H = homedir();
const args = parseArgs(process.argv.slice(2));
const LIVE = join(H, "Library/Containers/com.apple.Maps/Data/Maps/MapsSync_0.0.1");
const APPLE_EPOCH = 978_307_200;

const APPLY = args.has("--apply");
const UNDO = args.valueOf("undo", "");
const SEED = args.valueOf("seed", "");
const PROMOTE = args.valueOf("promote", "");
const LL = args.valueOf("ll", "");
const HISTORY = args.valueOf("history", "");
const WHILE_RUNNING = args.has("--while-running");
const EXPORT_STATUS = args.valueOf("export-status", "");
const NAME = args.valueOf("name", "");

const say = (l = "") => console.log(l);
const head = (n, t) => {
  say();
  say(`── ${n}. ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
};

// ── 0. instrument ───────────────────────────────────────────────────────────
head(0, "Can this process read the live store at all?");
const facts = fileFacts(LIVE);
say(`  exists ${yn(facts.exists)}  readable ${yn(facts.readable)}  ${facts.sizeBytes ?? "?"} B`);
if (!facts.readable) {
  say();
  say("  Not readable. Grant Full Disk Access to this terminal and re-run —");
  say("  a negative from a blind process is not a finding.");
  process.exit(3);
}

/**
 * Everything `--apply` and `--undo` need in order to touch the live store
 * safely: the app must be down, and the store must be recoverable.
 *
 * Maps running is a hard stop rather than a warning. Core Data keeps the objects
 * it has loaded in memory, so a row inserted underneath a live context is
 * invisible to it and whatever that context saves next was computed without the
 * row — which can overwrite it. `mapssyncd` holds the file open regardless and
 * cannot be stopped, so this is mitigation rather than exclusion, and the report
 * says so.
 */
const guardLive = () => {
  if (isRunning("com.apple.Maps")) {
    say();
    say("  Maps is RUNNING, so NOTHING WAS WRITTEN. A row inserted underneath a");
    say("  live Core Data context is invisible to that context, and its next save");
    say("  was computed without the row.");
    say();
    say("  Quit Maps, then run this again:");
    say("    osascript -e 'quit app \"Maps\"'");
    say("    node scripts/spike-maps-sql-write.mjs --apply");
    process.exit(3);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backup = `${LIVE}.backup-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${LIVE}${suffix}`)) copyFileSync(`${LIVE}${suffix}`, `${backup}${suffix}`);
  }
  say(`  backup  ${backup}`);
  return backup;
};

// ── 2 & 3. donor and insert, as one reusable operation ──────────────────────
//
// Factored so the COPY and the LIVE store run byte-identical code. Two hand-kept
// copies of this SQL would drift, and the whole value of stage one is that what
// stage two runs is the thing that was proved.

/** A place already in the store whose `ZMAPITEMSTORAGE` can be reused. */
const pickDonor = (d) =>
  safe(
    () =>
      d
        .prepare(
          `SELECT ci."Z_PK" AS itemPk, mi."Z_PK" AS mapPk,
                  ci."ZLATITUDE" AS lat, ci."ZLONGITUDE" AS lon,
                  ci."ZMAPITEMNAME" AS name, ci."ZMAPITEMADDRESS" AS address,
                  ci."ZMAPITEMCATEGORY" AS category,
                  CAST(ci."ZMUID" AS TEXT) AS muid,
                  mi."ZMAPITEMSTORAGE" AS storage
             FROM "ZCOLLECTIONITEM" ci
             JOIN "ZMIXINMAPITEM" mi ON mi."Z_PK" = ci."ZMAPITEM"
            WHERE mi."ZMAPITEMSTORAGE" IS NOT NULL
              AND ci."ZLATITUDE" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "ZFAVORITEITEM" f
                 WHERE f."ZLATITUDE" = ci."ZLATITUDE" AND f."ZLONGITUDE" = ci."ZLONGITUDE")
            ORDER BY ci."Z_PK" LIMIT 1`,
        )
        .get(),
    () => null,
  );

/** Core Data stores a UUID attribute as 16 raw bytes, not as text. */
const uuidBytes = () => Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
const hexOf = (bytes) => Buffer.from(bytes).toString("hex").toUpperCase();

/**
 * One favourite and its map item, in one transaction.
 *
 * No `ACHANGE`/`ATRANSACTION` rows on purpose — see the header. Their absence is
 * what keeps the row local, and local is the whole safety property of stage 2a.
 */
const insertPair = (d, donor) => {
  const q = (sql, ...p) => d.prepare(sql).get(...p);
  const favEnt = Number(q(`SELECT Z_ENT AS e FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`).e);
  const mixEnt = Number(q(`SELECT Z_ENT AS e FROM Z_PRIMARYKEY WHERE Z_NAME='MixinMapItem'`).e);
  const favPk = Number(q(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`).m) + 1;
  const mixPk = Number(q(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME='MixinMapItem'`).m) + 1;
  const now = Date.now() / 1000 - APPLE_EPOCH;
  const id = uuidBytes();
  const position = Number(q(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM`).c);

  d.exec("BEGIN");
  try {
    d.prepare(
      `INSERT INTO "ZFAVORITEITEM"
         (Z_PK, Z_ENT, Z_OPT, ZHIDDEN, ZPOSITIONINDEX, ZSOURCE, ZTYPE, ZVERSION,
          ZMAPITEM, ZMUID, ZCREATETIME, ZMODIFICATIONTIME, ZMAPITEMLASTREFRESHED,
          ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZMAPITEMADDRESS, ZMAPITEMCATEGORY,
          ZIDENTIFIER)
       VALUES (?, ?, 1, 0, ?, 0, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      favPk,
      favEnt,
      position,
      mixPk,
      donor.muid === null ? null : Number(donor.muid),
      now,
      now,
      now,
      donor.lat,
      donor.lon,
      donor.name,
      donor.address,
      donor.category,
      id,
    );
    d.prepare(
      `INSERT INTO "ZMIXINMAPITEM"
         (Z_PK, Z_ENT, Z_OPT, ZFAVORITEITEM, ZCREATETIME, ZMODIFICATIONTIME,
          ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(mixPk, mixEnt, favPk, now, now, donor.lat, donor.lon, donor.storage);
    d.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = 'FavoriteItem'`).run(favPk);
    d.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = 'MixinMapItem'`).run(mixPk);
    d.exec("COMMIT");
  } catch (err) {
    safe(() => d.exec("ROLLBACK"));
    throw err;
  }
  return { favPk, mixPk, favEnt, mixEnt, hex: hexOf(id) };
};

/**
 * SEEDING — how an ARBITRARY place gets a `ZMAPITEMSTORAGE` without decoding one.
 *
 * The blob is a GEO record this repo cannot generate. It does not have to:
 * opening a place in Maps writes a `ZHISTORYITEM` whose `ZMIXINMAPITEM` carries a
 * record Maps minted itself. `maps://?q=<name>&ll=<lat>,<lon>` is a URL SCHEME —
 * not an Apple Event, not Accessibility — so the only grant in play is the Full
 * Disk Access this surface already needs.
 *
 * Proved by accident: `Eiffel Tower` is in the probed Mac's Recents because that
 * URL was used to stage an Accessibility measurement.
 *
 * Two honest costs. The place lands in the user's RECENTS whether or not the
 * favourite is wanted, which any shipped tool has to disclose rather than spring
 * on somebody. And not every recent gets a record — 21 of 35 on the probed store
 * — because searches and directions do not, only places do. So this WAITS for a
 * usable record and fails if none arrives, rather than assuming one did.
 */
/**
 * STAGE 2b — write the persistent-history rows the CloudKit exporter reads.
 *
 * 2a deliberately omitted these, which is what kept the row local. This adds
 * them for a favourite that already exists, so the object is held constant and
 * the only new variable is whether the exporter notices it.
 *
 * `ATRANSACTION` interns its author strings into `ATRANSACTIONSTRING` and points
 * at them through the `*TS` columns — which is exactly what the write diff showed
 * Maps setting, so the interned form is the one in use rather than the plain
 * varchars beside it.
 *
 * THE AUTHOR IS OURS, NOT MAPS'. Reusing Maps' own bundle id would make the
 * transaction look self-authored, and `NSPersistentCloudKitContainer` ignores
 * transactions from its own mirroring delegate so it does not re-export what it
 * just imported. Claiming to be Maps risks being skipped for that reason. A
 * distinct author is also the truth.
 *
 * `ZCHANGETYPE` 0 is insert, per `NSPersistentHistoryChangeType`. The rows Maps
 * wrote for an insert carried no `ZCOLUMNS`; only its updates did.
 */
/**
 * DOES THE INSERT SURVIVE WITH MAPS RUNNING?
 *
 * Every write so far required Maps quit, and that guard was CAUTION, not a
 * measurement. It decides the shape of any shipped tool, because the seeding
 * step needs Maps UP to mint a place record. If the insert needs it DOWN, one
 * `add_favorite` call would have to launch Maps, wait, quit it, then write —
 * quitting somebody's app mid-session, which also needs an Apple Event and would
 * make `usesAppleEvents: false` a lie. If both halves work with Maps up, the tool
 * is just: open a URL, poll, insert.
 *
 * Three ways it could fail, and this tries to catch each:
 *
 *   1. LOCKING. Maps and `mapssyncd` hold the store open. A write may simply be
 *      refused, which `PRAGMA busy_timeout` gives a chance to ride out.
 *   2. CLOBBERING. Core Data keeps loaded objects in memory. Maps' next save was
 *      computed without our row and could overwrite the page, or reset `Z_MAX`
 *      and hand the next insert a duplicate key. So this does not just insert and
 *      look — it PROVOKES a Maps write afterwards and re-checks.
 *   3. INVISIBILITY. The row survives but Maps never shows it until relaunch.
 *      That is a UI question this cannot answer; the report says to look.
 */
if (WHILE_RUNNING) {
  head(1, "Does an insert survive while Maps is running?");
  if (!isRunning("com.apple.Maps")) {
    say("  Maps is NOT running, and that is the whole variable. Launch it first:");
    say("    open -a Maps");
    process.exit(2);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backup = `${LIVE}.backup-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${LIVE}${suffix}`)) copyFileSync(`${LIVE}${suffix}`, `${backup}${suffix}`);
  }
  say(`  backup  ${backup}`);

  const live = new DatabaseSync(LIVE);
  // Maps and mapssyncd hold the store; without this a write is refused outright
  // rather than waiting for the lock the way any other client would.
  safe(() => live.exec("PRAGMA busy_timeout = 5000"));

  const donor = pickDonor(live);
  if (!donor) {
    live.close();
    say("  No donor available.");
    process.exit(3);
  }
  const applied = safe(
    () => insertPair(live, donor),
    (err) => {
      say(`  INSERT FAILED WHILE MAPS RAN: ${err.message}`);
      return null;
    },
  );
  if (!applied) {
    live.close();
    say();
    say("  That is the answer: the store cannot be written while Maps holds it.");
    say(`  Nothing changed. Backup at ${backup}`);
    process.exit(1);
  }
  say(`  inserted FavoriteItem Z_PK ${applied.favPk} with Maps up`);

  const stillThere = () =>
    Number(
      safe(
        () =>
          live
            .prepare(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM WHERE HEX(ZIDENTIFIER) = ?`)
            .get(applied.hex).c,
        () => 0,
      ),
    );
  const zmax = () =>
    Number(
      safe(
        () =>
          live.prepare(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`).get().m,
        () => 0,
      ),
    );
  say(`  immediately after: row present ${yn(stillThere() === 1)}, Z_MAX ${zmax()}`);

  // Provoke a write from Maps itself. Until Maps saves, nothing has been tested:
  // a row that survives an idle app proves only that the app was idle.
  const recentsBefore = Number(
    safe(
      () => live.prepare(`SELECT MAX(Z_PK) AS m FROM ZHISTORYITEM`).get().m,
      () => 0,
    ),
  );
  say();
  say("  provoking a save from Maps (opening a place)…");
  safe(() => execFileSync("/usr/bin/open", ["-g", "maps://?q=Gare%20de%20Lyon"]));
  const deadline = Date.now() + 40_000;
  let mapsWrote = false;
  while (Date.now() < deadline && !mapsWrote) {
    mapsWrote =
      Number(
        safe(
          () => live.prepare(`SELECT MAX(Z_PK) AS m FROM ZHISTORYITEM`).get().m,
          () => 0,
        ),
      ) > recentsBefore;
  }
  say(`  Maps wrote to the store  ${yn(mapsWrote)}`);
  if (!mapsWrote) {
    say("  It never saved, so the clobber question is UNTESTED — not answered.");
  }

  const survived = stillThere() === 1;
  const maxOk = zmax() >= applied.favPk;
  live.close();

  say(`  after Maps saved: row present ${yn(survived)}, Z_MAX ${yn(maxOk)}`);
  say();
  say(`  IDENTIFIER  ${applied.hex}`);
  say(`  UNDO        node scripts/spike-maps-sql-write.mjs --undo=${applied.hex}`);
  say(`  RESTORE     cp "${backup}" "${LIVE}"   (with Maps quit)`);
  say();
  if (survived && maxOk && mapsWrote) {
    say("  SURVIVED A REAL MAPS SAVE. The tool needs no app lifecycle management:");
    say("  open a URL, poll for the record, insert. Check Pinned to see whether it");
    say("  DISPLAYS without a relaunch — that is the remaining half of the answer.");
  } else if (!survived) {
    say("  THE ROW WAS LOST. Maps overwrote it, so writes must wait for Maps to");
    say("  quit and a shipped tool cannot do this behind the user's back.");
  }
  process.exit(survived && maxOk ? 0 : 1);
}

if (HISTORY) {
  head(1, "Stage 2b — give an existing favourite its history rows");
  if (!/^[0-9a-f]{32}$/i.test(HISTORY)) {
    say("  --history wants the 32-hex identifier that --apply or --promote printed.");
    process.exit(2);
  }
  const backup = guardLive();
  const live = new DatabaseSync(LIVE);
  const q = (sql, ...p) =>
    safe(
      () => live.prepare(sql).get(...p),
      () => null,
    );
  const row = q(
    `SELECT Z_PK AS favPk, Z_ENT AS favEnt, ZMAPITEM AS mapPk FROM ZFAVORITEITEM WHERE HEX(ZIDENTIFIER) = ?`,
    HISTORY.toUpperCase(),
  );
  if (!row) {
    live.close();
    say("  No favourite with that identifier.");
    process.exit(3);
  }
  const mixEnt = Number(
    q(`SELECT Z_ENT AS e FROM Z_PRIMARYKEY WHERE Z_NAME='MixinMapItem'`)?.e ?? 0,
  );
  const entOf = (n) => Number(q(`SELECT Z_ENT AS e FROM Z_PRIMARYKEY WHERE Z_NAME=?`, n)?.e ?? 0);
  const maxOf = (n) => Number(q(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME=?`, n)?.m ?? 0);
  const strEnt = entOf("TRANSACTIONSTRING");
  const txEnt = entOf("TRANSACTION");
  const chEnt = entOf("CHANGE");
  say(`  favourite Z_PK ${row.favPk} (Z_ENT ${row.favEnt}), map item ${row.mapPk}`);
  say(`  entities: TransactionString ${strEnt}, Transaction ${txEnt}, Change ${chEnt}`);

  const done = safe(
    () => {
      live.exec("BEGIN");
      /** Intern a string, reusing an existing row when the name already exists. */
      const intern = (name) => {
        const found = live
          .prepare(`SELECT Z_PK AS pk FROM ATRANSACTIONSTRING WHERE ZNAME = ?`)
          .get(name);
        if (found) return Number(found.pk);
        const pk = maxOf("TRANSACTIONSTRING") + 1;
        live
          .prepare(`INSERT INTO ATRANSACTIONSTRING (Z_PK, Z_ENT, Z_OPT, ZNAME) VALUES (?, ?, 1, ?)`)
          .run(pk, strEnt, name);
        live.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME='TRANSACTIONSTRING'`).run(pk);
        return pk;
      };
      const bundleTs = intern("io.mgcrea.cupertino");
      const processTs = intern(`cupertino-${process.pid}`);

      const txPk = maxOf("TRANSACTION") + 1;
      live
        .prepare(
          `INSERT INTO ATRANSACTION (Z_PK, Z_ENT, Z_OPT, ZBUNDLEIDTS, ZPROCESSIDTS, ZTIMESTAMP)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(txPk, txEnt, bundleTs, processTs, Date.now() / 1000 - APPLE_EPOCH);
      live.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME='TRANSACTION'`).run(txPk);

      let chPk = maxOf("CHANGE");
      for (const [ent, pk] of [
        [row.favEnt, row.favPk],
        [mixEnt, row.mapPk],
      ]) {
        chPk += 1;
        live
          .prepare(
            `INSERT INTO ACHANGE (Z_PK, Z_ENT, Z_OPT, ZCHANGETYPE, ZENTITY, ZENTITYPK, ZTRANSACTIONID)
             VALUES (?, ?, 1, 0, ?, ?, ?)`,
          )
          .run(chPk, chEnt, ent, pk, txPk);
      }
      live.prepare(`UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME='CHANGE'`).run(chPk);
      live.exec("COMMIT");
      return { txPk, chPk, bundleTs, processTs };
    },
    (err) => {
      safe(() => live.exec("ROLLBACK"));
      say(`  FAILED: ${err.message}`);
      return null;
    },
  );
  live.close();
  if (!done) {
    say(`  Store unchanged. Backup at ${backup}`);
    process.exit(1);
  }
  say(`  transaction Z_PK ${done.txPk}, changes through Z_PK ${done.chPk}`);
  say();
  say(`  RESTORE  cp "${backup}" "${LIVE}"   (with Maps quit)`);
  say();
  say("  NOW: launch Maps, leave it a minute, then:");
  say(`    node scripts/spike-maps-sql-write.mjs --export-status=${HISTORY}`);
  say();
  say("  This is the step that can disturb sync. If export-status shows errors,");
  say("  restore the backup before doing anything else.");
  process.exit(0);
}

/**
 * Did CloudKit notice? `ANSCKRECORDMETADATA` is the per-object registry — a row
 * appearing for our object means the exporter picked it up. `ANSCKEVENT` is the
 * operation log, and its error columns are where a rejection would show.
 */
if (EXPORT_STATUS) {
  head(1, "Export status — did the mirror pick the object up?");
  const live = new DatabaseSync(`file://${LIVE}?mode=ro`, { readOnly: true });
  const q = (sql, ...p) =>
    safe(
      () => live.prepare(sql).get(...p),
      () => null,
    );
  const all = (sql, ...p) =>
    safe(
      () => live.prepare(sql).all(...p),
      () => [],
    );
  const row = q(
    `SELECT Z_PK AS favPk, Z_ENT AS favEnt FROM ZFAVORITEITEM WHERE HEX(ZIDENTIFIER) = ?`,
    EXPORT_STATUS.toUpperCase(),
  );
  if (!row) {
    live.close();
    say("  No favourite with that identifier — was it undone?");
    process.exit(3);
  }
  /**
   * A row in the registry means the mirror KNOWS about the object. It does not
   * mean the object was uploaded, and the two were nearly conflated: on the
   * first run every recent event read `affected 0`, so registration was the only
   * evidence and it is not evidence of an upload.
   *
   * The registry row itself separates them. `ZNEEDSUPLOAD` is the pending flag;
   * `ZCKRECORDNAME` is the name CloudKit assigned, which only exists once the
   * server has seen it; `ZENCODEDRECORDASSET` points at the archived CKRecord,
   * which carries the server's change tag. A row with a record name and no
   * pending flag has been through the server.
   */
  const meta = q(
    `SELECT COUNT(*) AS c,
            MAX(ZNEEDSUPLOAD) AS needsUpload,
            MAX(CASE WHEN ZCKRECORDNAME IS NOT NULL THEN 1 ELSE 0 END) AS hasRecordName,
            MAX(CASE WHEN ZENCODEDRECORDASSET IS NOT NULL THEN 1 ELSE 0 END) AS hasAsset,
            MAX(ZLASTEXPORTEDTRANSACTIONNUMBER) AS lastExported
       FROM ANSCKRECORDMETADATA WHERE ZENTITYID = ? AND ZENTITYPK = ?`,
    row.favEnt,
    row.favPk,
  );
  /**
   * WHICH transaction carried the export, and who authored it?
   *
   * `ZLASTEXPORTEDTRANSACTIONNUMBER` came back as 258 on a run where the history
   * rows written by this script were transaction 265 — i.e. the export happened
   * BEFORE those rows existed. If that holds, Core Data found the object without
   * being told, and the safety property claimed for stage 2a — "no history rows,
   * so the row cannot leave this Mac" — is FALSE and 2a was riskier than it was
   * described as being.
   *
   * The author of the exporting transaction settles it: ours is
   * `io.mgcrea.cupertino`, and anything else means the mirror got there by
   * itself.
   */
  const exporter = q(
    `SELECT t."Z_PK" AS pk, s."ZNAME" AS bundle, t."ZTIMESTAMP" AS ts
       FROM ATRANSACTION t
       LEFT JOIN ATRANSACTIONSTRING s ON s."Z_PK" = t."ZBUNDLEIDTS"
      WHERE t."Z_PK" = ?`,
    meta?.lastExported ?? -1,
  );
  const ours = q(
    `SELECT MAX(t."Z_PK") AS pk FROM ATRANSACTION t
       JOIN ATRANSACTIONSTRING s ON s."Z_PK" = t."ZBUNDLEIDTS"
      WHERE s."ZNAME" = 'io.mgcrea.cupertino'`,
  );
  const maxTx = q(`SELECT MAX(Z_PK) AS pk FROM ATRANSACTION`);

  const events = all(
    `SELECT ZCLOUDKITEVENTTYPE AS type, ZSUCCEEDED AS ok, ZERRORCODE AS code,
            ZERRORDOMAIN AS domain, ZCOUNTAFFECTEDOBJECTS AS affected
       FROM ANSCKEVENT ORDER BY Z_PK DESC LIMIT 6`,
  );
  live.close();
  say(`  favourite Z_PK ${row.favPk}`);
  say(`  ANSCKRECORDMETADATA rows for it   ${meta?.c ?? 0}`);
  if (Number(meta?.c ?? 0) > 0) {
    say(`    ZNEEDSUPLOAD                    ${meta.needsUpload}`);
    say(`    has a CloudKit record name      ${yn(Number(meta.hasRecordName) === 1)}`);
    say(`    has an encoded CKRecord         ${yn(Number(meta.hasAsset) === 1)}`);
    say(`    last exported transaction       ${meta.lastExported ?? "none"}`);
  }
  say();
  say(
    `  exporting transaction ${meta?.lastExported ?? "none"} authored by ${exporter?.bundle ?? "unknown"}`,
  );
  say(`  our history transaction   ${ours?.pk ?? "none written"}`);
  say(`  newest transaction        ${maxTx?.pk ?? "?"}`);
  if (ours?.pk && meta?.lastExported && Number(meta.lastExported) < Number(ours.pk)) {
    say();
    say("  THE EXPORT PREDATES OUR HISTORY ROWS. Core Data found the object without");
    say("  them, so writing history was not what made it sync — and stage 2a's");
    say("  claim that an object without history stays local is WRONG.");
  }
  say();
  say("  most recent sync events (newest first):");
  for (const e of events) {
    say(
      `    type ${e.type}  succeeded ${e.ok}  affected ${e.affected}` +
        (e.code ? `  ERROR ${e.domain ?? "?"} ${e.code}` : ""),
    );
  }
  say();
  const uploaded = Number(meta?.hasRecordName ?? 0) === 1 && Number(meta?.needsUpload ?? 1) === 0;
  say(
    Number(meta?.c ?? 0) === 0
      ? "  NOT REGISTERED — the exporter never saw it. Give Maps longer, or the\n" +
          "  history shape is wrong."
      : uploaded
        ? "  UPLOADED — CloudKit assigned a record name and nothing is pending.\n" +
          "  Confirm on another device; that is the only proof it travelled."
        : "  REGISTERED BUT NOT YET UPLOADED — the mirror knows about it and has\n" +
          "  work outstanding. Leave Maps running and re-run this.",
  );
  process.exit(0);
}

if (SEED) {
  head(1, "Seed — make Maps mint a place record for an arbitrary place");
  const url = `maps://?q=${encodeURIComponent(SEED)}${LL ? `&ll=${LL}` : ""}`;
  const read = () => new DatabaseSync(`file://${LIVE}?mode=ro`, { readOnly: true });

  const maxHistory = () =>
    safe(
      () => {
        const d = read();
        const r = d.prepare(`SELECT MAX(Z_PK) AS m FROM ZHISTORYITEM`).get();
        d.close();
        return Number(r?.m ?? 0);
      },
      () => 0,
    );
  const before = maxHistory();
  say(`  recents high-water mark ${before}`);
  say(`  opening ${url}`);
  // A failed `open` used to print one line and then poll for 30 s against a URL
  // that was never opened, reporting "no record arrived" — a false negative from
  // an instrument that never fired. Fatal instead.
  const opened = safe(
    () => {
      execFileSync("/usr/bin/open", ["-g", url]);
      return true;
    },
    (e) => {
      say(`  open FAILED: ${e.message}`);
      return false;
    },
  );
  if (!opened) {
    say("  Nothing was opened, so nothing can arrive. Not polling.");
    process.exit(1);
  }

  // Poll rather than sleep: Maps resolves the place over the network and the
  // write lands whenever it lands. A fixed wait is either too short (a false
  // "no record") or wastes time.
  let found = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !found) {
    found = safe(
      () => {
        const d = read();
        const r = d
          .prepare(
            `SELECT h."Z_PK" AS pk, m."Z_PK" AS mapPk, LENGTH(m."ZMAPITEMSTORAGE") AS bytes,
                    h."ZLATITUDE1" AS lat, h."ZLONGITUDE1" AS lon
               FROM "ZHISTORYITEM" h
               JOIN "ZMIXINMAPITEM" m ON m."Z_PK" = h."ZMAPITEM"
              WHERE h."Z_PK" > ? AND m."ZMAPITEMSTORAGE" IS NOT NULL
              ORDER BY h."Z_PK" DESC LIMIT 1`,
          )
          .get(before);
        d.close();
        return r ?? null;
      },
      () => null,
    );
  }

  if (!found) {
    say();
    say("  No new recent with a place record arrived within 30s. Either Maps could");
    say("  not resolve the query, or it resolved it to a search rather than a place");
    say("  — searches get no record. Try a more specific name, or add --ll=.");
    process.exit(3);
  }
  say(`  HistoryItem Z_PK ${found.pk} -> map item ${found.mapPk}, ${found.bytes} bytes`);
  say();
  say("  Maps minted the record. Now quit Maps and promote it:");
  say(`    osascript -e 'quit app "Maps"' && \\`);
  say(
    `      node scripts/spike-maps-sql-write.mjs --promote=${found.pk} --name=${JSON.stringify(SEED)}`,
  );
  process.exit(0);
}

if (UNDO) {
  head(1, "Undo — remove one row from the REAL store by its identifier");
  if (!/^[0-9a-f]{32}$/i.test(UNDO)) {
    say("  --undo wants the 32-hex identifier that --apply printed.");
    process.exit(2);
  }
  guardLive();
  const live = new DatabaseSync(LIVE);
  const removed = safe(
    () => {
      live.exec("BEGIN");
      const row = live
        .prepare(
          `SELECT Z_PK AS pk, ZMAPITEM AS mapPk FROM ZFAVORITEITEM WHERE HEX(ZIDENTIFIER) = ?`,
        )
        .get(UNDO.toUpperCase());
      if (!row) {
        live.exec("ROLLBACK");
        return { found: false };
      }
      live.prepare(`DELETE FROM ZMIXINMAPITEM WHERE Z_PK = ?`).run(row.mapPk);
      live.prepare(`DELETE FROM ZFAVORITEITEM WHERE Z_PK = ?`).run(row.pk);
      live.exec("COMMIT");
      return { found: true, pk: row.pk, mapPk: row.mapPk };
    },
    (err) => {
      safe(() => live.exec("ROLLBACK"));
      return { error: err.message };
    },
  );
  live.close();
  say(`  ${JSON.stringify(removed)}`);
  say();
  say(
    removed.found
      ? "  Removed. Launch Maps and confirm it is gone."
      : "  Nothing matched that identifier.",
  );
  process.exit(removed.found ? 0 : 1);
}

/**
 * PROMOTE — turn a seeded recent into a favourite.
 *
 * A history row is a poor source for the DENORMALISED columns: on the probed
 * store `ZCUSTOMNAME` and `ZLOCATIONDISPLAY` are populated on 1 row of 35, so a
 * favourite built from one would have a working place record and no name of its
 * own. The name therefore comes from the caller — the query they seeded with,
 * which is the name they actually meant — and the coordinate from the history
 * row, which does carry it.
 */
if (PROMOTE) {
  head(1, "Promote — a seeded recent becomes a favourite, on the REAL store");
  const backup = guardLive();
  const live = new DatabaseSync(LIVE);
  const donor = safe(
    () =>
      live
        .prepare(
          `SELECT h."Z_PK" AS itemPk, m."Z_PK" AS mapPk,
                  h."ZLATITUDE1" AS lat, h."ZLONGITUDE1" AS lon,
                  h."ZCUSTOMNAME" AS name, NULL AS address, NULL AS category,
                  CAST(h."ZMUID" AS TEXT) AS muid,
                  m."ZMAPITEMSTORAGE" AS storage
             FROM "ZHISTORYITEM" h
             JOIN "ZMIXINMAPITEM" m ON m."Z_PK" = h."ZMAPITEM"
            WHERE h."Z_PK" = ? AND m."ZMAPITEMSTORAGE" IS NOT NULL`,
        )
        .get(Number(PROMOTE)),
    () => null,
  );
  if (!donor) {
    live.close();
    say(`  No recent with Z_PK ${PROMOTE} carrying a place record. Seed first.`);
    process.exit(3);
  }
  donor.name = NAME || donor.name;
  say(`  recent ${donor.itemPk} -> map item ${donor.mapPk}, ${donor.storage?.length ?? 0} bytes`);
  const applied = safe(
    () => insertPair(live, donor),
    (err) => {
      say(`  INSERT FAILED: ${err.message}`);
      return null;
    },
  );
  const total = applied
    ? Number(live.prepare(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM`).get().c)
    : null;
  live.close();
  if (!applied) {
    say(`  Store unchanged. Backup at ${backup}`);
    process.exit(1);
  }
  say(`  wrote FavoriteItem Z_PK ${applied.favPk}, favourites now ${total}`);
  say();
  say(`  LOOK FOR    ${JSON.stringify(donor.name ?? "(no name)")} in Pinned`);
  say(`  IDENTIFIER  ${applied.hex}`);
  say(`  UNDO        node scripts/spike-maps-sql-write.mjs --undo=${applied.hex}`);
  say(`  RESTORE     cp "${backup}" "${LIVE}"   (with Maps quit)`);
  say();
  say("  This is the ARBITRARY-place path: the record was minted by Maps from a");
  say("  URL scheme, never synthesised here. If it shows in Pinned, the write lane");
  say("  is complete for any place Maps can find — at the cost of a Recents entry.");
  process.exit(0);
}

// ── 1. copy ─────────────────────────────────────────────────────────────────
head(1, "Copy — the live store is never opened for writing");
const dir = mkdtempSync(join(tmpdir(), "maps-sql-write-"));
const copy = join(dir, "MapsSync_0.0.1");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(`${LIVE}${suffix}`)) copyFileSync(`${LIVE}${suffix}`, `${copy}${suffix}`);
}
say(`  ${copy}`);

const db = new DatabaseSync(copy);
// Fold the WAL in, so what follows sees everything Maps has written and leaves
// one file behind rather than three.
db.exec("PRAGMA journal_mode = DELETE");

const one = (sql, ...p) =>
  safe(
    () => db.prepare(sql).get(...p),
    () => null,
  );
const count = (t) => Number(one(`SELECT COUNT(*) AS c FROM "${t}"`)?.c ?? 0);

const before = { fav: count("ZFAVORITEITEM"), mix: count("ZMIXINMAPITEM") };
say(`  favourites ${before.fav}, map items ${before.mix}`);

head(2, "Donor — a place already in the store, not already a favourite");
const donor = pickDonor(db);
if (!donor) {
  say("  No donor found — every collection item is already a favourite, or the");
  say("  store has no map-item storage to copy. Nothing to prove here.");
  process.exit(3);
}
say(`  collection item Z_PK ${donor.itemPk} -> map item Z_PK ${donor.mapPk}`);
say(`  storage ${donor.storage?.length ?? 0} bytes, name ${donor.name ? "present" : "absent"}`);

head(3, "Insert — on the COPY");
const written = safe(
  () => insertPair(db, donor),
  (err) => {
    say(`  INSERT FAILED: ${err.message}`);
    return null;
  },
);
if (!written) process.exit(1);
const favPk = written.favPk;
say(`  FavoriteItem Z_ENT ${written.favEnt} Z_PK ${written.favPk}`);
say(`  MixinMapItem Z_ENT ${written.mixEnt} Z_PK ${written.mixPk}`);
say("  committed");

// ── 4. verify with the shipped reader ───────────────────────────────────────
head(4, "Verify — does the surface's own reader see it?");
db.close();

const { introspect, MapsStore } = await import("../packages/maps/dist/index.js").catch(() => ({}));
if (!introspect) {
  say("  packages/maps/dist not built or does not export the store layer.");
  say("  Falling back to SQL-only checks.");
}

const check = new DatabaseSync(copy, { readOnly: true });
const after = {
  fav: Number(check.prepare(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM`).get().c),
  mix: Number(check.prepare(`SELECT COUNT(*) AS c FROM ZMIXINMAPITEM`).get().c),
};
const joined = Number(
  check
    .prepare(
      `SELECT COUNT(*) AS c FROM ZFAVORITEITEM f
        JOIN ZMIXINMAPITEM m ON m.Z_PK = f.ZMAPITEM WHERE f.Z_PK = ?`,
    )
    .get(favPk).c,
);
const backref = Number(
  check.prepare(`SELECT COUNT(*) AS c FROM ZMIXINMAPITEM WHERE ZFAVORITEITEM = ?`).get(favPk).c,
);
const maxOk =
  Number(
    check.prepare(`SELECT Z_MAX AS m FROM Z_PRIMARYKEY WHERE Z_NAME='FavoriteItem'`).get().m,
  ) === favPk;
check.close();

say(`  favourites ${before.fav} -> ${after.fav}   map items ${before.mix} -> ${after.mix}`);
say(`  new row joins to its map item      ${yn(joined === 1)}`);
say(`  map item points back at it         ${yn(backref === 1)}`);
say(`  Z_PRIMARYKEY.Z_MAX bumped          ${yn(maxOk)}`);

let readerSaw = null;
if (introspect) {
  readerSaw = safe(
    () => {
      const rdb = new DatabaseSync(copy, { readOnly: true });
      const caps = introspect(rdb);
      const store = new MapsStore({ db: rdb, caps, path: copy, mode: "ro" });
      const rows = store.places("favorite", { limit: 500 }).rows;
      const mine = rows.find((r) => r.id === favPk);
      store.close();
      return {
        total: rows.length,
        found: Boolean(mine),
        linked: mine?.linked,
        uuid: Boolean(mine?.uuid),
      };
    },
    (e) => ({ error: e.message }),
  );
  say();
  say(`  shipped reader: ${JSON.stringify(readerSaw)}`);
}

const ok =
  after.fav === before.fav + 1 &&
  joined === 1 &&
  backref === 1 &&
  maxOk &&
  readerSaw?.found !== false;

head(5, "Verdict");
say(`  ${ok ? "THE INSERT IS WELL-FORMED" : "SOMETHING IS WRONG — see above"}`);
say();
say("  What this does NOT prove, and stage two must:");
say("    * that Maps.app accepts and displays the row");
say("    * that CloudKit mirrors it rather than choking on it");
say("  Both need the real store, Maps quit, and its iCloud sync off first.");
say("  No ACHANGE/ATRANSACTION history was written here; the exporter needs it,");
say("  and it is untestable on a copy because nothing is exporting from a copy.");

// ── 6. stage 2a ─────────────────────────────────────────────────────────────
if (APPLY) {
  head(6, "STAGE 2a — the same insert, on the REAL store");
  if (!ok) {
    say("  The copy did not verify, so nothing is going near the live store.");
    process.exit(1);
  }
  const backup = guardLive();
  const live = new DatabaseSync(LIVE);
  const liveDonor = pickDonor(live);
  if (!liveDonor) {
    live.close();
    say("  No donor in the live store.");
    process.exit(3);
  }
  const applied = safe(
    () => insertPair(live, liveDonor),
    (err) => {
      say(`  INSERT FAILED: ${err.message}`);
      return null;
    },
  );
  const nowCount = applied
    ? Number(live.prepare(`SELECT COUNT(*) AS c FROM ZFAVORITEITEM`).get().c)
    : null;
  live.close();
  if (!applied) {
    say(`  The store is unchanged. Backup at ${backup} if you want to be sure.`);
    process.exit(1);
  }
  say(`  wrote FavoriteItem Z_PK ${applied.favPk}, favourites now ${nowCount}`);
  say();
  // The one place a name IS printed. Everything else in this file withholds it,
  // but the whole experiment is "go and look for it in Pinned", and that is not
  // something anybody can do without being told what to look for.
  say(`  LOOK FOR    "${liveDonor.name ?? "(no name)"}"`);
  say(`  It is already in one of your Guides, so it should now appear in Pinned`);
  say(`  as well — 17 entries before, 18 after, if Maps accepts the row.`);
  say();
  say(`  IDENTIFIER  ${applied.hex}`);
  say(`  UNDO        node scripts/spike-maps-sql-write.mjs --undo=${applied.hex}`);
  say(`  RESTORE     cp "${backup}" "${LIVE}"   (with Maps quit)`);
  say();
  say("  NOW, BY HAND: launch Maps and open the Pinned panel.");
  say("    * the new favourite appears  -> Maps reads a third-party row, and 2b");
  say("      (history rows, and whether it syncs) is worth doing.");
  say("    * it does not appear         -> Maps keeps its own index, or rejects");
  say("      the row. Either way the SQL lane is finished and AX is the answer.");
  say("    * Maps misbehaves            -> undo above, then restore, then quit.");
  say();
  say("  No history rows were written, so the CloudKit exporter should never");
  say("  notice this object and it should not reach your other devices. That is");
  say("  the safety property of 2a — and it is an expectation, not a guarantee.");
}

if (args.has("--keep")) {
  say();
  say(`  copy kept at ${copy}`);
} else {
  rmSync(dir, { recursive: true, force: true });
}
say();
/*
 * The footer states what actually happened. An earlier version printed "the live
 * store was never opened for writing" unconditionally — including immediately
 * after `--apply` had written to it, which is a false claim in the one place a
 * reader most needs a true one.
 */
say(
  APPLY
    ? `macOS ${macosVersion()} · THE LIVE STORE WAS MODIFIED — undo with --undo=<identifier> above`
    : `macOS ${macosVersion()} · the live store was never opened for writing`,
);
process.exit(ok ? 0 : 1);
