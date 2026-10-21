// The relay, and the only part that can talk to native code.
//
// A content script cannot call sendNativeMessage, so every capture passes
// through here. The worker is non-persistent: it starts on an event and is
// terminated when idle, which is why nothing is kept in memory between
// messages — the store on the native side is the state.

browser.runtime.onMessage.addListener(async (message) => {
  const kind = message?.kind;
  if (kind !== "capture" && kind !== "poll" && kind !== "result") return;
  try {
    // The reply MATTERS for a poll — it carries the commands — so unlike a
    // capture this is returned rather than awaited and dropped. Returning a
    // value from this listener is what resolves the content script's
    // sendMessage, which is the only channel a content script has back.
    return await browser.runtime.sendNativeMessage("application.id", message);
  } catch (error) {
    // The handler is the only thing that can persist a capture or hold a
    // command queue, so a failure here means the message is simply lost. That
    // is the honest outcome: the server reports what it has and how old it is,
    // and a missing page reads as missing rather than as stale-but-present. A
    // lost poll is retried by the next one a second later.
    console.error("[cupertino] native message failed:", String(error));
    return undefined;
  }
});

// ── Page-world hook registration (fallback) ─────────────────────────────────
//
// The network recorder, `network-hook.js`, has to run in the page's own
// JavaScript world to wrap its `fetch` and `XMLHttpRequest`. The manifest asks
// for that with `"world": "MAIN"` on a `content_scripts` entry, but Safari's
// support for that key is UNDOCUMENTED: Apple's manifest reference does not
// list it, and the only thing an Apple developer-forum thread confirms is
// `scripting.registerContentScripts` with `world: "MAIN"`, available since
// Safari 16.4. If the manifest key were silently ignored, the hook would load
// into the isolated world, see nothing, and every network command would
// answer "no traffic" with no sign that the recorder never ran. Finding that
// out costs a notarization round trip.
//
// So the same script is registered here too. It costs one permission
// (`scripting`) and makes the build work whichever way Safari treats the key.
// Both copies running is harmless: the hook guards itself with a
// `window.__cupertinoNetHook` symbol, so a second copy in the page world does
// nothing, and it checks which world it landed in, so a copy that ended up in
// the isolated world does nothing either.
//
// Registered on install AND on startup because the worker is non-persistent
// and registrations made through this API are only as durable as
// `persistAcrossSessions` says; the second call is the one that repairs a
// registration Safari dropped. The call is idempotent in effect: a repeat
// fails with a duplicate-id error, which means "already registered" and is
// ignored. Anything else is logged and otherwise ignored, because the manifest
// entry may still be doing the job.
async function registerNetworkHook() {
  try {
    await browser.scripting.registerContentScripts([
      {
        id: "cupertino-net-hook",
        matches: ["<all_urls>"],
        js: ["network-hook.js"],
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    if (/duplicate/i.test(String(error?.message ?? error))) return;
    console.error("[cupertino] registering the network hook failed:", String(error));
  }
}

browser.runtime.onInstalled.addListener(registerNetworkHook);
browser.runtime.onStartup.addListener(registerNetworkHook);
