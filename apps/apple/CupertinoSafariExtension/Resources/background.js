// The relay, and the only part that can talk to native code.
//
// A content script cannot call sendNativeMessage, so every capture passes
// through here. The worker is non-persistent: it starts on an event and is
// terminated when idle, which is why nothing is kept in memory between
// messages — the store on the native side is the state.

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.kind !== "capture") return;
  try {
    await browser.runtime.sendNativeMessage("application.id", message);
  } catch (error) {
    // The handler is the only thing that can persist a capture, so a failure
    // here means the capture is simply lost. That is the honest outcome: the
    // server reports what it has and how old it is, and a missing page reads
    // as missing rather than as stale-but-present.
    console.error("[cupertino] native message failed:", String(error));
  }
});
