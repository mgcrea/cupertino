#!/usr/bin/env node
// Probe: do the two Safari write verbs actually work, and what do they cost?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// `packages/safari` ships `apple_safari_open_url` and
// `apple_safari_add_reading_list_item`, and the JXA behind them was written on a
// machine with no Automation grant — reasoned from Safari's dictionary rather
// than observed against a real browser. That is the reverse of how every other
// lane in this repo landed, and `client/jxa/writes.ts` says so in its header.
// This is the instrument that closes the gap.
//
// It is unlike every other probe here in one way that matters: THIS ONE CHANGES
// THINGS. It opens tabs and adds a Reading List item to whoever's Safari is
// running. So it never runs anything by accident — every mutation is behind an
// explicit flag, and the default run only reads.
//
// ── WHAT THIS ANSWERS ────────────────────────────────────────────────────────
//
//   0. CAN THIS PROCESS SEND APPLE EVENTS TO SAFARI AT ALL? The instrument
//      check. A denied process must not report a verb as broken.
//   1. IS THE DICTIONARY WHAT THE SCRIPTS ASSUME? `add reading list item`, its
//      two optional parameters, and a WRITABLE `URL` property on `tab`. If any
//      of these moved in a macOS release, the scripts are wrong before they run.
//   2. WHICH ROUTE DOES A NEW TAB ACTUALLY TAKE? (--open) The one genuinely
//      uncertain idiom: `Safari.Tab({url}).push()` into a window's tab list.
//      Reports `route`, so "tab-push" versus "open-location-fallback" is
//      measured rather than hoped for. Also reports the round-trip cost.
//   3. DOES THE READING LIST ADD LAND, AND WHEN IS IT VISIBLE ON DISK? (--read-
//      ing-list) The whole design of the tool's `verified` field rests on
//      Bookmarks.plist lagging the add. This measures the lag: it polls the
//      file for up to 30 s and reports when the item appeared, or that it did
//      not. If it is instant, the tool can promise more than it currently does.
//   4. DOES A `javascript:` URL GET THROUGH? (--scheme-gate) The security
//      claim, tested against the real thing rather than against the regex. It
//      asks Safari to navigate to a harmless `javascript:` URL and reports
//      whether Safari accepted it, which is the reason the allowlist exists.
//
// PRIVACY. No URL, title or Reading List entry from the user's own browsing is
// ever printed. Q3 counts entries and looks for the ONE url this probe itself
// added; everything else about the file is reported as a count.
//
//   node scripts/probe-safari-write.mjs                  # Q0-Q1, reads only
//   node scripts/probe-safari-write.mjs --open           # Q2: opens two tabs
//   node scripts/probe-safari-write.mjs --reading-list   # Q3: adds one item
//   node scripts/probe-safari-write.mjs --scheme-gate    # Q4: harmless js: URL
//   node scripts/probe-safari-write.mjs --all --json

import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const wantAll = args.has("--all");
const asJson = args.has("--json");
const want = (flag) => wantAll || args.has(flag);

const SAFARI_APP = "/Applications/Safari.app";
const BOOKMARKS = `${process.env.HOME}/Library/Safari/Bookmarks.plist`;

/** A page that exists, is tiny, and belongs to nobody's account. */
const TARGET = "https://example.com/";
/** Unique per run, so Q3 can find its own item without reading anybody else's. */
const MARKER = `https://example.com/cupertino-probe-${Date.now()}`;

const out = {};
const log = (...parts) => {
  if (!asJson) console.log(...parts);
};

/** Run a JXA script the way the servers do: static text, params as argv[0]. */
const jxa = (script, params = {}) => {
  const started = Date.now();
  const stdout = execFileSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-", JSON.stringify(params)],
    {
      input: script,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { ms: Date.now() - started, value: JSON.parse(stdout) };
};

// ── Q0: the instrument ───────────────────────────────────────────────────────

log("\nQ0. Can this process drive Safari?");
try {
  const { value, ms } = jxa(`
    function run() {
      var S = Application("Safari");
      return JSON.stringify({ ok: true, data: { running: Boolean(S.running()) } });
    }
  `);
  out.canDriveSafari = true;
  out.safariRunning = value.data.running;
  log(`   yes — Safari is ${value.data.running ? "running" : "NOT running"} (${ms} ms)`);
  if (!value.data.running) {
    log("   NOTE: every verb below will LAUNCH Safari. That is the disclosure the tools make.");
  }
} catch (error) {
  out.canDriveSafari = false;
  out.error = String(error.message || error).slice(0, 300);
  log("   NO — this process cannot send Apple Events to Safari.");
  log("   Grant Automation for the terminal running this, then re-run. Nothing below is valid.");
  if (asJson) console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

// ── Q1: is the dictionary what the scripts assume? ───────────────────────────

log("\nQ1. Does Safari's dictionary still say what the scripts assume?");
{
  const sdef = execFileSync("/usr/bin/sdef", [SAFARI_APP], { encoding: "utf8" });
  const checks = {
    "add reading list item": sdef.includes('<command name="add reading list item"'),
    "with title": sdef.includes('name="with title"'),
    "and preview text": sdef.includes('name="and preview text"'),
    // The one that decides whether navigation works at all: a tab's URL must
    // NOT be access="r". Matching the property line and checking it is silent
    // about access is the same test the scripts depend on.
    "tab.URL is writable": /<property type="text" name="URL" code="pURL"(?![^>]*access="r")/.test(
      sdef,
    ),
    "do JavaScript still exists (and is still not used)": sdef.includes('name="do JavaScript"'),
    "dispatch message to extension": sdef.includes('name="dispatch message to extension"'),
  };
  out.dictionary = checks;
  for (const [what, held] of Object.entries(checks)) log(`   ${held ? "yes" : "NO "}  ${what}`);
}

// ── Q2: which route does a new tab take? ─────────────────────────────────────

if (want("--open")) {
  log("\nQ2. Opening a URL — which idiom actually places the tab?");
  const OPEN = readScript("OPEN_URL");
  for (const target of ["new-tab", "current-tab"]) {
    const { value, ms } = jxa(OPEN, { url: TARGET, target, activate: false });
    out.open ??= {};
    out.open[target] = { ...value, ms };
    if (value.ok) {
      log(
        `   ${target}: route=${value.data.route} in ${ms} ms` +
          (value.data.launchedSafari ? " (LAUNCHED Safari)" : ""),
      );
      if (String(value.data.route).startsWith("open-location")) {
        log("   ^ the precise idiom did NOT work. `jxa/writes.ts` should be corrected to match.");
      }
    } else {
      log(`   ${target}: FAILED — ${value.error.code}: ${value.error.message}`);
    }
  }
}

// ── Q3: does the Reading List add land, and when is it visible? ──────────────

if (want("--reading-list")) {
  log("\nQ3. Adding a Reading List item, and how long until Bookmarks.plist shows it.");
  const ADD = readScript("ADD_READING_LIST_ITEM");
  const { value, ms } = jxa(ADD, { url: MARKER, title: "Cupertino probe", previewText: undefined });
  out.readingList = { add: value, ms };
  if (!value.ok) {
    log(`   FAILED — ${value.error.code}: ${value.error.message}`);
  } else {
    log(`   added in ${ms} ms.`);
    log(`   REMOVE IT BY HAND: it is titled "Cupertino probe" in the Reading List.`);

    // THE INSTRUMENT CHECK, and the first version of this probe did not have
    // it. Without Full Disk Access every grep below returns EPERM, the poll
    // times out, and the run reports "not visible after 30 s" — which reads as
    // a measurement of Safari's write lag and is really a measurement of this
    // process's permissions. An absence must never be reported as data.
    let canRead = true;
    try {
      execFileSync("/usr/bin/grep", ["-q", "cupertino-probe-never-matches", BOOKMARKS]);
    } catch (error) {
      // grep exits 1 for "no match" and 2 for "cannot read". Only the second
      // says anything about the instrument.
      canRead = error.status === 1;
    }

    if (!canRead) {
      out.readingList.visibleAfterMs = null;
      out.readingList.lagUnmeasurable = "no Full Disk Access in this process";
      log("   LAG UNMEASURABLE from here: Bookmarks.plist is EPERM without Full Disk Access.");
      log("   Re-run from a process that holds it. This says nothing about whether the add");
      log("   landed — check the Reading List in Safari, where it should already be visible.");
    } else {
      log("   Polling the file for up to 30 s…");
      const started = Date.now();
      let sawIt = false;
      while (Date.now() - started < 30_000) {
        // grep the binary plist for the marker rather than parsing it: the only
        // question is whether THIS run's URL is in the file, and the marker is
        // unique. Nobody else's entry is read, matched or printed.
        try {
          execFileSync("/usr/bin/grep", ["-q", MARKER, BOOKMARKS]);
          sawIt = true;
          break;
        } catch {
          execFileSync("/bin/sleep", ["1"]);
        }
      }
      out.readingList.visibleAfterMs = sawIt ? Date.now() - started : null;
      log(
        sawIt
          ? `   visible on disk after ${Math.round((Date.now() - started) / 1000)} s.`
          : "   NOT visible after 30 s — which is the lag `verified: null` exists for.",
      );
    }
  }
}

// ── Q4: does a javascript: URL get through? ──────────────────────────────────

if (want("--scheme-gate")) {
  log("\nQ4. Would Safari accept a javascript: URL through the navigation verb?");
  log(
    "   (The servers refuse this before it is sent. This asks what would happen if they did not.)",
  );
  const { value } = jxa(
    `
    function run(argv) {
      var p = JSON.parse(argv[0]);
      var S = Application("Safari");
      try {
        var t = S.Tab({ url: p.url });
        S.windows[0].tabs.push(t);
        return JSON.stringify({ ok: true, data: { accepted: true } });
      } catch (e) {
        return JSON.stringify({ ok: true, data: { accepted: false, message: String(e.message || e) } });
      }
    }
  `,
    { url: "javascript:void(document.title)" },
  );
  out.schemeGate = value.data;
  log(
    value.data.accepted
      ? "   ACCEPTED. Safari took the javascript: URL, which is why the allowlist is the boundary."
      : `   refused by Safari itself: ${value.data.message}`,
  );
}

/**
 * Read a script constant out of the shipped source, so this probe can never
 * measure a copy that has drifted from what the server actually runs.
 */
function readScript(name) {
  const src = execFileSync(
    "/bin/cat",
    [new URL("../packages/safari/src/client/jxa/writes.ts", import.meta.url).pathname],
    { encoding: "utf8" },
  );
  const match = new RegExp(`export const ${name} = \`([\\s\\S]*?)\``).exec(src);
  if (!match) throw new Error(`${name} not found in packages/safari/src/client/jxa/writes.ts`);
  return match[1];
}

if (asJson) console.log(JSON.stringify(out, null, 2));
log("");
