#!/usr/bin/env node
// Phase 0 spike for the Mail BODY-SEARCH lane.
//
// THIS PROBE EXISTS BECAUSE THE SERVER TELLS THE TRUTH AND THE TRUTH IS A GAP.
//
// packages/mail/src/tools/search.ts says, in the tool description the model
// actually reads:
//
//     "Free text matched against subject and sender. Does NOT search message
//      bodies."
//
// and packages/mail/src/client/envelope.ts:167 calls body search "a separate,
// opt-in scan" — a scan that does not exist. Every competing Apple Mail MCP
// server either has the same hole or fills it by building its own FTS5 index
// over the whole store. Subject+sender genuinely misses "find the mail where
// they mentioned the invoice", so the gap is real and worth closing.
//
// What is NOT settled is HOW, and the wrong choice is expensive in the way
// docs/surfaces.md warns about: an owned full-text index is a second copy of
// the user's mail, on their disk, that we then have to keep in step with Mail
// forever. So this probe measures three candidate lanes before a line of the
// server is written:
//
//     1. SPOTLIGHT. The Envelope Index has NO FTS table — 54 tables, none of
//        them FTS shadow tables — but it does have `searchable_messages`
//        (`message_body_indexed`) and `last_spotlight_check_date`. That is
//        bookkeeping for an index kept somewhere ELSE, and the somewhere else
//        is Spotlight. If `mdfind` can see mail bodies, macOS is already doing
//        the work: no index to build, nothing to keep fresh, no disk cost.
//        THE QUESTION THAT DECIDES IT IS COVERAGE, NOT SPEED. A lane that is
//        fast and silently misses a third of the archive is worse than no lane,
//        because the model reports "no results" and the user believes it.
//
//     2. AN OWNED FTS5 INDEX. What the competition pays. Measured here as what
//        it would actually cost on this store: files to walk, bytes to read,
//        wall clock for a full pass.
//
//     3. NARROW-THEN-SCAN. Filter on the Envelope Index first (mailbox, date
//        window, sender), then read the bodies of the survivors. No state at
//        all — and the failure mode is a silent miss on a broad query, which is
//        exactly what lane 1 is being tested for.
//
// The join is free either way and worth stating, because it is the thing that
// makes lanes 1 and 3 possible at all: packages/mail/src/client/emlx.ts derives
// `ROWID -> Data/8/9/1/Messages/198577.emlx`, so the REVERSE is `basename()`.
// A file path off Spotlight is a ROWID, and a ROWID is a row of `messages`.
// This probe verifies that bridge on real files rather than assuming it.
//
// Dependency-free (node builtins + scripts/lib/probe-kit.mjs). The Envelope
// Index is opened read-only and NEVER written to. Nothing is written anywhere
// except with --write.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, ratios, lengths and booleans
// only. No subjects, no addresses, no bodies, no mailbox names, and — the one
// that matters most here — NO SEARCH TERMS. The round-trip test below picks its
// needles out of real message bodies, so a needle is a word from someone's
// mail. Only its LENGTH is ever reported.
//
//   node scripts/probe-mail-body.mjs                # human-readable report
//   node scripts/probe-mail-body.mjs --json         # the raw document
//   node scripts/probe-mail-body.mjs --sample=200   # message files to sample
//   node scripts/probe-mail-body.mjs --walk=40000   # cap on the file walk
//   node scripts/probe-mail-body.mjs --days=90      # window for lane 3
//   node scripts/probe-mail-body.mjs --launch       # allow launching Mail
//
// EVERY LANE HERE NEEDS FULL DISK ACCESS, unlike the Notes and Calendar probes.
// Bodies live in `~/Library/Mail`, which is TCC-protected, and `mdfind` over a
// protected directory returns nothing rather than refusing — a distinction this
// probe reports explicitly, because "no results" and "not allowed" look
// identical from the outside and mean opposite things.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  appleEventsLane,
  fileFacts,
  listable,
  macosVersion,
  maskIdentity,
  openStore,
  parseArgs,
  readable,
  safe,
  tableTools,
  walkDir,
  yn,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const HOME = homedir();
const SAMPLE = Number(args.valueOf("sample", "200")) || 200;
const WALK_CAP = Number(args.valueOf("walk", "40000")) || 40_000;
const DAYS = Number(args.valueOf("days", "90")) || 90;

/**
 * Paths carry account UUIDs and mailbox names. Neither belongs in a report.
 *
 * The `V<n>` segment is put back afterwards: maskIdentity flattens every digit,
 * so Mail's data version came out as `V00` and the one genuinely useful,
 * genuinely non-identifying part of the path was the part that got redacted.
 */
const tidy = (p) =>
  p
    ? maskIdentity(String(p).replace(HOME, "~")).replace(/\/V\d+(?=\/|$)/, () => {
        const v = /\/(V\d+)(?=\/|$)/.exec(String(p));
        return v ? `/${v[1]}` : "/V?";
      })
    : p;

const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const pct = (n, d) => (d ? Number((n / d).toFixed(3)) : null);
const pc = (x) => (x === null || x === undefined ? "?" : `${(x * 100).toFixed(1)}%`);

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: macosVersion(),
  args: { sample: SAMPLE, walkCap: WALK_CAP, days: DAYS },
  findings: {},
  verdict: {},
  notes: [],
};

// ─── 1. Locate the Mail root, exactly as locate.ts does ──────────────────────
// Mail naming its own directory is the PRIMARY strategy and the V* glob is the
// fallback, not the other way round: `~/Library/Mail` is TCC-protected, so
// without Full Disk Access the glob returns nothing even though the path is
// right there. Asking Mail costs only the Automation permission.

const ACCOUNTS_SCRIPT = `
function run(argv) {
  var Mail = Application("Mail");
  Mail.includeStandardAdditions = true;
  var out = [];
  var accounts = Mail.accounts();
  for (var i = 0; i < accounts.length; i++) {
    var dir = null;
    try { dir = String(accounts[i].accountDirectory()); } catch (e) { dir = null; }
    out.push({ enabled: accounts[i].enabled(), dir: dir });
  }
  return JSON.stringify({ accounts: out });
}
`;

const lane = appleEventsLane("com.apple.mail", "Mail", args.launch);
doc.findings.appleEvents = lane;

const viaAccounts = lane.available
  ? safe(
      () => {
        const out = execFileSync(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-", JSON.stringify({})],
          { input: ACCOUNTS_SCRIPT, encoding: "utf8", timeout: 60_000 },
        );
        const dirs = JSON.parse(out)
          .accounts.map((a) => a.dir)
          .filter(Boolean);
        return dirs.length ? dirname(dirs[0]) : null;
      },
      () => null,
    )
  : null;

const viaGlob = safe(
  () => {
    const mailHome = join(HOME, "Library", "Mail");
    const v = readdirSync(mailHome)
      .filter((d) => /^V\d+$/.test(d))
      .toSorted((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
    return v ? join(mailHome, v) : null;
  },
  () => null,
);

const mailRoot = typeof viaAccounts === "string" ? viaAccounts : viaGlob;
const indexPath = mailRoot ? join(mailRoot, "MailData", "Envelope Index") : null;

doc.findings.locate = {
  viaAccountDirectory: tidy(typeof viaAccounts === "string" ? viaAccounts : null),
  viaGlob: tidy(typeof viaGlob === "string" ? viaGlob : null),
  agree: Boolean(viaAccounts && viaGlob && viaAccounts === viaGlob),
  mailRoot: tidy(mailRoot),
  rootListable: mailRoot ? listable(mailRoot) : false,
  index: indexPath ? { ...fileFacts(indexPath), path: tidy(indexPath) } : null,
};

// The exists-vs-readable split, which is the whole shape of a TCC failure.
// `stat` SUCCEEDS on a file you may not open, so "the index is there" is not
// evidence the grant is held — only `access(R_OK)` is.
const fda = indexPath ? readable(indexPath) : false;
doc.findings.fullDiskAccess = fda ? "GRANTED" : "DENIED";

if (!mailRoot) {
  doc.notes.push(
    "Mail's data root could not be located: Mail reported no account directory and " +
      "~/Library/Mail could not be listed. Both halves of that are what a missing grant " +
      "looks like. Grant Full Disk Access and re-run.",
  );
}

// ─── 2. Walk the store, and verify the path -> ROWID bridge ──────────────────
// The walk is the shared input to every lane below: lane 2's cost IS this walk,
// lane 1 needs real paths to ask Spotlight about, and lane 3 needs to know what
// reading a body costs. It is capped because these trees are enormous and a
// probe nobody will wait for is a probe nobody runs.
//
// Depth matters and is easy to get wrong. A message file sits at
// `<root>/<accountUuid>/<Mailbox>.mbox/<uuid>/Data/8/9/1/Messages/198577.emlx`,
// and a Gmail account nests one deeper again under `[Gmail].mbox/`. probe-kit's
// default maxDepth of 3 would walk into the account directories and find
// nothing, reporting an empty store rather than an uncrawled one.

const files = [];
let walkBytes = 0;
let walked = 0;
let partialCount = 0;
let capped = false;

const walkStarted = performance.now();
if (mailRoot && fda) {
  walkDir(mailRoot, {
    maxDepth: 14,
    onFile: (p, entry) => {
      if (!entry.isFile() || !p.endsWith(".emlx")) return;
      walked += 1;
      if (walked > WALK_CAP) {
        capped = true;
        return;
      }
      const partial = p.endsWith(".partial.emlx");
      if (partial) partialCount += 1;
      const size = safe(
        () => statSync(p).size,
        () => 0,
      );
      walkBytes += typeof size === "number" ? size : 0;
      files.push({ path: p, partial, size: typeof size === "number" ? size : 0 });
    },
  });
}
const walkMs = Math.round(performance.now() - walkStarted);

/**
 * The reverse of emlx.ts `shardPath`. A message file is named for its ROWID,
 * so a path off Spotlight is a row of `messages` with no lookup table in
 * between. `.partial.emlx` has to be stripped before the parse or every
 * attachment-stripped message reads as unnumbered.
 */
const rowidOf = (p) => {
  const m = /^(\d+)(\.partial)?\.emlx$/.exec(basename(p));
  return m ? Number(m[1]) : null;
};

doc.findings.walk = {
  ran: Boolean(mailRoot && fda),
  ms: walkMs,
  filesSeen: walked,
  filesRecorded: files.length,
  capped,
  partialCount,
  partialRatio: files.length ? Number((partialCount / files.length).toFixed(3)) : null,
  totalBytes: walkBytes,
  meanBytes: files.length ? Math.round(walkBytes / files.length) : null,
  rowidParseRate: files.length
    ? Number((files.filter((f) => rowidOf(f.path) !== null).length / files.length).toFixed(3))
    : null,
};

// ─── 3. Open the Envelope Index ──────────────────────────────────────────────

const store = indexPath && fda ? openStore(indexPath) : { db: null, error: "no grant" };
const db = store.db;
const t = db ? tableTools(db) : null;

doc.findings.index = {
  opened: Boolean(db),
  mode: store.mode ?? null,
  openMs: store.openMs ?? null,
  // An immutable=1 open skips the -wal entirely, so every count below it is
  // blind to anything not yet checkpointed. Recorded rather than swallowed:
  // counts that cannot be reproduced are worse than counts that are missing.
  walBlind: store.walBlind ?? null,
  sqlite: store.sqlite ?? null,
  error: store.error ?? null,
  messageCount: t ? t.countOf("messages") : null,
  searchableMessages: t ? t.countOf("searchable_messages") : null,
  bodyIndexedRows: t
    ? t.one("SELECT COUNT(*) AS c FROM searchable_messages WHERE message_body_indexed = 1")?.c
    : null,
  // The absence of an FTS table is the finding that sends this probe to
  // Spotlight in the first place, so it is checked rather than remembered.
  ftsTables: t
    ? t
        .all("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts%'")
        .map((r) => r.name)
    : [],
};

// The bridge, verified rather than assumed: take real ROWIDs off the disk and
// confirm they are rows of `messages`. A low rate here would mean the file
// names encode something other than the index's identity, and lanes 1 and 3
// both collapse.
if (db && files.length) {
  const ids = files
    .map((f) => rowidOf(f.path))
    .filter((n) => n !== null)
    .slice(0, 500);
  const placeholders = ids.map(() => "?").join(",");
  const hit = ids.length
    ? t.one(`SELECT COUNT(*) AS c FROM messages WHERE ROWID IN (${placeholders})`, ...ids)?.c
    : 0;
  doc.findings.bridge = {
    tested: true,
    sampled: ids.length,
    resolved: hit ?? 0,
    rate: ids.length ? Number(((hit ?? 0) / ids.length).toFixed(3)) : null,
  };
} else {
  doc.findings.bridge = { tested: false, reason: "no index or no files" };
}

// ─── 4. Reading a body, cheaply ──────────────────────────────────────────────
// Deliberately NOT the real parser. packages/mail/src/client/mime.ts does this
// properly — multipart walking, transfer-decoding, the `.partial.emlx` sidecar
// rule. What a probe needs is the COST of touching the file and enough text to
// pick a needle out of, so this reads the container and stops.
//
// The container: a decimal byte count, a newline, exactly that many bytes of
// RFC 5322, then Apple's plist trailer.

const MAX_READ = 1024 * 1024;

const readBody = (path) =>
  safe(
    () => {
      const buf = readFileSync(path);
      const nl = buf.indexOf(0x0a);
      const declared = Number(buf.subarray(0, nl).toString("ascii").trim());
      const end = Number.isFinite(declared) && declared > 0 ? nl + 1 + declared : buf.length;
      const raw = buf.subarray(nl + 1, Math.min(end, nl + 1 + MAX_READ)).toString("utf8");
      const split = raw.indexOf("\n\n");
      return {
        ok: true,
        bytes: buf.length,
        headers: split > 0 ? raw.slice(0, split) : raw.slice(0, 4096),
        body: split > 0 ? raw.slice(split + 2) : "",
      };
    },
    (err) => ({ ok: false, error: String(err?.message ?? err).slice(0, 120) }),
  );

/**
 * A needle for the round-trip test.
 *
 * It has to come out of the BODY and be absent from the headers, or the test
 * proves nothing — a term that also appears in the subject is already findable
 * by the search this server ships today, and would score Spotlight a hit for
 * work it never did.
 *
 * Long-ish and alphabetic, to keep the expected hit count small: a three-letter
 * word matches half the archive and turns a coverage measurement into a
 * throughput one. Base64 attachment payloads look exactly like good needles and
 * are not words, so runs with no vowel are dropped.
 */
const STOP = new Set([
  "unsubscribe",
  "newsletter",
  "important",
  "including",
  "different",
  "everything",
  "something",
  "available",
  "following",
  "regarding",
  "attachment",
  "additional",
  "information",
  "management",
  "questions",
  "yesterday",
  "understand",
]);

const needleFrom = (parsed) => {
  if (!parsed.ok || !parsed.body) return null;
  const headers = parsed.headers.toLowerCase();
  const seen = new Map();
  for (const w of parsed.body.toLowerCase().matchAll(/[a-z]{8,14}/g)) {
    const word = w[0];
    if (STOP.has(word)) continue;
    if (!/[aeiou]/.test(word)) continue;
    if (headers.includes(word)) continue;
    seen.set(word, (seen.get(word) ?? 0) + 1);
  }
  // Least frequent wins: a word used once in this message is the sharpest
  // probe of whether THIS message is indexed, rather than of whether the term
  // is common enough to hit something else.
  const ranked = [...seen.entries()].toSorted((a, b) => a[1] - b[1]);
  return ranked.length ? ranked[0][0] : null;
};

// ─── 5. LANE 1 — Spotlight ───────────────────────────────────────────────────

const mdutil = safe(
  () => execFileSync("/usr/bin/mdutil", ["-s", "/"], { encoding: "utf8", timeout: 15_000 }).trim(),
  () => null,
);

const mdfind = (needle, onlyIn) => {
  const started = performance.now();
  try {
    const out = execFileSync("/usr/bin/mdfind", ["-onlyin", onlyIn, needle], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const paths = out.split("\n").filter(Boolean);
    return { ok: true, ms: Math.round(performance.now() - started), paths };
  } catch (err) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: String(err?.message ?? err).slice(0, 200),
      paths: [],
    };
  }
};

/** Has Spotlight ingested THIS file? Asked of the file, not of a query. */
const mdIndexed = (path) =>
  safe(
    () => {
      const out = execFileSync(
        "/usr/bin/mdls",
        ["-name", "kMDItemContentType", "-name", "kMDItemTextContent", path],
        { encoding: "utf8", timeout: 15_000 },
      );
      return {
        contentType: !/kMDItemContentType\s*=\s*\(null\)/.test(out),
        // The attribute a body search actually needs. Present content-type with
        // absent text content is an indexed FILE with an unindexed BODY, which
        // is the precise failure this lane has to be checked for.
        textContent: !/kMDItemTextContent\s*=\s*\(null\)/.test(out),
      };
    },
    () => ({ contentType: false, textContent: false }),
  );

const spotlight = {
  volumeStatus: mdutil,
  indexingEnabled: mdutil ? /Indexing enabled/i.test(mdutil) : null,
  tested: false,
};

if (mailRoot && fda && files.length) {
  // Sample across the whole walk rather than off the front: the walk returns
  // account by account and mailbox by mailbox, so the first N files are all one
  // mailbox and would measure that mailbox's indexing, not the store's.
  const stride = Math.max(1, Math.floor(files.length / SAMPLE));
  const sample = files.filter((_, i) => i % stride === 0).slice(0, SAMPLE);

  let ingested = 0;
  let withText = 0;
  let roundTripAttempted = 0;
  let roundTripHit = 0;
  let needleless = 0;
  let unreadable = 0;
  const needleLengths = [];
  const roundTripMs = [];
  const bodyReadMs = [];

  for (const f of sample) {
    const md = mdIndexed(f.path);
    if (md.contentType) ingested += 1;
    if (md.textContent) withText += 1;

    const t0 = performance.now();
    const parsed = readBody(f.path);
    bodyReadMs.push(performance.now() - t0);
    if (!parsed.ok) {
      unreadable += 1;
      continue;
    }

    const needle = needleFrom(parsed);
    if (!needle) {
      needleless += 1;
      continue;
    }
    needleLengths.push(needle.length);

    // The decisive measurement. Everything above says whether Spotlight has
    // heard of the file; this says whether searching for a word that appears
    // ONLY in this message's body actually returns this message.
    const found = mdfind(needle, mailRoot);
    roundTripAttempted += 1;
    roundTripMs.push(found.ms);
    if (found.paths.includes(f.path)) roundTripHit += 1;
  }

  Object.assign(spotlight, {
    tested: true,
    sampled: sample.length,
    unreadable,
    ingested,
    ingestedRate: pct(ingested, sample.length),
    withTextContent: withText,
    textContentRate: pct(withText, sample.length),
    needleless,
    meanNeedleLength: mean(needleLengths),
    roundTrip: {
      attempted: roundTripAttempted,
      hit: roundTripHit,
      // THE NUMBER THE DECISION TURNS ON.
      coverage: pct(roundTripHit, roundTripAttempted),
      meanQueryMs: mean(roundTripMs),
    },
    meanBodyReadMs: mean(bodyReadMs),
  });
}

doc.findings.spotlight = spotlight;

// ─── 6. LANE 2 — what an owned FTS5 index would cost ─────────────────────────
// Extrapolated from the sample rather than measured whole, because measuring it
// whole IS the cost being measured and would take the probe out of "run it and
// see" territory. The walk above already paid the stat half honestly.

doc.findings.fts5 = { tested: false };

if (files.length && doc.findings.walk.ran) {
  const stride = Math.max(1, Math.floor(files.length / Math.min(SAMPLE, files.length)));
  const sample = files.filter((_, i) => i % stride === 0).slice(0, SAMPLE);

  const started = performance.now();
  let bytesRead = 0;
  let textBytes = 0;
  let failed = 0;
  for (const f of sample) {
    const parsed = readBody(f.path);
    if (!parsed.ok) {
      failed += 1;
      continue;
    }
    bytesRead += parsed.bytes;
    textBytes += parsed.body.length;
  }
  const elapsed = performance.now() - started;

  const perFileMs = sample.length ? elapsed / sample.length : 0;
  // The walk saw `filesSeen`; `filesRecorded` may be capped below it. Project
  // against the larger number or the estimate flatters itself.
  const totalFiles = doc.findings.walk.filesSeen || files.length;
  const textRatio = bytesRead ? textBytes / bytesRead : 0;

  doc.findings.fts5 = {
    tested: true,
    sampled: sample.length,
    failed,
    perFileMs: Number(perFileMs.toFixed(2)),
    textRatio: Number(textRatio.toFixed(3)),
    projected: {
      files: totalFiles,
      // Single-threaded and cold-cache-free: the sample was read moments after
      // the walk stat'd it, so this is an OPTIMISTIC floor, not a forecast.
      buildSeconds: Math.round((perFileMs * totalFiles) / 1000),
      extractedTextBytes: Math.round(textRatio * (doc.findings.walk.meanBytes ?? 0) * totalFiles),
      // FTS5 with the default tokenizer lands near the size of the text it
      // indexes once the docsize and idx shadow tables are counted.
      approxIndexBytes: Math.round(
        textRatio * (doc.findings.walk.meanBytes ?? 0) * totalFiles * 1.1,
      ),
    },
    note:
      "An owned index is a second copy of the user's mail on their disk that Cupertino would " +
      "then have to keep in step with Mail forever. The build cost below is the cheap half.",
  };
}

// ─── 7. LANE 3 — narrow on the index, then scan the survivors ────────────────
// The question is not whether this works — it obviously does — but where it
// stops working. A filter that leaves 200 survivors is a body search; one that
// leaves 40,000 is a full scan with extra steps and a silent truncation.

const narrow = { tested: false };

if (db) {
  const cutoff = Math.floor(Date.now() / 1000) - DAYS * 86_400;
  const windowCount = t.one(
    "SELECT COUNT(*) AS c FROM messages WHERE deleted = 0 AND date_received > ?",
    cutoff,
  )?.c;

  // The narrowest realistic filter a user actually types, and the widest one.
  // Both matter: the gap between them is the range over which this lane has to
  // hold up, and it is wide.
  const busiest = t.one(
    "SELECT mailbox, COUNT(*) AS c FROM messages WHERE deleted = 0 AND date_received > ? " +
      "GROUP BY mailbox ORDER BY c DESC LIMIT 1",
    cutoff,
  );

  const perBodyMs = doc.findings.spotlight.meanBodyReadMs ?? doc.findings.fts5?.perFileMs ?? null;

  Object.assign(narrow, {
    tested: true,
    days: DAYS,
    survivorsWholeStore: windowCount ?? null,
    survivorsBusiestMailbox: busiest?.c ?? null,
    perBodyMs,
    projectedMs: {
      wholeStore: perBodyMs && windowCount ? Math.round(perBodyMs * windowCount) : null,
      busiestMailbox: perBodyMs && busiest?.c ? Math.round(perBodyMs * busiest.c) : null,
    },
  });
}

doc.findings.narrowThenScan = narrow;

// ─── 8. Verdict ──────────────────────────────────────────────────────────────
// Stated as a rule rather than a preference, so a future run on a different
// machine reaches the same conclusion from its own numbers.

const cov = doc.findings.spotlight?.roundTrip?.coverage ?? null;

doc.verdict.coverage = cov;
doc.verdict.lane = !fda
  ? "unknown — no Full Disk Access, so no lane could be measured"
  : cov === null
    ? "unknown — the round trip never ran"
    : cov >= 0.95
      ? "spotlight"
      : cov >= 0.6
        ? "spotlight+fallback"
        : "owned-fts5";

doc.verdict.recommendation =
  {
    spotlight:
      "Spotlight covers the store. Take the free lane: mdfind scoped to the Mail root, map the " +
      "returned .emlx paths back to ROWIDs with basename(), and intersect that set with the " +
      "existing Envelope Index predicates. No index to build, nothing to keep fresh, no second " +
      "copy of anyone's mail on disk.",
    "spotlight+fallback":
      "Spotlight sees most of the store but not all of it. Ship it as the fast path and say so in " +
      "the tool result the way indexAgeSeconds and walBlind already do — a coverage number the " +
      "model can read beats a silent miss. Narrow-then-scan fills the gap for bounded queries.",
    "owned-fts5":
      "Spotlight cannot be trusted for this. Build and own an FTS5 index, and budget for the " +
      "incremental refresh problem that comes with it — the build cost measured above is the " +
      "cheap half.",
    unknown: "Not measured. Grant Full Disk Access, make sure Mail is running, and re-run.",
  }[doc.verdict.lane.split(" ")[0]] ?? "Not measured.";

if (doc.findings.walk.capped) {
  doc.notes.push(
    `The file walk hit its cap of ${WALK_CAP} and stopped recording. Counts are lower bounds; ` +
      "re-run with a larger --walk for a full picture.",
  );
}
if (store.walBlind) {
  doc.notes.push(
    "The Envelope Index only opened immutable=1, which skips the -wal. Recent mail may be " +
      "missing from every count above.",
  );
}
if (!lane.available) doc.notes.push(lane.reason);

// ─── 9. Report ───────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const f = doc.findings;
  const L = [];

  L.push("");
  L.push("Apple Mail — BODY SEARCH lane probe");
  L.push(`  macOS ${doc.macos}   node ${doc.node}`);
  L.push("");

  L.push("STORE");
  L.push(`  via accountDirectory : ${f.locate.viaAccountDirectory ?? "(Mail did not answer)"}`);
  L.push(`  via V* glob          : ${f.locate.viaGlob ?? "(unreadable without FDA)"}`);
  L.push(`  agree                : ${yn(f.locate.agree)}`);
  L.push(`  Full Disk Access     : ${f.fullDiskAccess}`);
  L.push("");

  L.push("INDEX");
  if (f.index.opened) {
    L.push(`  opened ${f.index.mode} in ${f.index.openMs} ms, sqlite ${f.index.sqlite}`);
    L.push(`  messages             : ${f.index.messageCount}`);
    L.push(`  searchable_messages  : ${f.index.searchableMessages}`);
    L.push(`  body_indexed = 1     : ${f.index.bodyIndexedRows}`);
    // The finding that sent this probe to Spotlight. Printed even when empty —
    // especially when empty.
    L.push(
      `  FTS tables           : ${f.index.ftsTables.length ? f.index.ftsTables.join(", ") : "NONE — Mail delegates body search elsewhere"}`,
    );
  } else {
    L.push(`  not opened: ${f.index.error}`);
  }
  L.push("");

  L.push("FILES");
  if (f.walk.ran) {
    L.push(
      `  walked ${f.walk.filesSeen} .emlx in ${f.walk.ms} ms${f.walk.capped ? " (CAPPED)" : ""}`,
    );
    L.push(`  recorded             : ${f.walk.filesRecorded}, mean ${f.walk.meanBytes} B`);
    L.push(`  .partial.emlx        : ${f.walk.partialCount} (${pc(f.walk.partialRatio)})`);
    L.push(`  path -> ROWID parse  : ${pc(f.walk.rowidParseRate)}`);
    if (f.bridge.tested) {
      L.push(
        `  ROWID -> messages    : ${f.bridge.resolved}/${f.bridge.sampled} (${pc(f.bridge.rate)}) — the join lanes 1 and 3 need`,
      );
    }
  } else {
    L.push("  not walked (no grant, or no store located)");
  }
  L.push("");

  L.push("LANE 1 — Spotlight");
  L.push(`  volume indexing      : ${f.spotlight.volumeStatus ?? "?"}`);
  if (f.spotlight.tested) {
    L.push(`  sampled              : ${f.spotlight.sampled} files`);
    L.push(`  known to Spotlight   : ${pc(f.spotlight.ingestedRate)}`);
    L.push(`  with text content    : ${pc(f.spotlight.textContentRate)}`);
    L.push(
      `  body round trip      : ${f.spotlight.roundTrip.hit}/${f.spotlight.roundTrip.attempted} = ${pc(f.spotlight.roundTrip.coverage)}  <-- THE NUMBER`,
    );
    L.push(`  mean mdfind          : ${f.spotlight.roundTrip.meanQueryMs} ms`);
    if (f.spotlight.needleless) {
      L.push(
        `  no needle found      : ${f.spotlight.needleless} (body too short, or all its words are in the headers)`,
      );
    }
  } else {
    L.push("  not tested (no grant, or nothing walked)");
  }
  L.push("");

  L.push("LANE 2 — an owned FTS5 index");
  if (f.fts5?.tested) {
    L.push(`  read cost            : ${f.fts5.perFileMs} ms/file over ${f.fts5.sampled} files`);
    L.push(`  text / file bytes    : ${pc(f.fts5.textRatio)}`);
    L.push(
      `  projected build      : ${f.fts5.projected.buildSeconds} s for ${f.fts5.projected.files} files (optimistic floor)`,
    );
    L.push(
      `  projected index size : ~${Math.round(f.fts5.projected.approxIndexBytes / 1e6)} MB on the user's disk, forever`,
    );
  } else {
    L.push("  not tested");
  }
  L.push("");

  L.push("LANE 3 — narrow, then scan");
  if (f.narrowThenScan.tested) {
    L.push(`  window               : ${f.narrowThenScan.days} days`);
    L.push(
      `  survivors, store     : ${f.narrowThenScan.survivorsWholeStore} -> ${f.narrowThenScan.projectedMs.wholeStore} ms`,
    );
    L.push(
      `  survivors, busiest   : ${f.narrowThenScan.survivorsBusiestMailbox} -> ${f.narrowThenScan.projectedMs.busiestMailbox} ms`,
    );
  } else {
    L.push("  not tested");
  }
  L.push("");

  L.push("VERDICT");
  L.push(`  coverage : ${pc(doc.verdict.coverage)}`);
  L.push(`  lane     : ${doc.verdict.lane}`);
  for (const line of String(doc.verdict.recommendation).split(/(?<=\.) (?=[A-Z])/)) {
    L.push(`     ${line}`);
  }
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}
