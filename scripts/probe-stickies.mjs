#!/usr/bin/env node
// Phase 0 spike for @mgcrea/mcp-apple-stickies.
//
// Stickies is the first surface with NO Apple Events lane at all. There is no
// `.sdef` in Stickies.app on macOS 26.6 — checked directly rather than inferred
// from `NSAppleScriptEnabled` — so `docs/surfaces.md`'s "file lane or nothing"
// is not a preference here, it is the whole design. That removes the questions
// every previous probe spent most of its time on (is `whose` slow, what does a
// round trip cost, can the two lanes be joined) and replaces them with different
// ones.
//
// It is also the first probe with NO SQLITE. There is no database: each note is
// an RTFD package and the appearance metadata sits in a plist beside them. So
// this uses only the filesystem half of `scripts/lib/probe-kit.mjs` —
// `readable`, `exists`, `fileFacts`, `listable`, `isRunning` — and none of
// `openStore` / `dumpSchema` / `tableTools` / `findIdBridge` / `detectEpoch`.
// There is no schema fixture to capture with `--write`, which is why this probe
// does not offer that flag.
//
//     ~/Library/Containers/com.apple.Stickies/Data/Library/Stickies/
//     ├── <UUID>.rtfd/TXT.rtf     the note
//     └── .SavedStickiesState     XML plist: an array of per-note appearance
//
// THE SEVEN QUESTIONS:
//
//     1. DOES STICKIES ADOPT AN ORPHAN PACKAGE? Write an .rtfd with no state
//        entry, launch Stickies, quit it, and see what happened to it. This
//        decides the whole write design. MEASURED, macOS 26.6: it adopts the
//        note AND RE-KEYS IT, moving the content to a UUID of its own choosing
//        and writing a state entry for that. So the question has to be asked by
//        CONTENT, never by the UUID that was written — asking by UUID reports a
//        successful adoption as a failure, and leaves the cleanup step deleting
//        a directory that no longer exists. Needs --write-probe.
//     2. IS THE CONTAINER GATED, AND FOR WRITING TOO? Reads are the usual Full
//        Disk Access question. Writing is NOT — no existing surface writes to a
//        protected path at all, so W_OK has never been established here.
//     3. DOES STICKIES CLOBBER A NOTE WRITTEN WHILE IT IS RUNNING? The app holds
//        its notes in memory and rewrites state on quit. Needs --write-probe.
//     4. WHAT RGB DOES EACH STOCK COLOUR EMIT? The plist stores colours as RGBA
//        floats, never as a name, so a name has to be recovered by matching.
//     5. HOW FAR APART ARE THE STATE FILE AND THE DIRECTORY? Orphans in both
//        directions. This is the id-bridge question in its Stickies form.
//     6. WHAT ELSE LIVES IN A .rtfd? Anything that is not TXT.rtf is an
//        attachment, and sizes the attachment tools.
//     7. DOES THE RTF READER AGREE WITH COCOA? Every note is decoded twice —
//        once by scripts/lib/rtf.mjs and once by NSAttributedString — and any
//        disagreement fails the probe. Without this the reader is only tested
//        against its author's reading of the spec.
//
// NO APPLE EVENT IS EVER SENT, INCLUDING BY --write-probe. The osascript calls
// here go through the ObjC bridge to Foundation and AppKit, exactly as
// `packages/safari/src/client/jxa/bookmarks.ts` does for Bookmarks.plist: they
// need Full Disk Access, which osascript inherits, and no Automation grant.
//
// That constraint is why --write-probe terminates Stickies through
// `NSRunningApplication.terminate` rather than through the obvious
// `tell application "Stickies" to quit`. The AppleScript spelling would be an
// Apple Event, so on a machine with no Automation grant the probe would fail at
// its most important measurement with a -1743 that looks like a finding about
// Stickies rather than about the probe. It would also make this header false.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, lengths, line counts, booleans, colours
// and file names only. NO NOTE TEXT, and no note title. A sticky is where people
// put the thing they did not want to forget — a door code, a dosage, a name —
// and it is short enough that a "snippet" is usually the whole note. Text is
// read into memory to be compared against Cocoa's decode and is never printed.
//
//   node scripts/probe-stickies.mjs                 # human-readable report
//   node scripts/probe-stickies.mjs --json          # the raw document
//   node scripts/probe-stickies.mjs --write-probe   # also answer Q1 and Q3
//
// --write-probe MUTATES YOUR STICKIES. It creates one note, launches and quits
// Stickies, and removes what it created. It refuses to run unless Stickies is
// closed, and it never edits or deletes a note it did not write.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  exists,
  fileFacts,
  isRunning,
  listable,
  macosVersion,
  osascript,
  parseArgs,
  readable,
  safe,
  yn,
} from "./lib/probe-kit.mjs";
import { rtfToPlainText } from "./lib/rtf.mjs";

const args = parseArgs(process.argv.slice(2));
const WRITE_PROBE = args.has("--write-probe");

const BUNDLE_ID = "com.apple.Stickies";
const APP_PATH = "/System/Applications/Stickies.app";
const STICKIES_DIR = join(
  homedir(),
  "Library",
  "Containers",
  BUNDLE_ID,
  "Data",
  "Library",
  "Stickies",
);
const STATE_FILE = join(STICKIES_DIR, ".SavedStickiesState");

// ─── the two ObjC-bridge scripts ─────────────────────────────────────────────
// Static constants piped to stdin, every input through argv[0], exactly as
// packages/core/src/osascript.ts requires. Neither sends an Apple Event.

const READ_STATE = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("Foundation");
  var arr = $.NSArray.arrayWithContentsOfFile(p.path);
  if (!arr || (arr.isNil && arr.isNil())) {
    return JSON.stringify({ ok: false, reason: "not readable as a plist array" });
  }
  return JSON.stringify({ ok: true, entries: ObjC.deepUnwrap(arr) });
}
`;

// Ground truth for question 7. NSAttributedString is what WROTE these files, so
// it is the only decoder whose answer is not an opinion.
const READ_RTFD = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("AppKit");
  var out = [];
  for (var i = 0; i < p.paths.length; i++) {
    var url = $.NSURL.fileURLWithPath(p.paths[i]);
    var s = $.NSAttributedString.alloc.initWithURLOptionsDocumentAttributesError(
      url, $(), null, Ref());
    if (!s || (s.isNil && s.isNil())) { out.push({ ok: false }); continue; }
    out.push({ ok: true, text: ObjC.unwrap(s.string) });
  }
  return JSON.stringify({ ok: true, notes: out });
}
`;

// Quit WITHOUT an Apple Event. See the header.
const TERMINATE = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  ObjC.import("AppKit");
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(p.bundleId);
  var asked = 0;
  for (var i = 0; i < apps.count; i++) { apps.objectAtIndex(i).terminate; asked++; }
  return JSON.stringify({ ok: true, asked: asked });
}
`;

/**
 * Wait for a condition without busy-spinning.
 *
 * `isRunning` costs an osascript spawn, so a bare `while (!isRunning())` fires
 * hundreds of subprocesses a second and measures the machine's load rather than
 * the app's startup. `Atomics.wait` blocks this thread properly, which is what
 * the surrounding synchronous code needs.
 */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (predicate, timeoutMs, stepMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleep(stepMs);
  }
  return predicate();
};

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const writable = (p) =>
  safe(
    () => {
      accessSync(p, constants.W_OK);
      return true;
    },
    () => false,
  );

// ─── Q2: is there a file lane, and does it extend to writing? ────────────────

const dir = fileFacts(STICKIES_DIR);
const store = {
  dir,
  dirListable: listable(STICKIES_DIR),
  dirWritable: writable(STICKIES_DIR),
  state: fileFacts(STATE_FILE),
  stateWritable: writable(STATE_FILE),
  // The claim `docs/surfaces.md` makes about this app, checked rather than cited.
  appInstalled: exists(APP_PATH),
  sdefs: safe(
    () => readdirSync(join(APP_PATH, "Contents", "Resources")).filter((f) => f.endsWith(".sdef")),
    () => [],
  ),
  running: isRunning(BUNDLE_ID),
};

// ─── the inventory: packages on disk ─────────────────────────────────────────

const packages = [];
if (store.dirListable) {
  for (const name of readdirSync(STICKIES_DIR).toSorted()) {
    if (!name.endsWith(".rtfd")) continue;
    const path = join(STICKIES_DIR, name);
    const uuid = name.slice(0, -5);
    const entries = safe(
      () => readdirSync(path),
      () => [],
    );
    const txt = join(path, "TXT.rtf");
    packages.push({
      uuid,
      path,
      files: entries.length,
      // Q6: anything that is not the text is an attachment.
      attachments: entries.filter((f) => f !== "TXT.rtf" && !f.startsWith(".")),
      hasText: exists(txt),
      textReadable: readable(txt),
      bytes: safe(
        () => statSync(txt).size,
        () => null,
      ),
      // There is NO date anywhere in the store. These come from the filesystem
      // and a tool result must say so rather than implying the app recorded them.
      modified: safe(
        () => statSync(txt).mtime.toISOString(),
        () => null,
      ),
      created: safe(
        () => statSync(path).birthtime.toISOString(),
        () => null,
      ),
    });
  }
}

// ─── Q4 + Q5: the state plist ────────────────────────────────────────────────

const KNOWN_COLOURS = [
  // Filled in from real notes by question 4. Each is the `StickyColor` RGB a
  // stock swatch produces; the probe reports any colour it cannot name.
  { name: "yellow", rgb: [0.996, 0.957, 0.612] },
  { name: "blue", rgb: [0.639, 0.855, 0.988] },
  { name: "green", rgb: [0.706, 0.933, 0.639] },
  { name: "pink", rgb: [0.996, 0.753, 0.859] },
  { name: "purple", rgb: [0.855, 0.784, 0.98] },
  { name: "gray", rgb: [0.882, 0.882, 0.882] },
];

const nameColour = (c) => {
  if (!c) return null;
  const rgb = [c.Red, c.Green, c.Blue];
  if (rgb.some((v) => typeof v !== "number")) return null;
  let best = null;
  for (const k of KNOWN_COLOURS) {
    const d = Math.hypot(...k.rgb.map((v, i) => v - rgb[i]));
    if (!best || d < best.d) best = { name: k.name, d };
  }
  // Loose enough to survive a swatch being retuned between releases, tight
  // enough that a custom colour is reported as custom rather than mislabelled.
  return best && best.d < 0.12 ? best.name : null;
};

const round3 = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : null);

let state = { ok: false, reason: "not attempted" };
if (store.state.exists) {
  state = safe(
    () => osascript(READ_STATE, { path: STATE_FILE }, 20_000),
    (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
  );
}

const stateEntries = (state.ok ? (state.entries ?? []) : []).map((e) => ({
  uuid: e.UUID ?? null,
  colour: nameColour(e.StickyColor),
  rgb: e.StickyColor
    ? [round3(e.StickyColor.Red), round3(e.StickyColor.Green), round3(e.StickyColor.Blue)]
    : null,
  floating: e.Floating ?? null,
  translucent: e.Translucent ?? null,
  zOrder: e.ZOrder ?? null,
  hasFrame: typeof e.Frame === "string",
  keys: Object.keys(e).toSorted(),
}));

const onDisk = new Set(packages.map((p) => p.uuid));
const inState = new Set(stateEntries.map((e) => e.uuid).filter(Boolean));
const join5 = {
  packages: onDisk.size,
  stateEntries: inState.size,
  matched: [...onDisk].filter((u) => inState.has(u)).length,
  // A package with no state entry. If Q1 says the app adopts these, this is a
  // normal note with default appearance rather than damage.
  packagesWithoutState: [...onDisk].filter((u) => !inState.has(u)).length,
  // A state entry naming a note that is not there. Observed on the probed
  // machine BEFORE this probe ever ran, with Stickies closed.
  stateWithoutPackage: [...inState].filter((u) => !onDisk.has(u)).length,
  // Every key seen across every entry, so a schema change is visible as a diff.
  stateKeys: [...new Set(stateEntries.flatMap((e) => e.keys))].toSorted(),
};

// ─── Q7: does the reader agree with Cocoa? ───────────────────────────────────

const decodable = packages.filter((p) => p.textReadable);
let truth = { ok: false, reason: "no readable package" };
if (decodable.length) {
  truth = safe(
    () => osascript(READ_RTFD, { paths: decodable.map((p) => p.path) }, 60_000),
    (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
  );
}

const decode = { tested: 0, agreed: 0, disagreed: [], notes: [] };
if (truth.ok) {
  decodable.forEach((pkg, i) => {
    const cocoa = truth.notes[i];
    if (!cocoa?.ok) return;
    const mine = safe(
      () => rtfToPlainText(readFileSync(join(pkg.path, "TXT.rtf"))),
      () => null,
    );
    // Cocoa reports the document's own trailing break; rtfToPlainText trims it.
    const theirs = String(cocoa.text ?? "").replace(/\s+$/, "");
    decode.tested += 1;
    if (mine === theirs) decode.agreed += 1;
    else
      decode.disagreed.push({
        uuid: pkg.uuid,
        // Shapes, never content. A length and a hash localise a bug without
        // printing the note that found it.
        mineLength: mine?.length ?? null,
        cocoaLength: theirs.length,
        mineSha: mine === null ? null : sha(mine),
        cocoaSha: sha(theirs),
      });
    decode.notes.push({
      uuid: pkg.uuid,
      chars: theirs.length,
      lines: theirs ? theirs.split("\n").length : 0,
      empty: theirs.length === 0,
      // Codepoint test rather than a control-character regex: the point is
      // "did the codepage or \\u path get exercised", and a regex range that
      // spans control characters is both a lint error and harder to read.
      nonAscii: [...theirs].some((c) => c.codePointAt(0) > 0x7f),
    });
  });
}

// ─── Q1 + Q3: the write questions ────────────────────────────────────────────
//
// Both mutate. Both clean up after themselves. Neither touches a note this probe
// did not create, and the state file is never written to by the probe at all —
// which is the point: question 1 asks whether it NEEDS to be.

const PROBE_MARKER = "cupertino-probe-stickies";

/**
 * Find every package this probe wrote, wherever Stickies has since moved it.
 *
 * Keyed on the marker text rather than on a UUID, because the app re-keys what
 * it adopts. Cleanup that trusts the UUID it wrote deletes nothing and leaves a
 * probe note sitting in someone's Stickies.
 */
const findProbePackages = () =>
  (listable(STICKIES_DIR) ? readdirSync(STICKIES_DIR) : [])
    .filter((n) => n.endsWith(".rtfd"))
    .map((n) => join(STICKIES_DIR, n))
    .filter((pkgPath) =>
      safe(
        () => rtfToPlainText(readFileSync(join(pkgPath, "TXT.rtf"))).trim() === PROBE_MARKER,
        () => false,
      ),
    );

const removeProbePackages = () => {
  const found = findProbePackages();
  for (const pkgPath of found) safe(() => rmSync(pkgPath, { recursive: true, force: true }));
  return { found: found.length, remaining: findProbePackages().length };
};

// `--cleanup` on its own: remove anything a previous --write-probe left behind
// and stop. Nothing else in this file mutates, so this is always safe to run.
if (args.has("--cleanup")) {
  if (isRunning(BUNDLE_ID)) {
    console.error("Stickies is running — quit it first, or it will rewrite what this removes.");
    process.exit(3);
  }
  const { found, remaining } = removeProbePackages();
  console.log(`removed ${found} probe note(s); ${remaining} remaining`);
  process.exit(remaining ? 4 : 0);
}

const probeRtf =
  "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n" +
  "{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n" +
  "{\\colortbl;\\red255\\green255\\blue255;}\n" +
  `\\pard\\f0\\fs24 \\cf0 ${PROBE_MARKER}}`;

const writeProbe = { ran: false, reason: null };
if (WRITE_PROBE) {
  if (store.running) {
    writeProbe.reason = "Stickies is running — quit it and re-run";
  } else if (!store.dirWritable) {
    writeProbe.reason = "the container is not writable";
  } else {
    writeProbe.ran = true;
    // A UUID this probe owns, so cleanup can never touch a real note.
    const uuid = "0F0BE000-0000-4000-8000-000000000001";
    const pkg = join(STICKIES_DIR, `${uuid}.rtfd`);
    const before = new Set(stateEntries.map((e) => e.uuid));
    try {
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "TXT.rtf"), probeRtf, "latin1");
      writeProbe.wrotePackage = true;

      // Launch WITHOUT activating, the same courtesy Permissions.swift extends
      // when it opens a target to settle an Automation prompt.
      execFileSync("/usr/bin/open", ["-g", "-a", APP_PATH], { timeout: 30_000 });
      writeProbe.launched = waitFor(() => isRunning(BUNDLE_ID), 20_000);

      // Stickies writes .SavedStickiesState on QUIT, not on read, so the whole
      // question needs a full launch-and-quit cycle. Give it a moment to finish
      // reading the store before asking it to go away.
      sleep(2_000);
      safe(() => osascript(TERMINATE, { bundleId: BUNDLE_ID }, 20_000));
      writeProbe.quit = waitFor(() => !isRunning(BUNDLE_ID), 20_000);

      const after = safe(
        () => osascript(READ_STATE, { path: STATE_FILE }, 20_000),
        () => ({ ok: false }),
      );
      const afterIds = new Set(
        (after.ok ? (after.entries ?? []) : []).map((e) => e.UUID).filter(Boolean),
      );
      writeProbe.stateGrew = afterIds.size - before.size;

      // Q1 + Q3, asked by CONTENT. The text is what survives; the UUID is not.
      const survivors = findProbePackages();
      writeProbe.textSurvived = survivors.length > 0;
      writeProbe.keptOriginalUuid = survivors.some((sp) => sp.endsWith(`${uuid}.rtfd`));
      writeProbe.rekeyed = writeProbe.textSurvived && !writeProbe.keptOriginalUuid;
      writeProbe.newUuid = writeProbe.rekeyed
        ? (survivors[0].split("/").pop() ?? "").replace(/\.rtfd$/, "")
        : null;
      // Adoption is a state entry for wherever the note ended up.
      writeProbe.adopted = writeProbe.textSurvived && afterIds.has(writeProbe.newUuid ?? uuid);
      // Q5 again, after the app has had its say: does it prune stale entries?
      writeProbe.stalePruned = !afterIds.has([...before].find((b) => b) ?? "");
    } catch (err) {
      writeProbe.error = String(err?.message ?? err).slice(0, 300);
    } finally {
      // By marker, not by UUID. See findProbePackages.
      const swept = removeProbePackages();
      safe(() => rmSync(pkg, { recursive: true, force: true }));
      writeProbe.removed = swept.found;
      writeProbe.cleanedUp = swept.remaining === 0 && !exists(pkg);
    }
  }
}

// ─── the document ────────────────────────────────────────────────────────────

const doc = {
  tool: "scripts/probe-stickies.mjs",
  macos: macosVersion(),
  node: process.version,
  at: new Date().toISOString(),
  findings: {
    store,
    packages,
    state: { ok: state.ok, reason: state.reason ?? null },
    stateEntries,
    join: join5,
    decode,
    writeProbe,
  },
  verdict: {},
  notes: [],
};

doc.verdict.fileLane = store.dir.readable
  ? store.dirListable
    ? "available"
    : "readable but not listable — unusable"
  : store.dir.exists
    ? "PRESENT BUT NOT READABLE — re-run with Full Disk Access"
    : "absent — Stickies has never been used on this Mac";
doc.verdict.appleEventsLane =
  store.sdefs.length === 0
    ? "none — Stickies ships no scripting dictionary"
    : "UNEXPECTED: an sdef exists";
doc.verdict.writes = !WRITE_PROBE
  ? "not measured — re-run with --write-probe"
  : writeProbe.ran
    ? writeProbe.adopted
      ? writeProbe.rekeyed
        ? "the app ADOPTS an orphan package but RE-KEYS it — no state edit needed, but an id handed back to a caller does not survive the next launch"
        : "the app adopts an orphan package and keeps its UUID — writes need not touch .SavedStickiesState"
      : "the app did NOT adopt an orphan package — a create must splice the state plist"
    : `not measured — ${writeProbe.reason}`;
doc.verdict.decoder =
  decode.tested === 0
    ? "not measured — no readable note"
    : decode.disagreed.length === 0
      ? `agrees with Cocoa on ${decode.agreed}/${decode.tested} notes`
      : `DISAGREES with Cocoa on ${decode.disagreed.length}/${decode.tested} notes`;

if (join5.stateWithoutPackage > 0)
  doc.notes.push(
    `${join5.stateWithoutPackage} state entr${join5.stateWithoutPackage === 1 ? "y names a note" : "ies name notes"} that is not on disk — the directory is the source of truth, not the plist`,
  );
if (join5.packagesWithoutState > 0)
  doc.notes.push(
    `${join5.packagesWithoutState} package(s) have no state entry — they must still be listed, with default appearance`,
  );
if (packages.length < 5)
  doc.notes.push(
    `only ${packages.length} note(s) on this Mac — questions 4 and 6 need a populated Stickies to mean anything`,
  );
if (stateEntries.some((e) => !e.colour))
  doc.notes.push("at least one colour could not be named — KNOWN_COLOURS needs the measured RGB");

const exitCode = decode.disagreed.length ? 4 : 0;

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Stickies probe — macOS ${doc.macos}, node ${doc.node}`);
  L.push(`Stickies was running: ${yn(store.running)}   write probe: ${WRITE_PROBE ? "yes" : "no"}`);
  L.push("");
  L.push("LANES");
  L.push(`  Apple Events          ${doc.verdict.appleEventsLane}`);
  L.push(`  app installed         ${yn(store.appInstalled)}`);
  L.push(`  file lane             ${doc.verdict.fileLane}`);
  L.push("");
  L.push("STORE — the container, under Full Disk Access");
  L.push(
    `  directory             exists=${yn(store.dir.exists)} readable=${yn(store.dir.readable)} listable=${yn(store.dirListable)} WRITABLE=${yn(store.dirWritable)}`,
  );
  L.push(
    `  .SavedStickiesState   exists=${yn(store.state.exists)} readable=${yn(store.state.readable)} writable=${yn(store.stateWritable)} ${String(store.state.sizeBytes ?? "?")} B`,
  );
  L.push(`  packages              ${packages.length}`);
  L.push("");
  L.push("NOTES — shapes only, never text");
  for (const p of packages) {
    const d = decode.notes.find((n) => n.uuid === p.uuid);
    L.push(
      `  ${p.uuid.slice(0, 8)}  ${String(p.bytes ?? "?").padStart(6)} B  ` +
        `${String(d?.chars ?? "?").padStart(5)} chars  ${String(d?.lines ?? "?").padStart(3)} lines  ` +
        `attach=${p.attachments.length}  ${d?.nonAscii ? "non-ascii" : "ascii    "}  ${p.modified?.slice(0, 10) ?? "?"}`,
    );
  }
  L.push("");
  L.push("APPEARANCE — .SavedStickiesState");
  if (!state.ok) L.push(`  unreadable            ${state.reason}`);
  for (const e of stateEntries) {
    L.push(
      `  ${(e.uuid ?? "?").slice(0, 8)}  ${(e.colour ?? "UNNAMED").padEnd(8)} rgb=${JSON.stringify(e.rgb)}  z=${e.zOrder}  floating=${yn(e.floating)}  translucent=${yn(e.translucent)}`,
    );
  }
  L.push(`  keys seen             ${join5.stateKeys.join(", ") || "-"}`);
  L.push("");
  L.push("THE JOIN — state plist vs directory (the id-bridge question)");
  L.push(`  packages on disk      ${join5.packages}`);
  L.push(`  entries in state      ${join5.stateEntries}`);
  L.push(`  matched               ${join5.matched}`);
  L.push(`  package, no entry     ${join5.packagesWithoutState}`);
  L.push(`  entry, no package     ${join5.stateWithoutPackage}`);
  L.push("");
  L.push("THE DECODER vs COCOA — scripts/lib/rtf.mjs against NSAttributedString");
  L.push(`  ${doc.verdict.decoder}`);
  for (const d of decode.disagreed)
    L.push(
      `  MISMATCH ${d.uuid.slice(0, 8)}  mine=${d.mineLength} chars (${d.mineSha})  cocoa=${d.cocoaLength} chars (${d.cocoaSha})`,
    );
  L.push("");
  L.push("WRITES");
  L.push(`  ${doc.verdict.writes}`);
  if (writeProbe.ran) {
    L.push(`  wrote package         ${yn(writeProbe.wrotePackage)}`);
    L.push(`  app launched / quit   ${yn(writeProbe.launched)} / ${yn(writeProbe.quit)}`);
    L.push(`  app adopted it        ${yn(writeProbe.adopted)}`);
    L.push(`  kept our UUID         ${yn(writeProbe.keptOriginalUuid)}`);
    L.push(`  re-keyed to           ${writeProbe.newUuid ?? "-"}`);
    L.push(`  text survived         ${yn(writeProbe.textSurvived)}`);
    L.push(`  state entries gained  ${writeProbe.stateGrew}`);
    L.push(
      `  cleaned up            ${yn(writeProbe.cleanedUp)} (${writeProbe.removed ?? 0} removed)`,
    );
    if (writeProbe.error) L.push(`  ERROR                 ${writeProbe.error}`);
  }
  L.push("");
  L.push("VERDICT");
  for (const [k, v] of Object.entries(doc.verdict)) L.push(`  ${k.padEnd(16)}: ${v}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

process.exit(exitCode);
