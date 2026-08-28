#!/usr/bin/env node
// Spike: is there an Accessibility WRITE lane for Maps — and is it worth the cost?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// `pnpm probe:maps-write` closed three of the four lanes with measurements:
// no scripting dictionary, no App Intents registered on macOS, and SQL into
// `MapsSync_0.0.1` refused because a write means synthesising a GEO protobuf, an
// encoded `CKRecord` and the `NSPersistentHistoryTracking` rows the CloudKit
// exporter reads.
//
// The fourth lane was closed with the words "not pursued". That is an assertion,
// not a finding, and this repo's whole record on Maps is that assertions about
// Maps have been wrong three times.
//
// Accessibility deserves better than that, because it is the ONLY lane with the
// right shape. Every SQL objection above exists because a THIRD PARTY would be
// doing the writing. Through AX, Maps performs the write itself — it allocates
// the primary key, writes the history rows and registers the CloudKit record,
// exactly as it does when a person clicks. The objections to AX are real but
// they are different objections.
//
// ── THE GATE, WHICH THIS FILE CANNOT OPEN ────────────────────────────────────
//
// Accessibility DOES NOT WORK from inside Cupertino.app today.
// `scripts/spike-app-tcc/README.md` records it: the app's own
// `AXIsProcessTrusted()` returns true while an `osascript` grandchild of it
// returns false and cannot name a single window, though a grandchild under a
// different responsible app reads them fine. That is the live defect behind
// `apple_mail_reply_to_message` failing on Macs whose Accessibility row is green.
//
// So a terminal run of this file — where the TERMINAL holds the grant — says
// NOTHING about whether a hosted server could do any of it. What it can answer,
// cheaply, is whether there is anything to win at all. If Maps exposes no
// actionable add-a-place control, fixing the app defect buys Maps nothing and
// the lane is closed on evidence. If it does, the defect becomes worth fixing on
// its own merits, since it also unblocks Mail.
//
// Measure the cheap thing first. That is the only reason this runs before the
// bug is fixed.
//
// ── WHAT THIS ANSWERS ────────────────────────────────────────────────────────
//
//   0. IS THIS PROCESS TRUSTED, and is it reading a real Maps window? Reported
//      with the caveat above attached, so a green run cannot be mistaken for an
//      answer about the hosted case.
//   1. DOES THE MENU BAR CARRY A WRITE VERB? Asked FIRST and separately, because
//      a menu item is the most stable actionable element an app has — it has a
//      name, a path and an AXPress, and it does not reshape when a window
//      resizes or a card re-lays-out. A menu-bar lane would be a different
//      proposition from scraping a view hierarchy.
//   2. DOES ANY WINDOW CARRY ONE? Everything with an `AXPress` action, across
//      EVERY window — a popover is its own AXWindow and is where such a control
//      hides. Found by ACTION rather than by role, because Catalyst reports a
//      tappable control as a group or an image as often as as a button.
//   2b. COULD SUCH A LANE EVER BE RELIABLE? How many pressable elements have no
//      name. Those can only be clicked by position, which breaks on any layout
//      change — so many anonymous controls is a worse answer than none.
//   3. ARE THE CANDIDATES ACTUALLY ACTIONABLE? Whether `AXPress` is among each
//      candidate's actions. A control that cannot be pressed is a label.
//   4. WHAT DOES IT COST? Wall-clock for the menu walk, against the ~31.5 ms
//      per round trip `scripts/spike-maps-ax.mjs` measured.
//
// THIS SPIKE PRESSES NOTHING. It enumerates and reports. No menu is clicked, no
// button is pressed, nothing is added to anybody's Maps. Making it act is a
// separate decision and would need a separate file.
//
// PRIVACY. Menu and control TITLES are Apple's UI strings, but a submenu can
// hold the user's own guide names, so only titles MATCHING the verb pattern are
// printed. Everything else is reported as a count. A saved place is somebody's
// home, doctor and school, and that is as true in a menu as in a database.
//
// WINDOW TITLES ARE USER DATA TOO, which the first version of this file got
// wrong: Maps titles its window after wherever the map is centred, so a run
// printed the name of a town the user was looking at. Windows are numbered here,
// never named.
//
//   node scripts/spike-maps-ax-write.mjs
//   node scripts/spike-maps-ax-write.mjs --json
//
// Open Maps and select a place first — question 2 has nothing to look at
// otherwise, and an empty answer would read as "no control exists".

import { isRunning, macosVersion, osascript, parseArgs, safe, yn } from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const JSON_OUT = args.json;

/**
 * What a write verb looks like in a menu or on a button.
 *
 * Deliberately wider than "favourite": the write probe showed Maps files a saved
 * place as a `ZCOLLECTIONITEM`, and the intent strings Apple ships are about
 * Lists rather than Favourites. A pattern that only looked for "favourite" would
 * miss the verb most likely to exist.
 */
const VERBS = "add|save|favou?rite|guide|list|collection|pin|bookmark|new place";

const out = [];
const say = (line = "") => {
  if (!JSON_OUT) console.log(line);
  out.push(line);
};
const head = (n, title) => {
  say();
  say(`── ${n}. ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`);
};

const TRUST = `
function run() {
  ObjC.import("AppKit");
  ObjC.import("ApplicationServices");
  var trusted = "error";
  try { trusted = $.AXIsProcessTrusted() ? "granted" : "denied"; } catch (e) { trusted = "throw"; }
  var SE = Application("System Events");
  var systemEvents = "error", mapsWindows = "error";
  try { SE.processes.name(); systemEvents = "granted"; }
  catch (e) { systemEvents = "denied: " + (e.message || e); }
  try {
    var w = SE.processes.byName("Maps").windows();
    mapsWindows = String(w.length);
  } catch (e) { mapsWindows = "denied: " + (e.message || e); }
  return JSON.stringify({ trusted: trusted, systemEvents: systemEvents, mapsWindows: mapsWindows });
}
`;

/**
 * The menu bar, one level of submenu deep.
 *
 * Titles are filtered INSIDE the script rather than after it returns, so a guide
 * name never crosses the process boundary at all. Only counts and matching
 * titles come back.
 */
const MENUS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var re = new RegExp(p.verbs, "i");
  var SE = Application("System Events");
  try {
    var proc = SE.processes.byName("Maps");
    var bar = proc.menuBars[0];
    var names = bar.menuBarItems.name();
    var menus = [];
    for (var i = 0; i < names.length; i++) {
      var entry = { name: names[i], items: 0, matches: [], submenus: 0 };
      try {
        var items = bar.menuBarItems[i].menus[0].menuItems;
        var titles = items.name();
        entry.items = titles.length;
        for (var j = 0; j < titles.length; j++) {
          var t = titles[j];
          if (t && re.test(t)) {
            var actions = [];
            try { actions = items[j].actions.name(); } catch (e) { actions = ["?"]; }
            var enabled = "?";
            try { enabled = String(items[j].enabled()); } catch (e) {}
            entry.matches.push({ title: t, actions: actions, enabled: enabled });
          }
          // A submenu is where "Add to Guide >" would hide its guide list.
          try { if (items[j].menus.length > 0) entry.submenus += 1; } catch (e) {}
        }
      } catch (e) { entry.error = String(e.message || e).slice(0, 120); }
      menus.push(entry);
    }
    return JSON.stringify({ ok: true, menus: menus });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e.message || e).slice(0, 200) });
  }
}
`;

/**
 * Everything PRESSABLE in every window — found by ACTION, not by role.
 *
 * Filtering on `AXButton` was the second flaw in this file, and the same class
 * as the first. Maps is a Catalyst app, and Catalyst bridges UIKit views into an
 * AX tree that routinely reports a tappable control as `AXGroup`, `AXImage` or
 * `AXStaticText` with an `AXPress` action attached. A role filter cannot see
 * those, and its zero would be a fact about the filter rather than about Maps —
 * 15 "actionable" elements in a 236-element window is what that looks like from
 * outside. So the question is what has `AXPress`, which is the only property
 * that makes an element clickable whatever it calls itself.
 *
 * Every window, not the front one, for the same reason in a different place: a
 * place card's overflow control opens a POPOVER, and AppKit models a popover as
 * its own AXWindow. A walk of `windows[0]` would miss precisely the surface an
 * "Add to Favourites" item is most likely to live on, and report zero with total
 * confidence.
 *
 * It also asks the question that decides whether such a lane could ever be
 * RELIABLE: how many pressable elements carry no name. Anonymous controls can
 * only be addressed by position, and a write verb built on position breaks on
 * every layout change and every macOS release. Many unnamed pressables is a
 * worse answer than none at all.
 *
 * `entireContents` is one round trip for the whole tree — the escape
 * `spike-maps-ax.mjs` measured at 180 ms against 31.5 ms PER ELEMENT for
 * anything else.
 */
const CONTROLS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var re = new RegExp(p.verbs, "i");
  var SE = Application("System Events");
  try {
    var proc = SE.processes.byName("Maps");
    var wins = proc.windows();
    if (!wins.length) return JSON.stringify({ ok: false, reason: "no window" });
    var total = 0, pressable = 0, named = 0, anonymous = 0;
    var matches = [], scanned = [], roles = {};
    for (var w = 0; w < wins.length; w++) {
      var all = [];
      try { all = wins[w].entireContents(); } catch (e) { continue; }
      // The window TITLE is user data — Maps names its window after wherever the
      // map is centred, so printing it publishes a place the user was looking
      // at. Windows are numbered instead. Caught only because a run printed a
      // real town.
      var wname = "window " + (w + 1);
      scanned.push({ window: wname, elements: all.length });
      total += all.length;
      for (var i = 0; i < all.length; i++) {
        var actions = [];
        try { actions = all[i].actions.name(); } catch (e) { continue; }
        if (!actions || actions.indexOf("AXPress") < 0) continue;
        pressable += 1;
        var role = "?";
        try { role = all[i].role(); } catch (e) {}
        roles[role] = (roles[role] || 0) + 1;
        var title = "";
        try { title = all[i].name() || ""; } catch (e) {}
        try { if (!title) title = all[i].description() || ""; } catch (e) {}
        try { if (!title) title = all[i].help() || ""; } catch (e) {}
        if (title) { named += 1; } else { anonymous += 1; }
        if (title && re.test(title)) {
          matches.push({ role: role, title: title, actions: actions, window: wname });
        }
      }
    }
    return JSON.stringify({
      ok: true, total: total, pressable: pressable, named: named,
      anonymous: anonymous, roles: roles, matches: matches,
      windows: wins.length, scanned: scanned
    });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e.message || e).slice(0, 200) });
  }
}
`;

const report = { macos: macosVersion() };

// ── 0. the instrument ────────────────────────────────────────────────────────
head(0, "Is this process trusted, and is Maps there?");

const mapsUp = isRunning("com.apple.Maps");
const trust = safe(
  () => osascript(TRUST, {}, 30_000),
  (err) => ({ trusted: "error", systemEvents: String(err?.message ?? err).slice(0, 160) }),
);
say(`  Maps running          ${yn(mapsUp)}`);
say(`  AXIsProcessTrusted    ${trust.trusted}`);
say(`  System Events         ${trust.systemEvents}`);
say(`  Maps windows visible  ${trust.mapsWindows}`);
report.trust = { ...trust, mapsRunning: mapsUp };

say();
say("  THIS SAYS NOTHING ABOUT THE HOSTED CASE. The grant being tested is this");
say("  TERMINAL's. spike-app-tcc records that an osascript grandchild of");
say("  Cupertino.app is denied while the app itself is granted — the same defect");
say("  behind apple_mail_reply_to_message failing on a green Accessibility row.");

if (!mapsUp) {
  say();
  say("  Maps is not running. Open it, select a place, and re-run — an empty");
  say("  answer here would read as 'no control exists', which is a different");
  say("  finding from 'nothing was on screen to look at'.");
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(3);
}

// ── 1. the menu bar ──────────────────────────────────────────────────────────
head(1, "The menu bar — the stable place a write verb could live");

const t0 = performance.now();
const menus = safe(
  () => osascript(MENUS, { verbs: VERBS }, 60_000),
  (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
);
const menuMs = Math.round(performance.now() - t0);

if (!menus.ok) {
  say(`  could not read the menu bar: ${menus.reason}`);
} else {
  let hits = 0;
  for (const m of menus.menus ?? []) {
    const note = m.error ? ` (${m.error})` : "";
    say(
      `  ${String(m.name).padEnd(14)} ${String(m.items).padStart(3)} items, ` +
        `${m.submenus} submenu(s), ${m.matches.length} matching${note}`,
    );
    for (const hit of m.matches) {
      hits += 1;
      say(`      "${hit.title}"  enabled=${hit.enabled}  actions=${hit.actions.join("/")}`);
    }
  }
  say();
  say(
    hits > 0
      ? `  ${hits} menu item(s) look like a write verb.`
      : "  NO menu item matches a write verb. If question 2 is also empty, the",
  );
  if (hits === 0) say("  lane is closed on evidence rather than on assertion.");
}
report.menus = menus;
report.menuMs = menuMs;

// ── 2. the front window ──────────────────────────────────────────────────────
head(2, "Every window — buttons and menu items on the place card");

const t1 = performance.now();
const controls = safe(
  () => osascript(CONTROLS, { verbs: VERBS }, 120_000),
  (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
);
const controlMs = Math.round(performance.now() - t1);

if (!controls.ok) {
  say(`  could not read the window: ${controls.reason}`);
} else {
  say(`  ${controls.windows} window(s), ${controls.total} elements`);
  for (const w of controls.scanned ?? []) say(`      ${w.window} — ${w.elements} elements`);
  say();
  say(`  pressable (has AXPress)  ${controls.pressable}`);
  say(`    with a name            ${controls.named}`);
  say(`    ANONYMOUS              ${controls.anonymous}`);
  const roleHist = Object.entries(controls.roles ?? {}).toSorted((a, b) => b[1] - a[1]);
  if (roleHist.length) say(`  roles: ${roleHist.map(([r, n]) => `${r}=${n}`).join("  ")}`);
  say();
  say(`  ${controls.matches.length} whose title looks like a write verb:`);
  for (const m of controls.matches) {
    say(`      ${m.role.padEnd(14)} "${m.title}"  actions=${m.actions.join("/")}  [${m.window}]`);
  }
  if (controls.matches.length === 0) {
    say();
    say("  None. Only conclusive if a PLACE WAS SELECTED — an add-to-favourites");
    say("  control does not exist until there is something to add. And if it lives");
    say("  behind an overflow button, open that first: a popover is its own window");
    say("  and only exists in the tree while it is showing.");
  }
}
report.controls = controls;
report.controlMs = controlMs;

// ── 3. cost ──────────────────────────────────────────────────────────────────
head(3, "Cost");
say(`  menu bar walk         ${menuMs} ms`);
say(`  window enumeration    ${controlMs} ms`);
say();
say("  For comparison, spike-maps-ax.mjs measured 31.5 ms per AX round trip and");
say("  ~13 s to read the saved-places sidebar. A write is a handful of trips, not");
say("  a walk of the whole tree, so cost is not the thing that decides this lane.");

// ── verdict ──────────────────────────────────────────────────────────────────
const menuHits = (menus.menus ?? []).reduce((n, m) => n + (m.matches?.length ?? 0), 0);
const controlHits = controls.matches?.length ?? 0;
head(4, "So is there anything to win?");
if (menuHits + controlHits === 0) {
  say("  NOTHING FOUND. Neither the menu bar nor the front window exposes a");
  say("  control that looks like it adds a place. Re-run with a place selected");
  say("  before concluding — then the AX lane is closed on evidence.");
} else {
  say(`  ${menuHits} menu item(s) and ${controlHits} button(s) are candidates.`);
  say();
  say("  That makes the app's Accessibility defect worth fixing rather than");
  say("  merely worth knowing about: it gates this lane AND Mail's reply verb.");
  say("  Next step is spike-app-tcc, not more spelunking here — pressing one of");
  say("  these from a terminal proves nothing about a hosted server.");
}

say();
say(`macOS ${report.macos} · nothing was pressed`);
if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
