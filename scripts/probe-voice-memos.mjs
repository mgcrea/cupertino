#!/usr/bin/env node
// Phase 0 spike for a PROSPECTIVE `voicememos` surface.
//
// No `packages/voice-memos` exists and none should until this probe has run,
// and there is deliberately no `surfaces.json` entry yet — one there generates
// Swift, a bridge allow-list, Makefile regions and a CI handshake for a package
// that is not there.
//
// ── TWO OF THE THREE LANES ARE ALREADY DECIDED ───────────────────────────────
//
//   Apple Events   CLOSED. VoiceMemos.app ships no .sdef and no
//                  NSAppleScriptEnabled, checked directly on macOS 27.2.
//
//   App Intents    PRESENT, UNREACHABLE. Resources/Metadata.appintents lists
//                  DeleteRecording, RCImportRecording, RecordVoiceMemoIntent,
//                  CreateFolder, DeleteFolder, SearchRecordings and more. Nothing
//                  outside Shortcuts can invoke them, and `shortcuts run` only
//                  runs a shortcut the user authored. Recorded, not used.
//
//   File lane      THIS PROBE. The store sits in
//                  group.com.apple.VoiceMemos.shared, which Full Disk Access
//                  gates: from a shell without the grant `ls` on Recordings/ is
//                  EPERM, which is NOT the same finding as empty.
//
// ── THE QUESTIONS ────────────────────────────────────────────────────────────
//
//     0. CAN THIS PROCESS SEE ANYTHING? Controls first; a blind run stops.
//     1. WHICH FILE IS THE STORE? Decided by magic bytes, not by name.
//     2. ARE TITLES LEGIBLE? THE GO/NO-GO. A candidate column is called
//        ZENCRYPTEDTITLE on some releases. If every title-bearing column is
//        ciphertext, `list_recordings` can only say "a recording, 3 min" and the
//        surface is not worth shipping.
//     3. WHAT EPOCH ARE THE DATES? Core Data seconds since 2001, presumably.
//     4. DO THE ROWS REACH AUDIO? A path column, resolved against Recordings/,
//        and how many files are missing, empty or offloaded to iCloud.
//     5. IS APPLE'S TRANSCRIPT IN THE FILE? Every .m4a's box tree is walked by
//        header (never the payload of `mdat`) looking for `tsrp`, and for any
//        other non-standard box. If found, its JSON SHAPE is printed — keys and
//        types only — so a test fixture can be synthesised without real speech.
//     6. FOLDERS, FAVOURITES, RECENTLY DELETED. Which columns carry them.
//     7. WHAT DOES A READ COST? Yardsticks: Maps 0 ms, Safari 16 ms.
//
// ── PRIVACY ──────────────────────────────────────────────────────────────────
//
// Schema, entity names, row counts, null counts, value LENGTHS, byte statistics
// and box TYPES. It never prints a title, a folder name, a file name (they are
// timestamps), a transcript word or a location. Small-integer columns print
// their distinct values only when there are 8 or fewer, which makes them flags.
// `assertRedacted` checks the finished document against every text value read
// from the store and FAILS the run if one reached it.
//
//   node scripts/probe-voice-memos.mjs                 # human-readable report
//   node scripts/probe-voice-memos.mjs --json          # the raw document
//   node scripts/probe-voice-memos.mjs --out=<file>    # also save the JSON
//   node scripts/probe-voice-memos.mjs --write         # capture the schema fixture
//   node scripts/probe-voice-memos.mjs --dir=<path> --max=500

import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifySamples } from "./lib/blob-stats.mjs";
import {
  detectEpoch,
  dumpSchema,
  exists,
  fileFacts,
  listable,
  looksLikeDateColumn,
  macosVersion,
  maxNumericAsText,
  openStore,
  parseArgs,
  readable,
  safe,
  tableTools,
  writeFixture,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const H = homedir();
const attempt = (fn, fallback = null) => safe(fn, () => fallback);

const GROUP = join(H, "Library", "Group Containers", "group.com.apple.VoiceMemos.shared");
const DIR = args.valueOf("dir", join(GROUP, "Recordings"));
const MAX_FILES = Math.max(1, Number(args.valueOf("max", "2000")) || 2000);
const OUT = args.valueOf("out", "");
/**
 * --snapshot=<file> saves every recording's NUMERIC columns by Z_PK; --diff=<file>
 * compares against one. That is how a bit gets a name without reading a title:
 * favourite two memos between the runs and the bit that flipped on exactly those
 * rows is the favourite bit. Numbers and primary keys only — nothing a person wrote.
 */
const SNAPSHOT = args.valueOf("snapshot", "");
const DIFF = args.valueOf("diff", "");

const CONTROLS = {
  safari: join(H, "Library", "Safari", "History.db"),
  messages: join(H, "Library", "Messages", "chat.db"),
  notes: join(H, "Library", "Group Containers", "group.com.apple.notes", "NoteStore.sqlite"),
};

/** Other places a store has lived, so a move reads as a move rather than absence. */
const CANDIDATE_DIRS = [
  DIR,
  join(GROUP, "Library", "Application Support"),
  join(H, "Library", "Application Support", "com.apple.voicememos", "Recordings"),
  join(
    H,
    "Library",
    "Containers",
    "com.apple.VoiceMemos",
    "Data",
    "Library",
    "Application Support",
  ),
];

// ─── §0 ──────────────────────────────────────────────────────────────────────
const controls = Object.fromEntries(
  Object.entries(CONTROLS).map(([k, p]) => [k, { exists: exists(p), readable: readable(p) }]),
);
const blind = !Object.values(controls).some((c) => c.readable);

// ─── §1 ──────────────────────────────────────────────────────────────────────
const isSqlite = (p) =>
  attempt(() => {
    const fd = openSync(p, "r");
    try {
      const b = Buffer.alloc(15);
      readSync(fd, b, 0, 15, 0);
      return b.toString("latin1") === "SQLite format 3";
    } finally {
      closeSync(fd);
    }
  }, false);

const walk = (root, depth = 0, acc = { files: [], deniedDirs: 0, packages: {} }) => {
  if (depth > 4) return acc;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    acc.deniedDirs += 1;
    return acc;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      // `.composition` is how an edited recording is kept on some releases: a
      // directory, so a sweep for *.m4a undercounts by exactly the edited ones.
      const ext = extname(e.name).toLowerCase();
      if (ext) acc.packages[ext] = (acc.packages[ext] ?? 0) + 1;
      walk(p, depth + 1, acc);
    } else acc.files.push(p);
  }
  return acc;
};

// A row's numeric columns, for --snapshot/--diff: numbers only, so no title is ever kept.
const numericColumns = (r) =>
  Object.fromEntries(
    Object.entries(r).filter(
      ([k, v]) =>
        k !== "Z_PK" && (typeof v === "number" || v === null) && !k.startsWith("ZPLAYBACK"),
    ),
  );

const dirs = CANDIDATE_DIRS.map((d) => {
  const listed = exists(d) ? walk(d) : { files: [], deniedDirs: 0, packages: {} };
  const byExt = {};
  for (const f of listed.files) {
    const ext = extname(f).toLowerCase() || "(none)";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  return {
    dir: d.replace(H, "~"),
    exists: exists(d),
    listable: listable(d),
    files: listed.files.length,
    deniedDirs: listed.deniedDirs,
    byExtension: byExt,
    directoryPackages: listed.packages,
    sqlite: listed.files
      .filter((f) => !/-(wal|shm)$/.test(f) && isSqlite(f))
      .map((f) => ({ ...fileFacts(f), path: f.replace(H, "~") })),
    fileNames: listed.files,
  };
});

const storePath =
  dirs
    .flatMap((d) => d.sqlite)
    .map((s) => s.path.replace(/^~/, H))
    .find((p) => p.endsWith("CloudRecordings.db")) ??
  dirs.flatMap((d) => d.sqlite).map((s) => s.path.replace(/^~/, H))[0] ??
  null;

// Every text value read from the store, so the report can be checked against them.
const SEEN = new Map();
const remember = (v, source) => {
  if (typeof v === "string" && v.trim().length >= 4 && !SEEN.has(v.trim()))
    SEEN.set(v.trim(), source);
};

// ─── §2–§4, §6, §7 ───────────────────────────────────────────────────────────
let store = { opened: false };
let schema = null;
let audio = null;
if (storePath) {
  const opened = openStore(storePath);
  store = {
    opened: Boolean(opened.db),
    mode: opened.mode,
    openMs: opened.openMs,
    error: opened.error,
  };
  if (opened.db) {
    const db = opened.db;
    schema = dumpSchema(db);
    const T = tableTools(db);
    const entities = T.all(
      "SELECT Z_NAME AS name, Z_ENT AS ent, Z_MAX AS max FROM Z_PRIMARYKEY ORDER BY Z_ENT",
    );
    const tableFor = (name) =>
      schema.tables.find((t) => t.toUpperCase() === `Z${String(name).toUpperCase()}`);
    store.entities = entities.map((e) => ({
      ...e,
      table: tableFor(e.name) ?? null,
      rows: tableFor(e.name) ? T.countOf(tableFor(e.name)) : null,
    }));

    const describe = (table) => {
      const rows = T.countOf(table) ?? 0;
      return T.columnInfo(table).map((c) => {
        const col = `"${c.name}"`;
        const nonNull =
          T.one(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${col} IS NOT NULL`)?.n ?? null;
        const out = { name: c.name, type: c.type, nonNull, of: rows };
        const storage = T.all(
          `SELECT typeof(${col}) AS t, COUNT(*) AS n FROM "${table}" GROUP BY 1`,
        );
        out.storage = Object.fromEntries(storage.map((s) => [s.t, s.n]));
        if (out.storage.text) {
          const vals = T.all(`SELECT ${col} AS v FROM "${table}" WHERE typeof(${col})='text'`).map(
            (r) => r.v,
          );
          vals.forEach((v) => remember(v, `${table}.${c.name}`));
          const lens = vals.map((v) => v.length).toSorted((a, b) => a - b);
          const printable = vals.join("");
          out.text = {
            minLen: lens[0],
            medianLen: lens[Math.floor(lens.length / 2)],
            maxLen: lens.at(-1),
            distinct: new Set(vals).size,
            // Base64 and hex are how "encrypted" text usually shows up in a TEXT column.
            looksBase64: vals.filter((v) => v.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(v)).length,
            looksHex: vals.filter((v) => v.length >= 16 && /^[0-9a-f]+$/i.test(v)).length,
            hasSpace: vals.filter((v) => /\s/.test(v)).length,
            hasLetters: vals.filter((v) => /\p{L}{3,}/u.test(v)).length,
            printableChars: printable.length,
          };
        }
        if (out.storage.blob) {
          const bufs = T.all(
            `SELECT ${col} AS v FROM "${table}" WHERE typeof(${col})='blob' LIMIT 24`,
          ).map((r) => Buffer.from(r.v));
          const cls = classifySamples(bufs);
          out.blob = { verdict: cls.verdict, reason: cls.reason, sampled: bufs.length };
        }
        if ((out.storage.integer || out.storage.real) && looksLikeDateColumn(c.name, c.type)) {
          out.date = detectEpoch(maxNumericAsText(db, table, c.name).value);
        }
        if (out.storage.integer && !out.date) {
          const d = T.all(
            `SELECT ${col} AS v, COUNT(*) AS n FROM "${table}" GROUP BY 1 ORDER BY 2 DESC LIMIT 9`,
          );
          if (d.length <= 8 && !/^Z_?PK$|^Z_ENT$|^Z_OPT$/i.test(c.name)) {
            out.flags = Object.fromEntries(d.map((r) => [String(r.v), r.n]));
          }
        }
        return out;
      });
    };

    const recEntity = store.entities.find((e) => /RECORDING/i.test(e.name) && e.table);
    const folderEntity = store.entities.find((e) => /FOLDER/i.test(e.name) && e.table);
    store.recordingTable = recEntity?.table ?? null;
    store.folderTable = folderEntity?.table ?? null;
    store.tables = {};
    for (const e of store.entities) if (e.table) store.tables[e.table] = describe(e.table);

    // §7 — what a full list costs.
    if (store.recordingTable) {
      const t0 = performance.now();
      const all = T.all(`SELECT * FROM "${store.recordingTable}"`);
      store.fullReadMs = Math.round((performance.now() - t0) * 10) / 10;
      store.fullReadRows = all.length;
      const snap = Object.fromEntries(all.map((r) => [r.Z_PK, numericColumns(r)]));
      snap.folderCount = T.countOf(store.folderTable ?? "ZFOLDER");
      if (SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(snap));
      if (DIFF) {
        const before = attempt(() => JSON.parse(readFileSync(DIFF, "utf8")), null);
        if (!before) store.diff = { error: `cannot read ${DIFF}` };
        else {
          const cols = {};
          const pks = new Set(
            [...Object.keys(before), ...Object.keys(snap)].filter((k) => k !== "folderCount"),
          );
          let added = 0;
          let removed = 0;
          for (const pk of pks) {
            const a = before[pk];
            const b = snap[pk];
            if (!a) {
              added += 1;
              continue;
            }
            if (!b) {
              removed += 1;
              continue;
            }
            for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
              if (a[k] === b[k]) continue;
              const c = (cols[k] ??= { rows: 0, transitions: {}, bitsSet: {}, bitsCleared: {} });
              c.rows += 1;
              const isDate = k.endsWith("DATE");
              const t = isDate
                ? `${a[k] === null ? "null" : "date"} -> ${b[k] === null ? "null" : "date"}`
                : `${a[k]} -> ${b[k]}`;
              c.transitions[t] = (c.transitions[t] ?? 0) + 1;
              if (Number.isInteger(a[k]) && Number.isInteger(b[k]) && k.endsWith("FLAGS")) {
                for (let bit = 0; bit < 31; bit += 1) {
                  const m = 1 << bit;
                  if (!(a[k] & m) && b[k] & m)
                    c.bitsSet[`0x${m.toString(16)}`] = (c.bitsSet[`0x${m.toString(16)}`] ?? 0) + 1;
                  if (a[k] & m && !(b[k] & m))
                    c.bitsCleared[`0x${m.toString(16)}`] =
                      (c.bitsCleared[`0x${m.toString(16)}`] ?? 0) + 1;
                }
              }
            }
          }
          store.diff = {
            foldersBefore: before.folderCount,
            foldersAfter: snap.folderCount,
            rowsAdded: added,
            rowsRemoved: removed,
            columns: cols,
          };
        }
      }

      // §4 — which column reaches audio, by SCORING every text column against the
      // files on disk rather than trusting a name.
      const recDir = dirname(storePath);
      const scored = T.columnInfo(store.recordingTable)
        .map((c) => {
          let hits = 0;
          let tried = 0;
          for (const r of all) {
            const v = r[c.name];
            if (typeof v !== "string" || !/\.(m4a|qta|caf|wav|aac|mp4)$/i.test(v)) continue;
            tried += 1;
            const p = v.startsWith("/") ? v : join(recDir, v);
            if (exists(p)) hits += 1;
          }
          return { column: c.name, candidates: tried, resolved: hits };
        })
        .filter((s) => s.candidates)
        .toSorted((a, b) => b.resolved - a.resolved);
      store.pathColumns = scored;
      const pathCol = scored[0]?.column ?? null;
      if (pathCol) {
        // The year travels with each file so the report can say which format
        // is the CURRENT one. A year is not a title.
        const files = all
          .filter((r) => typeof r[pathCol] === "string")
          .map((r) => ({
            path: r[pathCol].startsWith("/") ? r[pathCol] : join(recDir, r[pathCol]),
            year:
              typeof r.ZDATE === "number"
                ? new Date((r.ZDATE + 978_307_200) * 1000).getUTCFullYear()
                : null,
          }));
        audio = probeAudio(files.slice(0, MAX_FILES));
        audio.pathColumn = pathCol;
        store.rowsWithoutPath = all
          .filter((r) => typeof r[pathCol] !== "string")
          .map((r) => ({
            flags: r.ZFLAGS ?? null,
            hasDuration: Number(r.ZDURATION) > 0,
            hasTitle: typeof r.ZENCRYPTEDTITLE === "string" && r.ZENCRYPTEDTITLE.length > 0,
            hasAudioDigest: r.ZAUDIODIGEST != null,
            year:
              typeof r.ZDATE === "number"
                ? new Date((r.ZDATE + 978_307_200) * 1000).getUTCFullYear()
                : null,
          }));
        audio.absolutePaths = all.filter(
          (r) => typeof r[pathCol] === "string" && r[pathCol].startsWith("/"),
        ).length;
      }
      const onDisk = dirs[0].fileNames.filter((f) => /\.(m4a|qta|caf)$/i.test(f)).length;
      store.audioFilesOnDisk = onDisk;
      store.icloudPlaceholders = dirs[0].fileNames.filter((f) => /\.icloud$/i.test(f)).length;
    }
    db.close();
  }
}

// ─── §5: the box tree ────────────────────────────────────────────────────────
function probeAudio(files) {
  const CONTAINERS = new Set([
    "moov",
    "trak",
    "mdia",
    "minf",
    "udta",
    "meta",
    "ilst",
    "edts",
    "dinf",
    "stbl",
  ]);
  const STANDARD = new Set([
    "ftyp",
    "mdat",
    "free",
    "skip",
    "wide",
    "moov",
    "mvhd",
    "trak",
    "tkhd",
    "edts",
    "elst",
    "mdia",
    "mdhd",
    "hdlr",
    "minf",
    "smhd",
    "dinf",
    "dref",
    "stbl",
    "stsd",
    "stts",
    "stsc",
    "stsz",
    "stco",
    "co64",
    "udta",
    "meta",
    "ilst",
    "keys",
    "sgpd",
    "sbgp",
    "uuid",
    "pdin",
    "chpl",
    "tref",
    "gmhd",
    "nmhd",
    "vmhd",
    "ctts",
    "stss",
  ]);
  const out = {
    sampled: files.length,
    missing: 0,
    empty: 0,
    unreadable: 0,
    parsed: 0,
    parseErrors: 0,
    totalBytes: 0,
    ftypBrands: {},
    nonStandardBoxes: {},
    errors: {},
    byBrand: {},
    metaKeys: {},
    tsrp: { files: 0, paths: {}, json: 0, notJson: 0, bytes: [], shapes: {} },
    timing: {
      pairs: 0,
      secondGeFirst: 0,
      widths: [],
      gapIfEnd: [],
      gapIfDuration: [],
      runs: 0,
      leadingSpace: 0,
      trailingSpace: 0,
      innerSpace: 0,
      punctOnly: 0,
    },
  };
  for (const { path: f, year } of files) {
    let brand = "(none)";
    if (!exists(f)) {
      out.missing += 1;
      continue;
    }
    const size = attempt(() => statSync(f).size, 0);
    if (!size) {
      out.empty += 1;
      continue;
    }
    out.totalBytes += size;
    let fd;
    try {
      fd = openSync(f, "r");
    } catch {
      out.unreadable += 1;
      continue;
    }
    try {
      const read = (pos, n) => {
        const b = Buffer.alloc(n);
        const got = readSync(fd, b, 0, n, pos);
        return b.subarray(0, got);
      };
      const found = [];
      // QuickTime `keys` (a FullBox: version+flags, count, then size+namespace+name
      // per entry) names the items of the `ilst` beside it, which are boxes whose
      // TYPE is a 1-based index into it. Key names are Apple's reverse-DNS
      // identifiers — schema — and are printed only when they look like one.
      const keyNames = new Map();
      const readKeys = (start, end, scope) => {
        const count = read(start + 4, 4).readUInt32BE(0);
        let p = start + 8;
        const names = [];
        for (let i = 0; i < count && p + 8 <= end; i += 1) {
          const sz = read(p, 4).readUInt32BE(0);
          if (sz < 8) break;
          const name = read(p + 8, sz - 8).toString("latin1");
          names.push(
            /^[A-Za-z0-9._-]+$/.test(name) ? name : `(non-identifier, ${name.length} chars)`,
          );
          p += sz;
        }
        keyNames.set(scope, names);
      };
      // iTunes freeform items (`----`) carry `mean` and `name` children: also schema.
      const freeformName = (start, end) => {
        let p = start;
        let mean = "";
        let name = "";
        while (p + 8 <= end) {
          const b = read(p, 8);
          const sz = b.readUInt32BE(0);
          const t = b.toString("latin1", 4, 8);
          if (sz < 8) break;
          if (t === "mean" || t === "name") {
            const v = read(p + 12, sz - 12).toString("latin1");
            const ok = /^[A-Za-z0-9._-]+$/.test(v) ? v : `(${v.length} chars)`;
            if (t === "mean") mean = ok;
            else name = ok;
          }
          p += sz;
        }
        return `${mean}:${name}`;
      };
      const walkBoxes = (start, end, path, depth) => {
        if (depth >= 10) return;
        let pos = start;
        while (pos + 8 <= end) {
          const h = read(pos, 16);
          if (h.length < 8) break;
          let len = h.readUInt32BE(0);
          const type = h.toString("latin1", 4, 8);
          let header = 8;
          if (len === 1) {
            len = Number(h.readBigUInt64BE(8));
            header = 16;
          } else if (len === 0) len = end - pos;
          if (len < header || pos + len > end) {
            throw new Error(
              `${path || "(top)"}: box ${JSON.stringify(type)} len ${len} overruns its parent by ${pos + len - end}`,
            );
          }
          const here = path ? `${path}/${type}` : type;
          if (type === "ftyp") {
            brand = read(pos + 8, 4).toString("latin1");
            out.ftypBrands[brand] = (out.ftypBrands[brand] ?? 0) + 1;
          }
          if (!STANDARD.has(type) && !/^[©]/.test(type)) {
            out.nonStandardBoxes[here] = (out.nonStandardBoxes[here] ?? 0) + 1;
          }
          if (type === "keys") readKeys(pos + header, pos + len, path);
          if (path.endsWith("/ilst")) {
            const scope = path.slice(0, -"/ilst".length);
            const idx = h.readUInt32BE(4);
            const key =
              type === "----"
                ? `----${freeformName(pos + header, pos + len)}`
                : idx > 0 && idx < 1000 && keyNames.has(scope)
                  ? (keyNames.get(scope)[idx - 1] ?? `#${idx}`)
                  : JSON.stringify(type);
            const k = `${brand.trim()} ${scope}/${key}`;
            out.metaKeys[k] ??= { files: 0, bytes: [] };
            out.metaKeys[k].files += 1;
            out.metaKeys[k].bytes.push(len - header);
            // Measured: `.qta` (brand `qt  `) keeps NO `tsrp` box — every one of
            // them carries the transcript as this keyed item instead, inside a
            // `data` box (size, 'data', 4 B type, 4 B locale, then the payload).
            if (key === "com.apple.VoiceMemos.tsrp") {
              let p = pos + header;
              while (p + 16 <= pos + len) {
                const d = read(p, 16);
                const sz = d.readUInt32BE(0);
                if (sz < 16) break;
                if (d.toString("latin1", 4, 8) === "data") {
                  out.qtDataTypes ??= {};
                  const dt = d.readUInt32BE(8);
                  out.qtDataTypes[dt] = (out.qtDataTypes[dt] ?? 0) + 1;
                  found.push({
                    path: `${scope}/keys:com.apple.VoiceMemos.tsrp`,
                    start: p + 16,
                    len: sz - 16,
                  });
                }
                p += sz;
              }
            }
          }
          if (type === "tsrp") found.push({ path: here, start: pos + header, len: len - header });
          // `meta` is a FullBox in ISO files (four bytes of version and flags
          // before its children) and a PLAIN box in QuickTime ones, whose first
          // child is `hdlr` straight away. Measured: all 20 `qt  ` files failed
          // when every meta was read as a FullBox. So peek rather than assume.
          let skip = 0;
          if (type === "meta")
            skip = read(pos + header + 4, 4).toString("latin1") === "hdlr" ? 0 : 4;
          if (CONTAINERS.has(type)) walkBoxes(pos + header + skip, pos + len, here, depth + 1);
          pos += len;
        }
      };
      walkBoxes(0, size, "", 0);
      out.parsed += 1;
      const k = `${brand.trim() || "?"} ${year ?? "?"}`;
      out.byBrand[k] ??= { files: 0, tsrp: 0 };
      out.byBrand[k].files += 1;
      if (found.length) out.byBrand[k].tsrp += 1;
      if (found.length) {
        out.tsrp.files += 1;
        for (const t of found) {
          out.tsrp.paths[t.path] = (out.tsrp.paths[t.path] ?? 0) + 1;
          out.tsrp.bytes.push(t.len);
          const payload = read(t.start, Math.min(t.len, 64 * 1024 * 1024)).toString("utf8");
          const json = attempt(() => JSON.parse(payload), undefined);
          if (json === undefined) {
            out.tsrp.notJson += 1;
            continue;
          }
          out.tsrp.json += 1;
          collectStrings(json);
          timingOf(json, out.timing);
          const s = JSON.stringify(shapeOf(json));
          out.tsrp.shapes[s] = (out.tsrp.shapes[s] ?? 0) + 1;
        }
      }
    } catch (err) {
      out.parseErrors += 1;
      const m = `${brand}: ${String(err?.message ?? err)}`;
      out.errors[m] = (out.errors[m] ?? 0) + 1;
    } finally {
      closeSync(fd);
    }
  }
  for (const v of Object.values(out.metaKeys)) {
    const s2 = v.bytes.toSorted((x, y) => x - y);
    v.bytes = { min: s2[0], median: s2[Math.floor(s2.length / 2)], max: s2.at(-1) };
  }
  out.timing.widths = quantiles(out.timing.widths);
  out.timing.gapIfEnd = quantiles(out.timing.gapIfEnd);
  out.timing.gapIfDuration = quantiles(out.timing.gapIfDuration);
  const b = out.tsrp.bytes.toSorted((x, y) => x - y);
  out.tsrp.bytes = b.length
    ? { min: b[0], median: b[Math.floor(b.length / 2)], max: b.at(-1) }
    : null;
  out.tsrp.shapes = Object.entries(out.tsrp.shapes).map(([shape, n]) => ({
    files: n,
    shape: JSON.parse(shape),
  }));
  return out;
}

/**
 * Is timeRange [start, end] or [start, duration]? Answered by numbers alone: with
 * [start, end] the next word's start sits near this one's second value; with
 * [start, duration] it sits near first + second. Also whether the run strings
 * carry their own spacing, which decides how words are joined. Counts only.
 */
function timingOf(json, t) {
  const a = json?.attributedString;
  let pairs = [];
  let texts = [];
  if (a && Array.isArray(a.runs) && Array.isArray(a.attributeTable)) {
    for (let i = 0; i + 1 < a.runs.length; i += 2) {
      texts.push(a.runs[i]);
      pairs.push(a.attributeTable[a.runs[i + 1]]?.timeRange);
    }
  } else if (Array.isArray(a)) {
    for (let i = 0; i + 1 < a.length; i += 2) {
      texts.push(a[i]);
      pairs.push(a[i + 1]?.timeRange);
    }
  }
  pairs = pairs.filter((p) => Array.isArray(p) && p.length === 2);
  for (let i = 0; i < pairs.length; i += 1) {
    const [x, y] = pairs[i];
    t.pairs += 1;
    if (y >= x) t.secondGeFirst += 1;
    t.widths.push(y - x);
    const next = pairs[i + 1];
    if (next) {
      t.gapIfEnd.push(next[0] - y);
      t.gapIfDuration.push(next[0] - (x + y));
    }
  }
  for (const s of texts.filter((x) => typeof x === "string")) {
    t.runs += 1;
    if (/^\s/.test(s)) t.leadingSpace += 1;
    if (/\s$/.test(s)) t.trailingSpace += 1;
    if (/\S\s+\S/.test(s)) t.innerSpace += 1;
    if (/^[\s\p{P}]+$/u.test(s)) t.punctOnly += 1;
  }
}

function quantiles(xs) {
  const s = xs.toSorted((p, q) => p - q);
  const at = (q) =>
    s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 1000) / 1000 : null;
  return {
    n: s.length,
    p01: at(0.01),
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    negative: s.filter((v) => v < -0.05).length,
    over1s: s.filter((v) => v > 1).length,
  };
}

/** Keys and types, never values. Arrays keep their length and their first element's shape. */
function shapeOf(v, depth = 0) {
  if (depth > 8) return "…";
  if (Array.isArray(v)) {
    const kinds = [
      ...new Set(v.map((x) => (Array.isArray(x) ? "array" : x === null ? "null" : typeof x))),
    ];
    const firstObj = v.find((x) => x && typeof x === "object");
    return {
      array: v.length,
      of: kinds,
      ...(firstObj ? { first: shapeOf(firstObj, depth + 1) } : {}),
    };
  }
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  if (typeof v === "string") return `string(${v.length})`;
  return v === null ? "null" : typeof v;
}

function collectStrings(v) {
  if (typeof v === "string") remember(v, "tsrp");
  else if (Array.isArray(v)) v.forEach(collectStrings);
  else if (v && typeof v === "object") Object.values(v).forEach(collectStrings);
}

// ─── the document ────────────────────────────────────────────────────────────
for (const d of dirs) delete d.fileNames;
const doc = {
  tool: "scripts/probe-voice-memos.mjs",
  at: new Date().toISOString(),
  macos: macosVersion(),
  question0: { blind, controls },
  dirs,
  storePath: storePath?.replace(H, "~") ?? null,
  store,
  schemaFingerprint: schema?.fingerprint ?? null,
  audio,
};

const assertRedacted = () => {
  // Apple's own vocabulary can legitimately appear in both (an entity name read
  // from Z_PRIMARYKEY is a text value too), so only flag values that are not schema.
  // The type names `shapeOf` writes are this probe's vocabulary too, and a
  // transcript says "number" and "object" aloud: measured, it tripped on both.
  const schemaWords = new Set([
    ...(schema?.tables ?? []),
    ...(store.entities ?? []).map((e) => e.name),
    "string",
    "number",
    "object",
    "boolean",
    "null",
    "array",
  ]);
  // Measured on the first real run: Apple's transcript is stored WORD BY WORD,
  // so a substring test flagged 26 single words ("name", "date", "locale")
  // that occur in the report's own keys and prose. So: keys are this probe's
  // vocabulary and are not checked; a phrase (has a space) or anything 16+
  // characters is flagged on any substring; a single short word only when it
  // IS a whole value. That still catches a printed title or folder name.
  const values = [];
  const collect = (node) => {
    if (typeof node === "string") values.push(node);
    else if (node && typeof node === "object") Object.values(node).forEach(collect);
  };
  collect(doc);
  const leaked = [...SEEN.keys()].filter((v) => {
    if (schemaWords.has(v)) return false;
    const strict = /\s/.test(v) || v.length >= 16;
    return strict ? values.some((x) => x.includes(v)) : values.includes(v);
  });
  if (leaked.length) {
    // Say WHERE each one landed, never what it was: the source column, its
    // length, and the report paths whose key or value contains it. A short
    // transcript word ("Library") matching a folder path is a false positive;
    // a title inside a value is a real leak. Both look the same from a count.
    const where = [];
    const visit = (node, path) => {
      if (typeof node === "string") where.push([path, node]);
      else if (node && typeof node === "object")
        for (const [k, x] of Object.entries(node)) {
          where.push([`${path}{key}`, k]);
          visit(x, Array.isArray(node) ? `${path}[${k}]` : `${path}.${k}`);
        }
    };
    visit(doc, "doc");
    console.error(
      `REDACTION FAILED: ${leaked.length} store value(s) reached the report. Nothing printed.`,
    );
    for (const v of leaked) {
      const paths = where
        .filter(([, s]) => s.includes(v))
        .map(([p, s]) => `${p}${s === v ? " (exact)" : ""}`);
      console.error(
        `  from ${SEEN.get(v)} len=${v.length} space=${/\s/.test(v)} at ${paths.slice(0, 4).join(", ")}`,
      );
    }
    process.exit(5);
  }
};

const json = JSON.stringify(doc, null, 2);
assertRedacted();
if (OUT) writeFileSync(OUT, `${json}\n`);
if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "voice-memos",
    file: "cloud-recordings.sql",
    ddlRows: schema?.ddlRows,
    macos: doc.macos,
    fingerprint: schema?.fingerprint,
    tool: "scripts/probe-voice-memos.mjs",
  });
}

if (args.json) {
  console.log(json);
} else {
  const L = [];
  L.push(`Voice Memos probe — macOS ${doc.macos}`);
  L.push("");
  L.push("§0 CAN THIS PROCESS SEE ANYTHING?");
  for (const [k, c] of Object.entries(controls))
    L.push(`  ${k.padEnd(10)} readable=${c.readable ? "YES" : "NO"}`);
  L.push(
    blind
      ? "  >> BLIND. Every negative below means nothing. Re-run with Full Disk Access."
      : "  >> Full Disk Access held",
  );
  L.push("");
  L.push("§1 WHERE IS THE STORE?");
  for (const d of dirs) {
    L.push(`  ${d.dir}`);
    if (!d.exists) {
      L.push("    absent");
      continue;
    }
    L.push(
      `    listable=${d.listable ? "yes" : "NO"} files=${d.files} deniedDirs=${d.deniedDirs} ext=${JSON.stringify(d.byExtension)} packages=${JSON.stringify(d.directoryPackages)}`,
    );
    for (const s of d.sqlite)
      L.push(
        `    sqlite ${s.path.split("/").at(-1)} ${s.sizeBytes} B wal=${s.walSizeBytes ?? "-"} readable=${s.readable}`,
      );
  }
  L.push(
    `  >> store: ${doc.storePath ?? "NONE FOUND"}  opened=${store.opened} mode=${store.mode ?? "-"} ${store.error ?? ""}`,
  );
  if (store.opened) {
    L.push("");
    L.push(`  entities: ${store.entities.map((e) => `${e.name}(${e.rows ?? "?"})`).join(", ")}`);
    for (const [t, cols] of Object.entries(store.tables)) {
      L.push("");
      L.push(`§2–§6 ${t}`);
      for (const c of cols) {
        const bits = [`${String(c.nonNull)}/${c.of}`, c.type || "?", JSON.stringify(c.storage)];
        if (c.text)
          bits.push(
            `text len ${c.text.minLen}/${c.text.medianLen}/${c.text.maxLen} distinct=${c.text.distinct} space=${c.text.hasSpace} letters=${c.text.hasLetters} b64=${c.text.looksBase64} hex=${c.text.looksHex}`,
          );
        if (c.blob) bits.push(`blob ${c.blob.verdict} (${c.blob.reason})`);
        if (c.date) bits.push(`date ${c.date.epoch} latest=${c.date.latestYear ?? "?"}`);
        if (c.flags) bits.push(`flags ${JSON.stringify(c.flags)}`);
        L.push(`  ${c.name.padEnd(28)} ${bits.join("  ")}`);
      }
    }
    L.push("");
    L.push(
      `§7 full read of ${store.recordingTable}: ${store.fullReadRows} rows in ${store.fullReadMs} ms (open ${store.openMs} ms)`,
    );
    if (store.diff) L.push(`DIFF ${JSON.stringify(store.diff)}`);
    L.push(
      `§4 path columns: ${JSON.stringify(store.pathColumns)}  audio on disk=${store.audioFilesOnDisk} .icloud=${store.icloudPlaceholders}`,
    );
  }
  if (audio) {
    L.push("");
    L.push("§5 AUDIO FILES");
    L.push(
      `  sampled=${audio.sampled} parsed=${audio.parsed} missing=${audio.missing} empty=${audio.empty} unreadable=${audio.unreadable} parseErrors=${audio.parseErrors} absolutePaths=${audio.absolutePaths}`,
    );
    L.push(`  ftyp brands: ${JSON.stringify(audio.ftypBrands)}`);
    L.push(`  by brand and year (files / with tsrp): ${JSON.stringify(audio.byBrand)}`);
    if (Object.keys(audio.errors).length) L.push(`  parse errors: ${JSON.stringify(audio.errors)}`);
    for (const [k, v] of Object.entries(audio.metaKeys))
      L.push(`  meta ${k}  ×${v.files}  bytes ${JSON.stringify(v.bytes)}`);
    L.push(`  qt data well-known types: ${JSON.stringify(audio.qtDataTypes ?? {})}`);
    L.push(`  rows without a path: ${JSON.stringify(store.rowsWithoutPath)}`);
    L.push(`  non-standard boxes: ${JSON.stringify(audio.nonStandardBoxes)}`);
    L.push(`  timing: ${JSON.stringify(audio.timing)}`);
    L.push(
      `  tsrp: in ${audio.tsrp.files} file(s) at ${JSON.stringify(audio.tsrp.paths)} json=${audio.tsrp.json} notJson=${audio.tsrp.notJson} bytes=${JSON.stringify(audio.tsrp.bytes)}`,
    );
    for (const s of audio.tsrp.shapes) L.push(`  shape ×${s.files}: ${JSON.stringify(s.shape)}`);
  }
  console.log(L.join("\n"));
}
