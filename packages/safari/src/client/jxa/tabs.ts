/**
 * The Apple Events lane, which on this surface is a READ.
 *
 * ## Why a read lane exists here when the policy forbids one
 *
 * docs/distribution.md's rule is that a new surface gets file-lane reads only,
 * because an Apple Events read lane is a slow duplicate of a fast file lane.
 * Safari is the case that rule does not describe. Its two lanes see **almost
 * disjoint things**: the file lane holds everything about the past and knows
 * nothing about the present, and Apple Events sees exactly one thing — what is
 * open right now — which Safari never writes to disk at all.
 *
 * So this is not a fallback and must never be treated as one. There is no
 * question it answers more slowly than the store; there is a question only it
 * can answer.
 *
 * ## What it costs
 *
 * MEASURED, macOS 26.6: 2 windows, 28-30 tabs, read in **95-1,482 ms**. The
 * spread is the interesting part — a warm Safari answers in a tenth of a
 * second, a cold one takes a second and a half — so the timeout has to
 * accommodate the slow end while the tool description promises nothing about
 * the fast one.
 *
 * ## What it deliberately does NOT do
 *
 * No `do JavaScript`. That verb needs "Allow JavaScript from Apple Events", a
 * Safari developer-menu toggle which is not a TCC grant, whose own state is
 * unreadable (`defaults read com.apple.Safari AllowJavaScriptFromAppleEvents`
 * is itself TCC-protected and returned nothing on the probed machine), and
 * which `apps/apple/Cupertino/Permissions.swift` has no concept of. Shipping a
 * verb that needs an unmodelled permission means diagnostics reports a healthy
 * surface whose most powerful capability silently fails. Not shipping it is
 * what keeps the app's two-state permission model honest for Safari.
 *
 * No writes. Opening a URL or adding to the Reading List navigates a real,
 * visible browser, and docs/safari.md records that no write was ever probed.
 *
 * ## The contract
 *
 * Enforced by `assertStaticScript`: a static constant with no `${}` anywhere,
 * parameters via `JSON.parse(argv[0])`, results as `{ok, data}` /
 * `{ok: false, error}`, and the script always exits 0 — so a non-zero exit
 * always means infrastructure rather than "Safari has no windows open".
 */

/**
 * Read every window and tab.
 *
 * Bulk-fetch and filter in JS; never `whose`. Measured on three other surfaces
 * in this repo, where `whose` was between 4.5 s and unusable.
 *
 * `index` is the tab's POSITION, and positions move the moment somebody drags a
 * tab. It is reported because it is the only handle Safari offers, and the tool
 * description says it is positional rather than an identifier — this surface's
 * real identity is the URL, which is also the only join key back to history.
 */
export const LIVE_TABS = `
function run(argv) {
  var S = Application("Safari");

  var wins;
  try {
    wins = S.windows();
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: "NO_ACCESS", message: String(e.message || e) } });
  }

  var out = [];
  for (var i = 0; i < wins.length; i++) {
    var tabs = [];
    try { tabs = wins[i].tabs(); } catch (e) { tabs = []; }

    var currentIndex = null;
    try { currentIndex = wins[i].currentTab().index(); } catch (e) {}

    for (var j = 0; j < tabs.length; j++) {
      var url = null, name = null, index = null;
      // Each property defensively: a tab still loading, or showing a native
      // error page, throws on some of these while answering others.
      try { url = String(tabs[j].url()); } catch (e) {}
      try { name = String(tabs[j].name()); } catch (e) {}
      try { index = tabs[j].index(); } catch (e) { index = j + 1; }
      if (url === null && name === null) continue;
      out.push({
        window: i + 1,
        index: index,
        url: url,
        title: name,
        active: currentIndex !== null && index === currentIndex
      });
    }
  }

  return JSON.stringify({ ok: true, data: { windows: wins.length, tabs: out } });
}
`;
