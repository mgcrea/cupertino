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
    const reply = await browser.runtime.sendNativeMessage("application.id", message);
    return kind === "poll" ? await answerHere(reply, message) : reply;
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

// ── Commands answered here ──────────────────────────────────────────────────
//
// `cookies` is the one command the page never sees. `browser.cookies` exists
// only in this worker, and that is the right place on its own merits: an
// HttpOnly cookie is one the page's process is never handed, so passing it
// through a content script would put it in exactly the process the flag
// keeps it out of. The poll still does the routing — the handler gives the
// command to a page on its URL, which is the per-site grant at work — and the
// worker takes it out of the reply on the way back.

/** Run the commands meant for this worker, and hand the page the rest. */
async function answerHere(reply, poll) {
  const commands = reply?.commands;
  if (!Array.isArray(commands)) return reply;
  const forPage = [];
  for (const command of commands) {
    if (command?.action !== "cookies") {
      forPage.push(command);
      continue;
    }
    const result = await cookies(command, poll);
    try {
      await browser.runtime.sendNativeMessage("application.id", {
        kind: "result",
        id: command.id,
        extensionVersion: manifestVersion(),
        ...result,
      });
    } catch (error) {
      // The server times out and says nothing answered, which is true.
      console.error("[cupertino] could not file a result:", String(error));
    }
  }
  return { ...reply, commands: forPage };
}

/**
 * The cookies Safari would send to the command's URL, as metadata, with a
 * value only for a name in `valuesFor`.
 *
 * `valuesFor` is set by the server only for `saveAs`, to the names the caller
 * asked to write; a listing sends none, so no value crosses the channel. The
 * result is written to the container by the handler and removed by the server
 * as it collects it. Never throws, so a failure is an answer rather than a
 * timeout. An error message is the API's own and carries no cookie.
 */
async function cookies(command, poll) {
  // The handler only gives a URL-routed command to a page polling with that
  // URL; this is the same rule where the read happens.
  if (typeof command.url !== "string" || command.url !== poll?.url) {
    return { ok: false, error: "This cookies command was for another page and was not run." };
  }
  if (!browser.cookies || typeof browser.cookies.getAll !== "function") {
    return {
      ok: false,
      error:
        "browser.cookies is not available to the extension: this build lacks the cookies " +
        "permission, or Safari has not granted it. Check the extension is enabled in Safari " +
        "Settings > Extensions.",
    };
  }
  try {
    const found = await browser.cookies.getAll({ url: command.url });
    const values = Array.isArray(command.valuesFor) ? command.valuesFor : [];
    return {
      ok: true,
      data: {
        cookies: (found ?? []).map((c) => {
          const entry = {
            name: c.name,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            hostOnly: c.hostOnly,
            session: c.session,
          };
          if (typeof c.expirationDate === "number") entry.expirationDate = c.expirationDate;
          if (values.includes(c.name)) entry.value = c.value;
          return entry;
        }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: "browser.cookies.getAll failed: " + String(error?.message || error),
    };
  }
}

function manifestVersion() {
  try {
    return browser.runtime.getManifest().version || null;
  } catch {
    return null;
  }
}
