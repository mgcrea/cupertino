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
    return (clone.innerText || "").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
