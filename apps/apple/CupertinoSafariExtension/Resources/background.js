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
