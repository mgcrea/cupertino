// Runs in the page, and only on sites the user has allowed the extension on.
//
// `<all_urls>` in the manifest is a REQUEST, not a grant: Safari still gates
// this per website and grants nothing until asked. That gating is the whole
// reason this lane exists rather than "Allow JavaScript from Apple Events",
// which is global, permanent, unscoped and unreadable — see docs/safari.md.

(function () {
  // Two shapes, because the tool offers both and they cost very different
  // amounts of context: a Reddit thread is tens of KB of text and hundreds of
  // KB of markup. Extracting here rather than in the server keeps the large
  // one from crossing the boundary when nobody asked for it.
  function readableText() {
    // innerText on a detached clone, so removing script/style cannot disturb
    // the page the user is actually looking at.
    const clone = document.body?.cloneNode(true);
    if (!clone) return "";
    for (const n of clone.querySelectorAll("script,style,noscript,template")) n.remove();
    return (clone.innerText || "")
      .replace(/[ \t ]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function capture() {
    try {
      browser.runtime.sendMessage({
        kind: "capture",
        url: location.href,
        title: document.title || "",
        text: readableText(),
        html: document.documentElement?.outerHTML || "",
      });
    } catch {
      // The background worker may be asleep or the page may be closing. A lost
      // capture is a stale entry, never a broken page — never throw into a site
      // the user is reading.
    }
  }

  capture();

  // Single-page apps replace the document without a navigation, so the first
  // capture would describe a route the user has already left. This is also why
  // the history join misses so often — see "Why the match rate collapsed".
  let last = location.href;
  const onRouteChange = () => {
    if (location.href === last) return;
    last = location.href;
    setTimeout(capture, 400);
  };
  addEventListener("popstate", onRouteChange);
  const push = history.pushState;
  history.pushState = function (...args) {
    push.apply(this, args);
    onRouteChange();
  };
})();

// ── Commands ────────────────────────────────────────────────────────────────
//
// The other direction: the page ASKS whether anything has been requested of it,
// runs it, and reports back. See `actions.js` for what it can run.
//
// ## Why the page polls instead of being pushed to
//
// Nothing outside Safari can wake a content script. The routes that exist are
// an Apple Event (`dispatch message to extension`) — which was measured to
// accept an empty dictionary and a bogus extension id without complaint, so a
// misdelivered message is indistinguishable from a delivered one — and
// `SFSafariApplication.dispatchMessage` from the containing app, which reports
// errors properly but needs the app in the path.
//
// A poll needs neither. It is the only route with no Apple Event anywhere in
// it, which is the whole point of this lane, and it fails visibly: if the
// native side is unreachable the loop keeps running and nothing is silently
// lost. `runCommandsNow` below is the seam for a push to arrive later without
// another notarized build.
//
// ## What it costs, and why the rate is what it is
//
// One native round trip per interval per allowed page. A hidden tab drops to a
// tenth of the rate rather than stopping: a background tab is still a
// legitimate target, and a loop that stopped would make "the tab was not in
// front" look exactly like "the extension is not installed".
(function () {
  const VISIBLE_MS = 1000;
  const HIDDEN_MS = 10000;
  let stopped = false;

  async function pump() {
    if (stopped) return;
    try {
      const response = await browser.runtime.sendMessage({ kind: "poll", url: location.href });
      for (const command of response?.commands ?? []) {
        // Never let one command's failure strand the next: each is reported on
        // its own, and `cupertinoRunCommand` is written never to throw.
        const result = window.cupertinoRunCommand
          ? window.cupertinoRunCommand(command)
          : { ok: false, error: "The action runner did not load on this page." };
        await browser.runtime.sendMessage({ kind: "result", id: command.id, ...result });
      }
    } catch {
      // The background worker may be asleep, restarting, or gone. A failed poll
      // is a poll that did not happen, never a broken page.
    }
    setTimeout(pump, document.hidden ? HIDDEN_MS : VISIBLE_MS);
  }

  // The seam a push would use: a wake can call this to collapse the latency to
  // the next poll without changing anything else here.
  window.cupertinoPumpNow = pump;

  addEventListener("pagehide", () => {
    stopped = true;
  });

  pump();
})();
