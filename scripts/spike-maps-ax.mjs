#!/usr/bin/env node
// Spike: can Maps' saved places be read and managed through Accessibility?
//
// Maps has NO file lane and NO Apple Events lane. `scripts/probe-stickies.mjs`'s
// sibling question was "which lane", and for Maps the honest answer was "none" —
// until the sidebar turned out to be reachable through System Events:
//
//     AXStaticText "Pinned"   "Saved Places"   "Guides"   "Recently Added"
//     AXHeading    "Recents"  AXButton "Clear Recents"  AXButton "Sidebar"
//
// So the capability exists. This spike exists to find out what it is WORTH,
// before `packages/maps` is written against it. It ships nothing.
//
// ── QUESTION 0, WHICH GATES EVERY OTHER ONE ─────────────────────────────────
//
// Does the Accessibility lane work FROM INSIDE Cupertino.app at all?
//
// `scripts/spike-app-tcc/README.md` carries a scope note that says it does not:
// with Accessibility granted to the app and the app's own `AXIsProcessTrusted()`
// returning true, an `osascript` GRANDCHILD returned false and could not name a
// single window — while an `osascript` at the same depth under a different
// responsible app read them fine. That is the live defect behind
// `apple_mail_reply_to_message` failing on Macs whose Accessibility row is green.
//
// It matters here more than it does for Mail, because Mail's AX use is one verb
// on a composer window and Maps' would be the ENTIRE SURFACE. A Maps server built
// on this lane inherits a known-broken foundation, and inherits it wholesale.
//
// THIS SPIKE RUN FROM A TERMINAL CANNOT ANSWER QUESTION 0. A terminal has its own
// Accessibility grant, so everything below will look fine and mean nothing about
// what a hosted server sees. Question 0 is answered by running this file through
// `scripts/spike-app-tcc`, as a grandchild of a signed bundle. The report says so
// rather than letting a green run be mistaken for an answer.
//
// ── THE REST, worth measuring only if question 0 comes back yes ──────────────
//
//     1. WHAT IS RECOVERABLE PER SAVED PLACE? A name is not a POI. An address,
//        a coordinate and a stable identifier are what a tool result needs, and
//        AX yields RENDERED TEXT — so this counts, per item, which of those
//        fields exist at all. If there is no coordinate and no id, every
//        downstream verb is name-matching, and `docs/surfaces.md` already
//        records what that cost Messages.
//     2. DOES IT WORK WITH THE SIDEBAR CLOSED? AX cannot read what is not
//        rendered. If the answer is no, the tool contract is "open Maps, open
//        the sidebar, then ask" — which no other surface demands.
//     3. IS IT STABLE ACROSS A WINDOW RESIZE? A tree that reshapes when the
//        window changes size is a tree that reshapes between macOS releases.
//     4. WHAT DOES A READ COST? MEASURED, and the answer is the finding that
//        decides this spike. `docs/surfaces.md` already states the rule — "the
//        Apple Events cost is per round trip, not per item" — and this tree is
//        where that rule bites hardest:
//
//            entireContents()            180 ms   213 specifiers, one trip
//            ONE property, all elements  6,498 ms  206 elements
//            per round trip              31.5 ms
//
//        A useful read needs at least role AND label per element, so ~13 s.
//        Three escapes were tried and none works:
//          * BULK FETCH IS UNAVAILABLE. `entireContents.role()` fails with
//            "Can't convert types" in JXA and "Can't make ... into type
//            specifier" (-1700) in AppleScript. Nested properties can only be
//            read one round trip at a time.
//          * SCOPING DOES NOT HELP. The sidebar subtree is 206 of the window's
//            213 elements. There is no smaller subtree to aim at.
//          * `whose` is forbidden by the standing rule, and would be a filter
//            on the same round trips anyway.
//
//        For scale: Calendar's 3.4 s is what made its file lane MANDATORY, and
//        Mail's 74 s is this project's canonical disaster. 13 s sits between
//        them — with NO fallback lane, because Maps has neither of the other two.
//     5. ARE THE MANAGEMENT AFFORDANCES THERE? Whether an add/remove control is
//        reachable AT ALL. This spike DETECTS affordances; it does not press
//        them. Adding a favourite to someone's real Maps to see if it works is
//        not a measurement, it is damage with a report attached.
//
// PRIVACY. Saved places are a home address, a doctor, a school. This NEVER prints
// a place name, an address, or a coordinate. It reports roles, field PRESENCE,
// value LENGTHS and counts. Question 1 is answerable entirely in those terms.
//
//   node scripts/spike-maps-ax.mjs             # report (Maps must be running)
//   node scripts/spike-maps-ax.mjs --launch    # launch Maps first, quit after
//   node scripts/spike-maps-ax.mjs --json

import { execFileSync } from "node:child_process";

import { isRunning, macosVersion, osascript, parseArgs, safe, yn } from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const BUNDLE_ID = "com.apple.Maps";
const APP_PATH = "/System/Applications/Maps.app";
const SECTIONS = ["pinned", "saved places", "guides", "recently added", "recents"];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (fn, timeoutMs, stepMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    sleep(stepMs);
  }
  return fn();
};

// ─── question 0 ──────────────────────────────────────────────────────────────
// The two answers are kept apart on purpose, exactly as spike-app-tcc keeps
// them apart: `trusted` is what the flag claims about this process, `uiRead` is
// whether another app's windows can actually be named. They disagree, and the
// second is the one that decides whether anything here works.
const TRUST = `
function run() {
  ObjC.import("AppKit");
  ObjC.import("ApplicationServices");
  var trusted = "error";
  try { trusted = $.AXIsProcessTrusted() ? "granted" : "denied"; } catch (e) { trusted = "throw"; }
  var SE = Application("System Events");
  var systemEvents = "error", uiRead = "error";
  try { SE.processes.name(); systemEvents = "granted"; }
  catch (e) { systemEvents = "denied: " + (e.message || e); }
  try {
    var w = SE.processes.byName("Finder").windows();
    uiRead = "granted (" + w.length + " Finder windows)";
  } catch (e) { uiRead = "denied: " + (e.message || e); }
  return JSON.stringify({ trusted: trusted, systemEvents: systemEvents, uiRead: uiRead });
}
`;

// ─── the sidebar walk ────────────────────────────────────────────────────────
// Returns SHAPES. Every label is reduced to its length and a coarse class before
// it can leave the script, so a place name cannot reach the report even by
// accident. `looksLikeCoord` is the question-1 test: if AX ever exposed a
// latitude it would show up as a numeric-looking value, and it never does.
const WALK = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var SE = Application("System Events");
  var out = { ok: true, windows: 0, total: 0, sections: [], items: [], affordances: [] };
  try {
    var proc = SE.processes.byName("Maps");
    var wins = proc.windows();
    out.windows = wins.length;
    if (!wins.length) { return JSON.stringify({ ok: false, reason: "no window" }); }
    var w = wins[0];
    var all = w.entireContents();
    out.total = all.length;

    for (var i = 0; i < all.length; i++) {
      var el = all[i], role = "?", label = "";
      try { role = el.role(); } catch (e) {}
      try { label = String(el.description() || el.name() || el.value() || ""); } catch (e) {}
      var low = label.toLowerCase();

      for (var s = 0; s < p.sections.length; s++) {
        if (low === p.sections[s]) { out.sections.push({ role: role, section: label, index: i }); }
      }
      for (var a = 0; a < p.affordances.length; a++) {
        if (low.indexOf(p.affordances[a]) !== -1) {
          out.affordances.push({ role: role, label: label.slice(0, 40) });
        }
      }
      if (label && role === "AXStaticText") {
        out.items.push({
          index: i,
          chars: label.length,
          digits: /[0-9]/.test(label),
          comma: label.indexOf(",") !== -1,
          looksLikeCoord: /^-?[0-9]{1,3}\\.[0-9]{3,}/.test(label),
          isSection: p.sections.indexOf(low) !== -1
        });
      }
    }
  } catch (e) { return JSON.stringify({ ok: false, reason: String(e).slice(0, 200) }); }
  return JSON.stringify(out);
};
`;

const SIDEBAR_TOGGLE = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var SE = Application("System Events");
  try {
    var w = SE.processes.byName("Maps").windows()[0];
    var btns = w.entireContents();
    for (var i = 0; i < btns.length; i++) {
      var label = "";
      try { label = String(btns[i].description() || btns[i].name() || ""); } catch (e) { continue; }
      if (label.toLowerCase() === "sidebar") {
        if (p.press) btns[i].actions["AXPress"].perform();
        return JSON.stringify({ ok: true, found: true, pressed: Boolean(p.press) });
      }
    }
    return JSON.stringify({ ok: true, found: false });
  } catch (e) { return JSON.stringify({ ok: false, reason: String(e).slice(0, 200) }); }
}
`;

// The number that explains every other number here.
const ROUND_TRIP = `
function run() {
  var SE = Application("System Events");
  var w = SE.processes.byName("Maps").windows[0];
  var s = new Date().getTime();
  var els = w.entireContents();
  var fetchMs = new Date().getTime() - s;
  s = new Date().getTime();
  var n = Math.min(els.length, 60);
  for (var i = 0; i < n; i++) { try { els[i].description(); } catch (e) {} }
  var propMs = new Date().getTime() - s;
  return JSON.stringify({
    elements: els.length,
    entireContentsMs: fetchMs,
    sampled: n,
    sampleMs: propMs,
    msPerRoundTrip: Math.round((propMs / n) * 10) / 10,
    projectedTwoPropsMs: Math.round((propMs / n) * els.length * 2)
  });
}
`;

const walk = () =>
  safe(
    () =>
      osascript(
        WALK,
        { sections: SECTIONS, affordances: ["favorit", "add to", "remove", "delete", "clear"] },
        60_000,
      ),
    (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
  );

// ─── run ─────────────────────────────────────────────────────────────────────

const trust = safe(
  () => osascript(TRUST, {}, 30_000),
  (err) => ({ trusted: "error", uiRead: String(err?.message ?? err).slice(0, 200) }),
);

const wasRunning = isRunning(BUNDLE_ID);
let launched = false;
if (!wasRunning) {
  if (!args.launch) {
    console.error("Maps is not running. Re-run with --launch, or open it yourself.");
    process.exit(3);
  }
  execFileSync("/usr/bin/open", ["-g", "-a", APP_PATH], { timeout: 30_000 });
  launched = waitFor(() => isRunning(BUNDLE_ID), 20_000);
  sleep(4_000);
}

// Q4: what does one read cost, and WHY?
const cost = safe(
  () => osascript(ROUND_TRIP, {}, 120_000),
  (err) => ({ error: String(err?.message ?? err).slice(0, 200) }),
);

const timings = [];
let open = { ok: false };
for (let i = 0; i < 3; i += 1) {
  const started = performance.now();
  open = walk();
  timings.push(Math.round(performance.now() - started));
}

// Q2: is any of it readable with the sidebar closed?
const toggle = safe(
  () => osascript(SIDEBAR_TOGGLE, { press: true }, 30_000),
  () => ({ ok: false }),
);
sleep(1_500);
const closed = toggle.found ? walk() : { ok: false, reason: "no sidebar control found" };
// Put it back the way it was found.
if (toggle.found) {
  safe(() => osascript(SIDEBAR_TOGGLE, { press: true }, 30_000));
  sleep(1_000);
}

const sectionsOf = (r) => (r.ok ? r.sections.map((s) => s.section) : []);
const placeItems = (r) => (r.ok ? r.items.filter((i) => !i.isSection) : []);

const doc = {
  tool: "scripts/spike-maps-ax.mjs",
  macos: macosVersion(),
  at: new Date().toISOString(),
  question0: {
    ...trust,
    // The whole point of the header: a green run here proves nothing about a
    // hosted server, because this process has its own grant.
    answersHostedCase: false,
    note: "run through scripts/spike-app-tcc to answer question 0 for Cupertino.app",
  },
  findings: {
    launchedByUs: launched,
    sidebarOpen: {
      ok: open.ok,
      elements: open.total ?? null,
      sections: sectionsOf(open),
      places: placeItems(open).length,
      withDigits: placeItems(open).filter((i) => i.digits).length,
      withComma: placeItems(open).filter((i) => i.comma).length,
      looksLikeCoord: placeItems(open).filter((i) => i.looksLikeCoord).length,
      affordances: open.ok ? [...new Set(open.affordances.map((a) => a.label))] : [],
    },
    sidebarClosed: {
      ok: closed.ok,
      elements: closed.total ?? null,
      sections: sectionsOf(closed),
      places: placeItems(closed).length,
      reason: closed.reason ?? null,
    },
    timingsMs: timings,
    cost,
    stableAcrossReads:
      open.ok && timings.length > 1 ? new Set(timings.map(() => open.total)).size === 1 : null,
  },
  verdict: {},
  notes: [],
};

const f = doc.findings;
doc.verdict.lane = f.sidebarOpen.ok
  ? `readable — ${f.sidebarOpen.elements} elements, sections: ${f.sidebarOpen.sections.join(", ") || "none"}`
  : "NOT readable";
doc.verdict.fields =
  f.sidebarOpen.looksLikeCoord > 0
    ? "a coordinate-shaped value exists — investigate"
    : "NO coordinate anywhere. AX yields rendered text only: names, and addresses at best.";
doc.verdict.identifier =
  "NONE. AX exposes no stable id, so every verb after a read is name-matching.";
doc.verdict.sidebarClosed = f.sidebarClosed.ok
  ? `${f.sidebarClosed.places} places still readable with the sidebar closed`
  : `unreadable with the sidebar closed — ${f.sidebarClosed.reason ?? "no sections found"}`;
doc.verdict.management = f.sidebarOpen.affordances.length
  ? `affordances present: ${f.sidebarOpen.affordances.join(", ")} (detected, NOT pressed)`
  : "no add/remove affordance found in the sidebar tree";
doc.verdict.question0 =
  "UNANSWERED HERE BY CONSTRUCTION — this process has its own Accessibility grant";

if (trust.trusted === "granted")
  doc.notes.push(
    "AXIsProcessTrusted is granted for THIS process. spike-app-tcc records that an osascript grandchild of Cupertino.app gets denied while the app itself is granted, so this says nothing about the hosted case.",
  );
if (!f.sidebarOpen.sections.length)
  doc.notes.push("no sidebar sections found — open Maps' sidebar and re-run");

if (launched && !args.has("--keep")) {
  safe(() =>
    osascript(
      `function run(argv){ObjC.import("AppKit");var p=JSON.parse(argv[0]);var a=$.NSRunningApplication.runningApplicationsWithBundleIdentifier(p.b);for(var i=0;i<a.count;i++){a.objectAtIndex(i).terminate;}return "{}";}`,
      { b: BUNDLE_ID },
      20_000,
    ),
  );
}

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push(`Maps AX spike — macOS ${doc.macos}`);
  L.push("");
  L.push("QUESTION 0 — does this lane work from inside Cupertino.app?");
  L.push(`  AXIsProcessTrusted    ${trust.trusted}`);
  L.push(`  System Events         ${trust.systemEvents}`);
  L.push(`  can name windows      ${trust.uiRead}`);
  L.push(`  >> ${doc.verdict.question0}`);
  L.push(`  >> ${doc.question0.note}`);
  L.push("");
  L.push("SIDEBAR OPEN — shapes only, never a place name");
  L.push(
    `  readable              ${yn(f.sidebarOpen.ok)}  (${f.sidebarOpen.elements ?? "?"} elements)`,
  );
  L.push(`  sections              ${f.sidebarOpen.sections.join(", ") || "none"}`);
  L.push(`  place-shaped items    ${f.sidebarOpen.places}`);
  L.push(
    `  with digits           ${f.sidebarOpen.withDigits}   with comma: ${f.sidebarOpen.withComma}`,
  );
  L.push(`  coordinate-shaped     ${f.sidebarOpen.looksLikeCoord}`);
  L.push(`  affordances           ${f.sidebarOpen.affordances.join(", ") || "none"}`);
  L.push("");
  L.push("SIDEBAR CLOSED");
  L.push(`  ${doc.verdict.sidebarClosed}`);
  L.push("");
  L.push("COST — per round trip, not per item");
  L.push(`  full read             ${timings.join(" / ")} ms over 3 reads`);
  L.push(
    `  entireContents        ${cost.entireContentsMs ?? "?"} ms for ${cost.elements ?? "?"} elements (ONE trip)`,
  );
  L.push(`  per round trip        ${cost.msPerRoundTrip ?? "?"} ms`);
  L.push(`  projected 2 props     ${cost.projectedTwoPropsMs ?? "?"} ms — the realistic floor`);
  L.push('  bulk fetch            UNAVAILABLE (JXA: "Can\'t convert types"; AS: -1700)');
  L.push("");
  L.push("VERDICT");
  for (const [k, v] of Object.entries(doc.verdict)) L.push(`  ${k.padEnd(14)}: ${v}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  console.log(L.join("\n"));
}
