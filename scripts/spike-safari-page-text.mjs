#!/usr/bin/env node
// Spike: can a Safari tab's TEXT be read, and at what price?
//
// ── THE QUESTION ────────────────────────────────────────────────────────────
//
// `packages/safari` ships six read tools and cannot see a single word of any
// page. `apple_safari_get_page` is a history-row lookup despite its name; the
// live lane reads URLs and titles and stops there. The verb that would close
// the gap — `do JavaScript` — is deliberately not shipped, because it needs
// "Allow JavaScript from Apple Events", a Safari developer-menu toggle that is
// not a TCC grant, whose own state is unreadable, and which
// `apps/apple/Cupertino/Permissions.swift` has no way to model. Shipping a verb
// behind an unmodellable permission means diagnostics reports a healthy surface
// whose best capability silently fails. See `docs/safari.md`.
//
// So the question is not "should we ship do JavaScript". It is: **is there a
// route to page text that does not need that toggle, and is it affordable?**
//
// ── WHY THIS IS A SPIKE AND NOT A BRANCH ────────────────────────────────────
//
// The repo has already rejected an Accessibility READ lane once. `docs/surfaces.md`
// records the Maps measurement: ~206 elements x 2 properties x 33.6 ms per Apple
// Event round trip = **~14 s**, with no bulk fetch available in either JXA or
// AppleScript. A web page's accessibility tree is routinely one to two orders of
// magnitude larger than a sidebar, so the naive answer here is "far too slow".
//
// But `packages/mail` already reads attributes INSIDE a WebKit `AXWebArea` —
// `findBodyArea` in `src/client/jxa/core.ts` hunts one down and reads
// `AXBlockQuoteLevel` off its descendants. That precedent is why this is worth
// a measurement rather than an assumption. Mail only ever touches a handful of
// nodes, so this repo has never paid the cost of WALKING a web area.
//
// Everything therefore turns on one fact nobody here has measured:
//
//   **Does an AXWebArea expose an AGGREGATE text attribute?**
//
// If it does, page text is ONE round trip and the lane is cheap — a follow-up
// plan. If it does not, page text is a walk of the whole tree, which is exactly
// the case already rejected for Maps, and the measurement is the deliverable.
//
// Attributes are ENUMERATED rather than guessed, the way
// `spike-maps-ax-state.mjs` does it. Guessing `AXValue` and finding it empty
// would prove nothing about the attributes nobody thought to name.
//
// ── THE THREE LANES ─────────────────────────────────────────────────────────
//
//   A  Accessibility     System Events -> Safari -> front window -> AXWebArea.
//                        Needs Accessibility + Automation to System Events.
//                        NOT Automation to Safari: System Events does the
//                        reading, which is the routing detail commit ad79b4a
//                        established for Maps.
//   B  do JavaScript     Attempted ONCE, to characterise the error. This is the
//                        one place it is allowed to appear — `test/jxa.test.ts`
//                        scans the package, not this directory, and
//                        `docs/safari.md` already draws that line: "the probe
//                        attempts it deliberately, the SERVER must not."
//   C  network fetch     Fetch the tab's URL and compare text length against
//                        lane A, to quantify what a fetch LOSES on a page that
//                        is logged in or rendered client-side. A fetch is not
//                        "your tab" and this is how much that matters.
//
// Each lane reports independently: one failing must not cost the others.
//
// ── PRIVACY ─────────────────────────────────────────────────────────────────
//
// This reads whatever page is in front, which is somebody's actual browsing. So
// it prints LENGTHS, COUNTS and ATTRIBUTE NAMES — never page text, and never a
// bare URL. The single exception is a short, clearly-flagged sample used to
// verify the lanes read the same document, and `--no-sample` removes even that.
// The equivalent mistake was made once already in this directory.
//
// THIS SPIKE READS ONLY. It navigates nothing and presses nothing.
//
//   node scripts/spike-safari-page-text.mjs
//   node scripts/spike-safari-page-text.mjs --no-sample --max-nodes=500

import { isRunning, macosVersion, maskUrl, osascript, parseArgs, safe } from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const SAMPLE = !args.has("--no-sample");
// A cap, because an uncapped walk of a large page is how this spike hangs
// instead of reporting. Hitting the cap IS a result: it means the tree is
// bigger than a bounded read can finish.
const MAX_NODES = Number(args.valueOf("max-nodes", 1500));
const BUDGET_MS = Number(args.valueOf("budget-ms", 20_000));

const line = (k, v) => console.log(`  ${String(k).padEnd(26)} ${v}`);
const head = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ── Lane A ──────────────────────────────────────────────────────────────────
//
// Two phases on purpose. Phase 1 finds the web area and lists what it HAS,
// which is the cheap question that decides everything. Phase 2 only walks if
// phase 1 found no aggregate, because the walk is the expensive thing being
// measured.
const AX_FIND = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var SE = Application("System Events");

  var proc;
  try { proc = SE.processes.byName("Safari"); proc.name(); }
  catch (e) {
    return JSON.stringify({ ok: false, stage: "process", error: String(e.message || e) });
  }

  var win;
  try { win = proc.windows()[0]; if (!win) throw new Error("no windows"); }
  catch (e) {
    return JSON.stringify({ ok: false, stage: "window", error: String(e.message || e) });
  }

  // Depth-first for the web area, the shape packages/mail/src/client/jxa/core.ts
  // already uses. Safari nests it deeper than Mail's composer does, hence the
  // larger depth bound.
  function findWebArea(el, depth) {
    if (depth > 12) return null;
    var kids;
    try { kids = el.uiElements(); } catch (e) { return null; }
    for (var i = 0; i < kids.length; i++) {
      try { if (kids[i].role() === "AXWebArea") return kids[i]; } catch (e) {}
      var found = findWebArea(kids[i], depth + 1);
      if (found) return found;
    }
    return null;
  }

  var started = Date.now();
  var area = findWebArea(win, 0);
  var findMs = Date.now() - started;
  if (!area) {
    return JSON.stringify({ ok: false, stage: "webArea", findMs: findMs,
      error: "no AXWebArea under the front window" });
  }

  // ENUMERATE, never guess. The attribute that carries page text may well not
  // be one anybody would have thought to name.
  var names = [];
  try { names = area.attributes.name(); } catch (e) {}

  // For each attribute, its LENGTH only — this is somebody's real page.
  var sizes = [];
  for (var a = 0; a < names.length; a++) {
    var len = null, type = null;
    try {
      var v = area.attributes.byName(names[a]).value();
      type = typeof v;
      len = (v === null || v === undefined) ? 0 : String(v).length;
    } catch (e) {}
    sizes.push({ name: String(names[a]), type: type, length: len });
  }

  var sample = null;
  if (p.sample) {
    // Deliberately tiny, and only to confirm the lanes read one document.
    for (var b = 0; b < sizes.length; b++) {
      if (sizes[b].length > 200 && sizes[b].name !== "AXURL") {
        try { sample = String(area.attributes.byName(sizes[b].name).value()).slice(0, 120); }
        catch (e) {}
        break;
      }
    }
  }

  return JSON.stringify({ ok: true, findMs: findMs, attributes: sizes, sample: sample });
}
`;

// Phase 2. Only run when no aggregate attribute turned up.
const AX_WALK = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var SE = Application("System Events");

  function findWebArea(el, depth) {
    if (depth > 12) return null;
    var kids;
    try { kids = el.uiElements(); } catch (e) { return null; }
    for (var i = 0; i < kids.length; i++) {
      try { if (kids[i].role() === "AXWebArea") return kids[i]; } catch (e) {}
      var found = findWebArea(kids[i], depth + 1);
      if (found) return found;
    }
    return null;
  }

  var area;
  try { area = findWebArea(SE.processes.byName("Safari").windows()[0], 0); }
  catch (e) { return JSON.stringify({ ok: false, error: String(e.message || e) }); }
  if (!area) return JSON.stringify({ ok: false, error: "no AXWebArea" });

  // The Maps comparison: does entireContents() batch, or is it a round trip per
  // node? If it batches, the whole objection to this lane evaporates.
  var started = Date.now();
  var all = null, bulkError = null;
  try { all = area.entireContents(); } catch (e) { bulkError = String(e.message || e); }
  var bulkMs = Date.now() - started;

  if (all === null) {
    return JSON.stringify({ ok: true, bulk: false, bulkMs: bulkMs, bulkError: bulkError });
  }

  // Read text off capped nodes, timing as we go, and stop on either bound.
  // Hitting a bound is a finding, not a failure.
  var total = all.length;
  var chars = 0, read = 0, cappedBy = null;
  var t0 = Date.now();
  for (var i = 0; i < total; i++) {
    if (read >= p.maxNodes) { cappedBy = "nodes"; break; }
    if (Date.now() - t0 > p.budgetMs) { cappedBy = "time"; break; }
    try {
      var v = all[i].value();
      if (v !== null && v !== undefined) chars += String(v).length;
    } catch (e) {}
    read++;
  }
  var walkMs = Date.now() - t0;

  return JSON.stringify({
    ok: true, bulk: true, bulkMs: bulkMs, totalNodes: total,
    nodesRead: read, chars: chars, walkMs: walkMs, cappedBy: cappedBy
  });
}
`;

// The tab URL, for lane C. Safari's own dictionary, no System Events.
const FRONT_URL = `
function run(argv) {
  var S = Application("Safari");
  try {
    var w = S.windows()[0];
    return JSON.stringify({ ok: true, url: String(w.currentTab().url()), title: String(w.currentTab().name()) });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
}
`;

// ── Lane B ──────────────────────────────────────────────────────────────────
//
// The forbidden verb, attempted exactly once so its failure has a NAME. A
// server that shipped this would fail this way in front of a user.
const DO_JS = `
function run(argv) {
  var S = Application("Safari");
  try {
    var w = S.windows()[0];
    var out = S.doJavaScript("document.documentElement.outerHTML.length", { in: w.currentTab() });
    return JSON.stringify({ ok: true, length: Number(out) });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: String(e.message || e),
      code: (e.errorNumber === undefined ? null : e.errorNumber)
    });
  }
}
`;

console.log(`Safari page-text spike — macOS ${macosVersion()}`);
console.log("Reads only. Navigates nothing, presses nothing, prints no page text.");

if (!isRunning("com.apple.Safari")) {
  console.log("\nSafari is not running. Open it on a page and re-run.");
  process.exit(0);
}

// ── Lane A ──────────────────────────────────────────────────────────────────
head("Lane A — Accessibility (System Events -> AXWebArea)");
const find = safe(
  () => osascript(AX_FIND, { sample: SAMPLE }),
  (e) => ({
    ok: false,
    stage: "osascript",
    error: String(e?.message ?? e).slice(0, 300),
  }),
);

let aggregate = null;
let laneAChars = null;

if (!find.ok) {
  line("result", `failed at ${find.stage}`);
  line("error", find.error);
  if (find.stage === "process" || find.stage === "osascript") {
    console.log(
      "\n  This is the grant, not the design. Needs Accessibility AND Automation to\n" +
        "  System Events. If Accessibility looks granted but this still fails, check for\n" +
        "  duplicate TCC rows: `tccutil reset Accessibility io.mgcrea.cupertino`, then\n" +
        "  grant ONCE from the running bundle. See commit ad79b4a.",
    );
  }
} else {
  line("web area found in", `${find.findMs} ms`);
  line("attributes", find.attributes.length);
  console.log();
  for (const a of find.attributes) {
    line(`  ${a.name}`, `${a.type ?? "unreadable"}, ${a.length === null ? "?" : a.length} chars`);
  }

  // THE decision. An attribute holding a page's worth of characters means one
  // round trip; the threshold is deliberately low so a short page still counts.
  aggregate = find.attributes
    .filter((a) => a.name !== "AXURL" && (a.length ?? 0) > 500)
    .toSorted((x, y) => (y.length ?? 0) - (x.length ?? 0))[0];

  console.log();
  if (aggregate) {
    laneAChars = aggregate.length;
    line("AGGREGATE FOUND", `${aggregate.name} (${aggregate.length} chars)`);
    console.log(
      "\n  Page text is ONE round trip. The ~14 s Maps objection does not apply, and a\n" +
        "  read tool on this lane is worth a follow-up plan.",
    );
  } else {
    line("AGGREGATE FOUND", "no");
    console.log("\n  No single attribute carries the page. Measuring the walk instead…\n");
    const walk = safe(
      () => osascript(AX_WALK, { maxNodes: MAX_NODES, budgetMs: BUDGET_MS }),
      (e) => ({
        ok: false,
        error: String(e?.message ?? e).slice(0, 300),
      }),
    );
    if (!walk.ok) {
      line("walk", `failed: ${walk.error}`);
    } else if (!walk.bulk) {
      line("entireContents()", `unavailable after ${walk.bulkMs} ms`);
      line("error", walk.bulkError);
    } else {
      laneAChars = walk.chars;
      line("entireContents()", `${walk.totalNodes} nodes in ${walk.bulkMs} ms`);
      line(
        "nodes read",
        `${walk.nodesRead}${walk.cappedBy ? ` (capped by ${walk.cappedBy})` : ""}`,
      );
      line("walk", `${walk.walkMs} ms`);
      line("per node", `${(walk.walkMs / Math.max(1, walk.nodesRead)).toFixed(1)} ms`);
      line("text recovered", `${walk.chars} chars`);
      const projected = (walk.walkMs / Math.max(1, walk.nodesRead)) * walk.totalNodes;
      line("projected full page", `${(projected / 1000).toFixed(1)} s`);
      console.log(
        `\n  Compare Maps: ~14 s for 206 elements (docs/surfaces.md). A projection above\n` +
          `  a few seconds means this lane is rejected for reading on the same grounds.`,
      );
    }
  }

  if (find.sample) {
    console.log(`\n  sample (120 chars, --no-sample to suppress): ${JSON.stringify(find.sample)}`);
  }
}

// ── Lane B ──────────────────────────────────────────────────────────────────
head("Lane B — do JavaScript (characterising the refusal)");
const js = safe(
  () => osascript(DO_JS, {}),
  (e) => ({
    ok: false,
    error: String(e?.message ?? e).slice(0, 300),
    code: null,
  }),
);
if (js.ok) {
  line("result", `SUCCEEDED — outerHTML is ${js.length} chars`);
  console.log(
    "\n  So the toggle is ON for this Mac. That does NOT make the verb shippable: its\n" +
      "  state is still unreadable, so a server cannot tell a user why it failed on a\n" +
      "  Mac where it is off. This is the measurement, not a recommendation.",
  );
} else {
  line("result", "refused, as expected");
  line("code", js.code ?? "none reported");
  line("error", js.error);
  console.log(
    "\n  This is the failure a shipped `do JavaScript` tool would show a user, with no\n" +
      "  way for diagnostics to have predicted it.",
  );
}

// ── Lane C ──────────────────────────────────────────────────────────────────
head("Lane C — network fetch (what a fetch loses)");
const front = safe(
  () => osascript(FRONT_URL, {}),
  (e) => ({
    ok: false,
    error: String(e?.message ?? e).slice(0, 300),
  }),
);

if (!front.ok) {
  line("front tab", `unreadable: ${front.error}`);
} else {
  line("front tab", maskUrl(front.url));
  try {
    const res = await fetch(front.url, { redirect: "follow" });
    const body = await res.text();
    const text = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    line("status", res.status);
    line("html", `${body.length} chars`);
    line("text after strip", `${text.length} chars`);
    if (laneAChars !== null) {
      const ratio = text.length / Math.max(1, laneAChars);
      line("vs lane A", `${(ratio * 100).toFixed(0)}% of what Accessibility saw`);
      console.log(
        ratio < 0.5
          ? "\n  The fetch sees substantially LESS. That is the logged-in or client-rendered\n" +
              "  gap, and it is the argument that a fetch is not a substitute for the tab."
          : "\n  Comparable on THIS page. A static public page is the easy case; re-run on a\n" +
              "  logged-in or app-like page before concluding a fetch is good enough.",
      );
    }
  } catch (err) {
    line("fetch", `failed: ${String(err?.message ?? err).slice(0, 160)}`);
    console.log(
      "\n  A fetch failing where the tab renders fine is itself the finding: the page\n" +
        "  needs the session the browser has and this process does not.",
    );
  }
}

head("Verdict");
console.log(
  aggregate
    ? `  Lane A found an aggregate attribute (${aggregate.name}). Page text is affordable.\n` +
        `  Next: a follow-up plan for a read tool, plus the permission-model bookkeeping —\n` +
        `  surfaces.json has no Accessibility lane and docs/surfaces.md already records the\n` +
        `  Settings pane owing two states it does not model. This would make three.`
    : `  No aggregate attribute, so page text costs a tree walk. Record the numbers above\n` +
        `  in docs/safari.md next to the Maps ~14 s figure and leave the surface as it is.`,
);
console.log("\nNothing was written. No tool, type, or permission changed.");
