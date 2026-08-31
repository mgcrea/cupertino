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
 * So what ships here is navigation and the Reading List: the writes that move a
 * browser between pages rather than reaching into one.
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
 * new tab without disturbing the current one. It needs a window to push into,
 * and it is the part of this file least verified against a real Safari. So when
 * there is no window, or when the push throws, the script falls back to
 * `open location` — a Standard Suite verb that always works and is simply less
 * precise about where the page lands. `route` says which happened.
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
  var target = p.target === "current-tab" ? "current-tab" : "new-tab";

  try {
    if (target === "current-tab" && wins.length > 0) {
      wins[0].currentTab.url = p.url;
      route = "current-tab";
    } else if (wins.length > 0) {
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
      tab: { url: landedUrl, title: landedTitle, index: landedIndex }
    }
  });
}
`;

/**
 * Add an item to the Reading List.
 *
 * The one write on this surface that changes nothing on screen: no tab opens,
 * no page loads, nothing moves. That is what made it the first one to build.
 *
 * `with title` and `and preview text` are optional in the dictionary, and are
 * omitted rather than passed empty when the caller gives nothing — Safari fills
 * both in itself from the page, and passing "" would replace a real title with
 * a blank one. Whether it fetches the page to do that is not measured here.
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
