#!/usr/bin/env node
// Spike: what does Safari's window actually expose to System Events?
//
// ── WHY THIS EXISTS SEPARATELY ──────────────────────────────────────────────
//
// `spike-safari-page-text.mjs` hunts for one role, `AXWebArea`, and reports
// whether it found it. On macOS 26.6 it does not — and "the role I looked for
// is absent" is a weak finding on its own. It cannot distinguish:
//
//   * the page is genuinely not in this tree, from
//   * the traversal is wrong — too shallow, or the role is spelled differently.
//
// A census answers both, because it names everything it finds instead of
// looking for one thing. That is the same discipline as enumerating an
// element's attributes rather than guessing `AXValue`, one level up.
//
// ── THE MEASURED RESULT (macOS 26.6, Safari, 2 windows) ─────────────────────
//
//   AXToolbar 1 · AXButton 3 · AXTextField 1 · AXImage 1 · AXStaticText 2
//   AXGroup 2 · max depth 3 · 10 elements total
//
// That is the CHROME and nothing else: the toolbar, its buttons, the address
// bar, and a couple of labels. No `AXWebArea`, no page content, and a tree that
// bottoms out at depth 3 — so the depth-12 bound in the other spike was never
// the limitation.
//
// The conclusion is structural rather than economic. Safari renders web content
// in a separate process and does not surface it down this path, so there is no
// tree to price. `docs/surfaces.md` rejected the Accessibility lane for Maps on
// COST (~14 s for 206 elements); this is a different verdict with the same
// outcome, and the distinction matters because a cost can be engineered around
// and an absence cannot.
//
// It also does not generalise from `packages/mail`, whose `findBodyArea` really
// does reach an `AXWebArea` — that composer is an in-process WebKit view.
//
// ── WHAT WOULD CHANGE THE ANSWER ────────────────────────────────────────────
//
// VoiceOver reads web pages, so the content IS in the accessibility API — just
// not through this door. WebKit builds that tree lazily for clients it treats
// as assistive, which some tools trigger by setting `AXManualAccessibility` or
// `AXEnhancedUserInterface` on the application element. That is unmeasured here
// and deliberately not attempted: it is an undocumented, app-specific
// activation, which is the same class of unmodellable dependency as the
// `do JavaScript` toggle this whole line of enquiry exists to avoid.
//
// Needs Accessibility and an Automation grant for System Events. Reads only.
//
//   node scripts/spike-safari-ax-census.mjs
//   node scripts/spike-safari-ax-census.mjs --app=Mail   # the contrasting case

import { isRunning, macosVersion, osascript, parseArgs, safe } from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const APP = args.valueOf("app", "Safari");
const MAX_DEPTH = Number(args.valueOf("depth", 8));
// Per level, so one enormous list cannot make the census itself the slow thing
// being reported on.
const FANOUT = Number(args.valueOf("fanout", 40));

// Roles only, never values. A census of what EXISTS says nothing about anybody's
// browsing; reading the text would.
const CENSUS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var SE = Application("System Events");

  var proc;
  try { proc = SE.processes.byName(p.app); proc.name(); }
  catch (e) {
    return JSON.stringify({ ok: false, stage: "process", error: String(e.message || e) });
  }

  var wins;
  try { wins = proc.windows(); }
  catch (e) {
    return JSON.stringify({ ok: false, stage: "windows", error: String(e.message || e) });
  }
  if (!wins.length) {
    return JSON.stringify({ ok: false, stage: "windows", error: "no windows visible" });
  }

  var roles = {};
  var maxDepth = 0;
  var total = 0;
  var truncated = false;

  function walk(el, d) {
    if (d > p.maxDepth) { truncated = true; return; }
    if (d > maxDepth) maxDepth = d;
    var kids;
    try { kids = el.uiElements(); } catch (e) { return; }
    if (kids.length > p.fanout) truncated = true;
    for (var i = 0; i < kids.length && i < p.fanout; i++) {
      var r = "?";
      try { r = String(kids[i].role()); } catch (e) {}
      roles[r] = (roles[r] || 0) + 1;
      total++;
      walk(kids[i], d + 1);
    }
  }

  var started = Date.now();
  walk(wins[0], 0);

  return JSON.stringify({
    ok: true, windows: wins.length, roles: roles,
    maxDepth: maxDepth, total: total, truncated: truncated,
    ms: Date.now() - started
  });
}
`;

const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

console.log(`Accessibility census — ${APP}, macOS ${macosVersion()}`);
console.log("Roles and counts only. No values are read, so no page text is printed.\n");

const bundles = { Safari: "com.apple.Safari", Mail: "com.apple.mail" };
if (bundles[APP] && !isRunning(bundles[APP])) {
  console.log(`${APP} is not running. Open it and re-run.`);
  process.exit(0);
}

const r = safe(
  () => osascript(CENSUS, { app: APP, maxDepth: MAX_DEPTH, fanout: FANOUT }),
  (e) => ({ ok: false, stage: "osascript", error: String(e?.message ?? e).slice(0, 300) }),
);

if (!r.ok) {
  line("failed at", r.stage);
  line("error", r.error);
  console.log(
    "\n  Needs Accessibility AND an Automation grant for System Events. If Accessibility\n" +
      "  looks granted but this still fails, check for duplicate TCC rows — see ad79b4a.",
  );
  process.exit(1);
}

line("windows", r.windows);
line("elements", `${r.total}${r.truncated ? " (bounded)" : ""}`);
line("max depth", r.maxDepth);
line("walked in", `${r.ms} ms`);
console.log();
for (const [role, n] of Object.entries(r.roles).toSorted((a, b) => b[1] - a[1])) {
  line(`  ${role}`, n);
}

const web = Object.keys(r.roles).filter((k) => /Web|Document/i.test(k));
console.log();
if (web.length) {
  line("WEB CONTENT", web.join(", "));
  console.log("\n  The page is in this tree. Price it with spike-safari-page-text.mjs.");
} else {
  line("WEB CONTENT", "none");
  console.log(
    `\n  Chrome only — no AXWebArea and no document role. The page is NOT in this tree,\n` +
      `  and at max depth ${r.maxDepth} the traversal bound was not the limitation. This is an\n` +
      `  ABSENCE, not a cost: nothing to walk, so nothing to make faster.`,
  );
}
