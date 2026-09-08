// Runs in the page, and only on sites the user has allowed the extension on.
//
// `<all_urls>` in the manifest is a REQUEST, not a grant: Safari still gates
// this per website and grants nothing until asked. That gating is the whole
// reason this lane exists rather than "Allow JavaScript from Apple Events",
// which is global, permanent, unscoped and unreadable — see docs/safari.md.

(function () {
  /**
   * This build's version, straight from the manifest that shipped with the
   * running code. `make version` keeps it equal to the app's, so the server can
   * compare it against its own and know whether the two halves are the same
   * build — they ship inside one bundle, so any difference means a tab is
   * running code from before an update.
   */
  function version() {
    try {
      return browser.runtime.getManifest().version || null;
    } catch {
      // An orphaned content script cannot reach its own runtime. Null is the
      // honest answer and is itself evidence of exactly that.
      return null;
    }
  }

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

  /**
   * How long the DOM must hold still before a second capture, and how long to
   * wait for a stillness that may never come.
   *
   * `document_idle` is before a single-page app has rendered anything. The only
   * capture of x.com was therefore its pre-boot shell — an empty `<title>`, a
   * loading placeholder, and the static "Something went wrong ... privacy
   * related extensions" block X ships in every response — and because the store
   * is keyed by URL, that snapshot was the permanent answer for the page.
   * Waiting before `read_page` could not fix it: nothing captured a second
   * time. See docs/safari.md.
   *
   * The deadline is not a safety net, it is the common case. A live timeline —
   * video, ads, ticking timestamps — never goes quiet, so a debounce on its own
   * would wait forever on exactly the pages this exists for.
   */
  const SETTLE_QUIET_MS = 500;
  const SETTLE_DEADLINE_MS = 5000;

  /**
   * The text of the last capture that left this page.
   *
   * A settle capture identical to the stored one is a native round trip that
   * overwrites an entry with itself, and most pages settle without having
   * changed. Compared on the text rather than a cheaper fingerprint because the
   * text is being computed anyway to send.
   */
  let sent = null;

  function capture() {
    try {
      const text = readableText();
      if (text === sent) return;
      browser.runtime.sendMessage({
        kind: "capture",
        url: location.href,
        title: document.title || "",
        text,
        html: document.documentElement?.outerHTML || "",
        // Which build wrote this. An update leaves already-open tabs running
        // the PREVIOUS content script — orphaned, unable to reach the
        // background worker at all — so a capture stamped with an older
        // version beside a page that answers nothing is the one signal that
        // separates "reload the tab" from "the extension is not allowed here".
        extensionVersion: version(),
      });
      // Only after the send: a throw here means nothing was stored, and
      // recording it as sent would suppress the retry that follows.
      sent = text;
    } catch {
      // The background worker may be asleep or the page may be closing. A lost
      // capture is a stale entry, never a broken page — never throw into a site
      // the user is reading.
    }
  }

  let observer = null;
  let quietTimer = null;
  let deadlineTimer = null;

  function stopSettling() {
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(quietTimer);
    clearTimeout(deadlineTimer);
    quietTimer = null;
    deadlineTimer = null;
  }

  /**
   * Capture again once the page stops changing, or once it has had long enough
   * — whichever comes first.
   *
   * Only one watcher runs at a time: a route change replaces the one in flight
   * rather than racing it, so a capture can never be attributed to the route
   * the user has already left.
   */
  function captureWhenSettled() {
    stopSettling();
    const done = () => {
      stopSettling();
      capture();
    };
    const restart = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(done, SETTLE_QUIET_MS);
    };
    try {
      observer = new MutationObserver(restart);
      // `documentElement` rather than `body`, so the `<title>` a framework sets
      // on boot counts as movement. It is usually the first thing to change.
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    } catch {
      // Nothing observable. The deadline below still runs, so a page that
      // renders late is still captured — just not early.
    }
    quietTimer = setTimeout(done, SETTLE_QUIET_MS);
    deadlineTimer = setTimeout(done, SETTLE_DEADLINE_MS);
  }

  // Immediately, so a server-rendered page needs no wait at all and a tab
  // closed in the next second still leaves something behind. Then again when
  // the page has actually rendered, which overwrites this one.
  capture();
  captureWhenSettled();

  // Single-page apps replace the document without a navigation, so the first
  // capture would describe a route the user has already left. This is also why
  // the history join misses so often — see "Why the match rate collapsed".
  let last = location.href;
  const onRouteChange = () => {
    if (location.href === last) return;
    last = location.href;
    // A new URL is a new entry in the store, so the previous route's text says
    // nothing about whether this one is worth sending.
    sent = null;
    captureWhenSettled();
  };
  addEventListener("popstate", onRouteChange);
  const push = history.pushState;
  history.pushState = function (...args) {
    push.apply(this, args);
    onRouteChange();
  };
  addEventListener("pagehide", stopSettling);
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
  /** Same as the capture block's, and separate because each IIFE is its own scope. */
  function manifestVersion() {
    try {
      return browser.runtime.getManifest().version || null;
    } catch {
      return null;
    }
  }

  const VISIBLE_MS = 1000;
  const HIDDEN_MS = 10000;
  let stopped = false;

  async function pump() {
    if (stopped) return;
    try {
      const response = await browser.runtime.sendMessage({
        kind: "poll",
        url: location.href,
        extensionVersion: manifestVersion(),
      });
      for (const command of response?.commands ?? []) {
        // Never let one command's failure strand the next: each is reported on
        // its own, and `cupertinoRunCommand` is written never to throw.
        const result = window.cupertinoRunCommand
          ? window.cupertinoRunCommand(command)
          : { ok: false, error: "The action runner did not load on this page." };
        await browser.runtime.sendMessage({
          kind: "result",
          id: command.id,
          extensionVersion: manifestVersion(),
          ...result,
        });
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
