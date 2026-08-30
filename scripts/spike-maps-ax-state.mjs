#!/usr/bin/env node
// Spike: can the Favorite control's STATE be read before pressing it?
//
// ── THE QUESTION THAT DECIDES THE WRITE DESIGN ──────────────────────────────
//
// `scripts/spike-maps-ax-write.mjs` found the lane: with a place card open, Maps
// exposes `AXButton "Favorite"` and `AXButton "Add"`, both pressable, in a tree
// where 219 of 236 pressable elements carry names. That says a write is
// possible. It does not say a write is SAFE.
//
// `Favorite` is almost certainly a TOGGLE. If it is, then pressing it on a place
// that is already a favourite REMOVES the favourite — so a tool called
// `add_to_favorites` that presses blind would silently delete saved places on
// exactly the inputs a caller is most likely to retry with. Deleting somebody's
// saved doctor because a model called the same tool twice is the worst outcome
// this surface could produce, and it is entirely preventable.
//
// A write verb here is therefore only honest if the control's state can be read
// FIRST. That is what this measures, and it presses nothing to do it.
//
// ── HOW IT ANSWERS ──────────────────────────────────────────────────────────
//
// Open one place that IS already a favourite and one that is NOT, dump every
// attribute of the matching controls, and diff them by eye. Whatever differs is
// the state bit. Candidates, in the order they are worth hoping for:
//
//   * `AXValue` — 0/1 on a toggle button, the cleanest possible answer.
//   * the TITLE changing (`Favorite` vs `Remove Favorite`) — also fine, though
//     it is localised, and this Mac runs English.
//   * `AXDescription` or `AXHelp` differing.
//   * nothing differing at all — which is a real possible outcome and would
//     mean the state must come from the FILE LANE instead: look the place up by
//     coordinate in `ZFAVORITEITEM` before deciding whether to press. Slower,
//     but this surface already reads that store in 0 ms, so it is not a problem.
//
// The last case is why this spike is worth running rather than reasoning about:
// it is the one where the obvious design silently corrupts data.
//
// ── HOW A PLACE IS PUT ON SCREEN ────────────────────────────────────────────
//
// `maps://?ll=<lat>,<lon>` — a URL scheme, not an Apple Event, needing no grant
// and no scripting dictionary. It is how `spike-maps-ax-write.mjs` staged its
// measurement without anybody clicking, and it is step 2 of the write design in
// `docs/maps.md`: file lane names the place, URL scheme shows it, AX presses.
//
// Coordinates come from the caller so that no place data is hardcoded here.
//
// PRIVACY. Attribute VALUES are dumped for matched controls only, truncated, and
// the window title is never read — Maps names its window after wherever the map
// is centred, which publishes a place the user was looking at. That mistake was
// made once already in this directory.
//
// THIS SPIKE PRESSES NOTHING.
//
//   node scripts/spike-maps-ax-state.mjs --place=25.9853,-97.1873   # a favourite
//   node scripts/spike-maps-ax-state.mjs --place=48.8584,2.2945     # not one

import { execFileSync } from "node:child_process";

import { isRunning, macosVersion, osascript, parseArgs, safe, yn } from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const place = args.valueOf("place", "");
/**
 * `--q=` exists because `--place=` turned out NOT to open a place card.
 * MEASURED: `maps://?ll=<lat>,<lon>` centres the map (446 elements, no controls)
 * and `maps://?q=<lat>,<lon>` is no better (389, none), while
 * `maps://?q=<name>` opens a real card (461 elements, `Favorite` present). So a
 * coordinate positions the map and a NAME selects a place, which is a problem
 * for the write design: the file lane's strongest identifier is a coordinate.
 */
const query = args.valueOf("q", "");
const MATCH = "favou?rite|^add$|pin";

const say = (l = "") => console.log(l);

/** `--url=` passes a URL through verbatim, to test scheme variants. */
const rawUrl = args.valueOf("url", "");
const target = query || place;
if (!target && !rawUrl) {
  say("Give a target: --place=<lat>,<lon> or --q=<name>");
  say("Run it twice — once on a place that IS a favourite, once on one that is not.");
  say("The difference between the two dumps is the state bit, or there isn't one.");
  process.exit(2);
}

/**
 * Every attribute of every control whose name looks like the favourite verb.
 *
 * Attribute NAMES are read from the element rather than guessed, because the
 * whole point is to find a state bit whose name is not known in advance. A
 * guessed list of attributes is the same mistake as a guessed list of column
 * names, which this repo has now made four times on this store.
 */
const DUMP = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var re = new RegExp(p.match, "i");
  var SE = Application("System Events");
  try {
    var proc = SE.processes.byName("Maps");
    var wins = proc.windows();
    if (!wins.length) return JSON.stringify({ ok: false, reason: "no window" });
    var out = [], total = 0;
    for (var w = 0; w < wins.length; w++) {
      var all = [];
      try { all = wins[w].entireContents(); } catch (e) { continue; }
      total += all.length;
      for (var i = 0; i < all.length; i++) {
        var title = "";
        try { title = all[i].name() || ""; } catch (e) {}
        try { if (!title) title = all[i].description() || ""; } catch (e) {}
        if (!title || !re.test(title)) continue;
        var entry = { title: title, attrs: {} };
        try { entry.role = all[i].role(); } catch (e) {}
        try { entry.actions = all[i].actions.name(); } catch (e) {}
        var names = [];
        try { names = all[i].attributes.name(); } catch (e) {}
        for (var a = 0; a < names.length; a++) {
          // AXChildren and friends are huge and say nothing about state.
          if (/Children|Parent|Window|TopLevel|Frame|Position|Size/.test(names[a])) continue;
          var v = "";
          try { v = String(all[i].attributes.byName(names[a]).value()); } catch (e) { v = "<unreadable>"; }
          entry.attrs[names[a]] = v.length > 60 ? v.slice(0, 60) + "…" : v;
        }
        out.push(entry);
      }
    }
    return JSON.stringify({ ok: true, total: total, controls: out });
  } catch (e) {
    return JSON.stringify({ ok: false, reason: String(e.message || e).slice(0, 200) });
  }
}
`;

/** Poll until the tree stops growing, rather than sleeping a guessed interval. */
const SIZE = `
function run() {
  var SE = Application("System Events");
  try {
    var wins = SE.processes.byName("Maps").windows();
    if (!wins.length) return "0";
    return String(wins[0].entireContents().length);
  } catch (e) { return "0"; }
}
`;

say(`Maps running   ${yn(isRunning("com.apple.Maps"))}`);
const url = rawUrl || `maps://?q=${target}`;
say(`Opening        ${url}`);
safe(
  () => execFileSync("/usr/bin/open", ["-g", url]),
  (e) => say(`  open failed: ${e.message}`),
);

// Settle: the card populates asynchronously, and reading too early reports a
// control set that is merely not rendered yet — a false negative dressed as a
// finding, which is the failure this directory keeps producing.
let last = -1;
let stable = 0;
for (let i = 0; i < 40 && stable < 3; i += 1) {
  const n = Number(
    safe(
      () => osascript(SIZE, {}, 20_000),
      () => "0",
    ),
  );
  stable = n === last && n > 0 ? stable + 1 : 0;
  last = n;
}
say(`Settled at     ${last} elements`);

const dump = safe(
  () => osascript(DUMP, { match: MATCH }, 120_000),
  (err) => ({ ok: false, reason: String(err?.message ?? err).slice(0, 200) }),
);

say();
if (!dump.ok) {
  say(`Could not read the window: ${dump.reason}`);
  process.exit(3);
}
if (!dump.controls.length) {
  say("No control matched. Either the card did not open, or the verb is named");
  say("something this pattern does not cover — widen MATCH before concluding.");
  process.exit(3);
}
for (const c of dump.controls) {
  say(`${c.role ?? "?"}  "${c.title}"`);
  say(`  actions: ${(c.actions ?? []).join("/")}`);
  for (const [k, v] of Object.entries(c.attrs).toSorted()) say(`  ${k.padEnd(24)} ${v}`);
  say();
}
say(`macOS ${macosVersion()} · nothing was pressed`);
say();
say("Run this again on a place with the OPPOSITE favourite status and diff the");
say("two outputs. An attribute that changes is the state bit; if none changes,");
say("state has to come from the file lane and the write design must say so.");
