/**
 * The Apple Events lane as a WRITE, which on this surface is new.
 *
 * ## Why these two verbs and not the obvious third
 *
 * Safari's dictionary offers exactly one way to act *inside* a page —
 * `do JavaScript` — and this file deliberately does not use it. That verb needs
 * "Allow JavaScript from Apple Events", a Safari developer-menu toggle which is
 * not a TCC grant, whose own state is unreadable, and which is global,
 * permanent and unscoped: turning it on to click one button leaves every tab
 * scriptable forever. The extension lane exists precisely because Safari gates
 * it per website instead — see `CupertinoSafariExtension/Resources/content.js`.
 * `test/jxa.test.ts` asserts no script in this package contains `doJavaScript`,
 * and that assertion covers this file too.
 *
 * So what ships here is navigation, the Reading List, and closing a tab an
 * agent opened: the writes that move a browser between pages rather than
 * reaching into one.
 *
 * ## A `javascript:` URL is `do JavaScript` by another name
 *
 * The single most important line in this file is the scheme check. Navigating a
 * tab to `javascript:…` executes that script in the page's context — the exact
 * capability the paragraph above refuses, reachable through the front door and
 * without the toggle. `file:` is refused for the same shape of reason: it turns
 * a navigation verb into a local-file reader.
 *
 * The check is enforced in `safari.ts` before any Apple Event is sent AND again
 * in the script below. That duplication is deliberate. The TypeScript check is
 * the one that produces a good error message; the in-script one is the one that
 * still holds if some future caller reaches these scripts by another path.
 *
 * ## Measured after the fact, which is the reverse of how this package works
 *
 * Every other lane here was measured before it shipped. These two were written
 * from the dictionary on a machine with no Automation grant, then measured by
 * `scripts/probe-safari-write.mjs` against a live Safari on macOS 26.6:
 * `tab-push` in 166 ms, `current-tab` in 108 ms, the Reading List add in
 * 148 ms. The fallback below has never fired. It stays anyway — one run on one
 * machine is not a guarantee about a browser with no windows open, or one
 * mid-launch — and it REPORTS which route it took, so a future failure is
 * visible in the tool's own output rather than inferred.
 *
 * The measurement that mattered most was of the check above: Safari **accepts**
 * a `javascript:` URL pushed as a tab. The allowlist is not belt and braces.
 *
 * ## The contract
 *
 * Enforced by `assertStaticScript`: a static constant with no `${}` anywhere,
 * parameters via `JSON.parse(argv[0])`, results as `{ok, data}` /
 * `{ok: false, error}`, and the script always exits 0 — so a non-zero exit
 * always means infrastructure rather than "Safari has no windows open".
 */

/**
 * Open a URL, in a new tab or in the one the user is looking at.
 *
 * ## Safari gets launched, and that is reported rather than hidden
 *
 * Any command sent to a quit application launches it. For a navigation verb
 * that is the right behaviour — "open this page" on a closed browser means open
 * the browser — but it is a visible thing to do to somebody's machine, so
 * `launchedSafari` is measured BEFORE the first command and returned. `running`
 * is one of the few properties that does not itself launch the app.
 *
 * ## Two routes, because only one of them is certain
 *
 * `Safari.Tab({url}).push()` into a window's tab list is the idiom that gives a
 * new tab without disturbing the current one, and it is measured working —
 * 166 ms against a live Safari with one window and 22 tabs. It needs a window
 * to push into, which is the case the measurement did not cover, so when there
 * is none, or when the push throws, the script falls back to `open location` —
 * a Standard Suite verb that always works and is simply less precise about
 * where the page lands. `route` says which happened.
 */
export const OPEN_URL = `
function run(argv) {
  var p = JSON.parse(argv[0]);

  // The second half of the scheme check. See this file's header: a
  // javascript: URL executes in the page, which is the one capability this
  // lane refuses to offer. Never relax this to a blocklist.
  var lower = String(p.url || "").slice(0, 12).toLowerCase();
  if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) {
    return JSON.stringify({
      ok: false,
      error: { code: "BAD_SCHEME", message: "Only http:// and https:// URLs can be opened." }
    });
  }

  var S = Application("Safari");

  // Read BEFORE anything that could launch it, or the answer is always true.
  var wasRunning = null;
  try { wasRunning = Boolean(S.running()); } catch (e) {}

  var wins = [];
  try { wins = S.windows(); } catch (e) { wins = []; }

  var route = null;
  var windowId = null;
  var target = p.target === "current-tab" ? "current-tab" : "new-tab";

  try {
    if (target === "current-tab" && wins.length > 0) {
      wins[0].currentTab.url = p.url;
      route = "current-tab";
    } else if (wins.length > 0) {
      // Read before the push, from the window pushed into: the id is what the
      // record of opened tabs scopes this tab to.
      try { windowId = wins[0].id(); } catch (e) {}
      var t = S.Tab({ url: p.url });
      wins[0].tabs.push(t);
      // Selecting it is what makes "open a tab" mean what a person means by it.
      // Non-fatal: an unselected new tab is still an opened page.
      try { wins[0].currentTab = t; } catch (e) {}
      route = "tab-push";
    } else {
      S.openLocation(p.url);
      route = "open-location";
    }
  } catch (e) {
    // The precise idiom failed. The Standard Suite verb is the floor: it may
    // put the page somewhere else, and that is worth reporting, but losing the
    // navigation entirely would be worse.
    try {
      S.openLocation(p.url);
      route = "open-location-fallback";
    } catch (e2) {
      return JSON.stringify({
        ok: false,
        error: { code: "NO_ACCESS", message: String(e2.message || e2) }
      });
    }
  }

  if (p.activate) {
    try { S.activate(); } catch (e) {}
  }

  // Read the result back defensively. A page that has only just been asked for
  // may not have committed its URL yet, so every one of these can be absent
  // without the write having failed.
  var landedUrl = null, landedTitle = null, landedIndex = null, windows = null;
  try { windows = S.windows().length; } catch (e) {}
  try { landedUrl = String(S.windows[0].currentTab.url()); } catch (e) {}
  try { landedTitle = String(S.windows[0].currentTab.name()); } catch (e) {}
  try { landedIndex = S.windows[0].currentTab.index(); } catch (e) {}

  return JSON.stringify({
    ok: true,
    data: {
      route: route,
      launchedSafari: wasRunning === null ? null : !wasRunning,
      windows: windows,
      windowId: windowId,
      tab: { url: landedUrl, title: landedTitle, index: landedIndex }
    }
  });
}
`;

/**
 * Add an item to the Reading List.
 *
 * The one write on this surface that changes nothing on screen: no tab opens,
 * nothing moves, nothing comes to the front. That is what made it the first one
 * to build.
 *
 * It is NOT inert on the network, and the difference is worth stating because
 * the phrase "no page loads" stood here until it was measured false. Safari
 * fetches the URL — that is where the title and preview text below come from —
 * so this verb makes a request to whatever host the caller names, from the
 * user's browser, with the user's cookies. Adding a URL to somebody's Reading
 * List is a network action taken on their behalf.
 *
 * `with title` and `and preview text` are optional in the dictionary, and are
 * omitted rather than passed empty when the caller gives nothing.
 *
 * MEASURED, and it makes both parameters nearly decorative: Safari FETCHES the
 * page and overwrites what it was given. A custom title sent with a reachable
 * URL was replaced by the page's own; the same title sent with a URL that does
 * not resolve survived, alongside a null preview. So the parameter mapping is
 * correct — `withTitle` really does reach `with title` — and Safari simply
 * outranks it. The tool descriptions say so rather than promising the caller a
 * title they will not get back.
 */
export const ADD_READING_LIST_ITEM = `
function run(argv) {
  var p = JSON.parse(argv[0]);

  var lower = String(p.url || "").slice(0, 12).toLowerCase();
  if (lower.indexOf("http://") !== 0 && lower.indexOf("https://") !== 0) {
    return JSON.stringify({
      ok: false,
      error: { code: "BAD_SCHEME", message: "Only http:// and https:// URLs can be saved." }
    });
  }

  var S = Application("Safari");

  var wasRunning = null;
  try { wasRunning = Boolean(S.running()); } catch (e) {}

  var opts = {};
  if (p.title) opts.withTitle = p.title;
  if (p.previewText) opts.andPreviewText = p.previewText;

  try {
    S.addReadingListItem(p.url, opts);
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: { code: "NO_ACCESS", message: String(e.message || e) }
    });
  }

  return JSON.stringify({
    ok: true,
    data: { launchedSafari: wasRunning === null ? null : !wasRunning }
  });
}
`;

/**
 * Close tabs an agent opened, each only if it is still where it was seen.
 *
 * The server has already found each tab in the record of opened tabs
 * (`opened.ts`) and sends where it saw it: Safari's window id, the tab's
 * position, and the URL it showed. Between that read and this script the user
 * may have dragged, closed or navigated a tab, and a position alone would then
 * name a different one. So every target is checked again here, immediately
 * before `close`, and one that no longer matches exactly is skipped and
 * reported `stale` rather than closed.
 *
 * Targets arrive rightmost first within a window, so closing one never moves
 * the position of the next.
 *
 * Safari is not launched: a quit Safari has no tabs to close, and session
 * restore may bring the recorded ones back, so the record is left alone.
 */
export const CLOSE_TABS = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var S = Application("Safari");

  var running = null;
  try { running = Boolean(S.running()); } catch (e) {}
  if (running === false) {
    return JSON.stringify({ ok: true, data: { running: false, results: [] } });
  }

  // Touched once so a missing grant is reported as one, before any target.
  try {
    S.windows.length;
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: "NO_ACCESS", message: String(e.message || e) } });
  }

  var results = [];
  for (var j = 0; j < p.targets.length; j++) {
    var t = p.targets[j];

    // By id, and confirmed: a window found by its place in the list would
    // become a different window when an earlier close emptied one before it.
    var w = null;
    try {
      w = S.windows.byId(t.windowId);
      if (w.id() !== t.windowId) w = null;
    } catch (e) { w = null; }
    if (!w) { results.push({ id: t.id, outcome: "stale" }); continue; }

    var tabs = [];
    try { tabs = w.tabs(); } catch (e) { tabs = []; }
    var tab = tabs[t.index - 1];
    var url = null;
    try { url = tab ? String(tab.url()) : null; } catch (e) {}
    if (url !== t.url) { results.push({ id: t.id, outcome: "stale" }); continue; }

    // Closing a window's last tab closes the window, which is worth saying.
    var last = tabs.length === 1;
    try {
      tab.close();
      results.push({ id: t.id, outcome: "closed", windowClosed: last });
    } catch (e) {
      results.push({ id: t.id, outcome: "failed", message: String(e.message || e) });
    }
  }

  return JSON.stringify({ ok: true, data: { running: true, results: results } });
}
`;
