// The relay, and the only part that can talk to native code.
//
// A content script cannot call sendNativeMessage, so every capture passes
// through here. The worker is non-persistent: it starts on an event and is
// terminated when idle, which is why nothing is kept in memory between
// messages — the store on the native side is the state.

browser.runtime.onMessage.addListener(async (message, sender) => {
  const kind = message?.kind;
  if (kind !== "capture" && kind !== "poll" && kind !== "result") return;
  try {
    // The reply MATTERS for a poll — it carries the commands — so unlike a
    // capture this is returned rather than awaited and dropped. Returning a
    // value from this listener is what resolves the content script's
    // sendMessage, which is the only channel a content script has back.
    const reply = await browser.runtime.sendNativeMessage("application.id", message);
    return kind === "poll" ? await answerHere(reply, message, sender) : reply;
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
async function answerHere(reply, poll, sender) {
  const commands = reply?.commands;
  if (!Array.isArray(commands)) return reply;
  const forPage = [];
  for (const command of commands) {
    if (command?.action !== "cookies" && command?.action !== "cookieProbe") {
      forPage.push(command);
      continue;
    }
    const result =
      command.action === "cookies"
        ? await cookies(command, poll, sender)
        : await cookieProbe(command, poll, sender);
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
 *
 * Read from the store holding the tab that polled, and from no other. Safari
 * keeps a cookie store per profile, and `getAll` with no `storeId` answers
 * from one fixed store whatever profile the tab is in: measured 2026-10-30, a
 * Maker-profile tab got the Personal profile's session, so a sign-in in Maker
 * left the saved file byte-identical and Yahoo refused it. With no store to
 * name, it refuses rather than hand over some profile's session.
 */
async function cookies(command, poll, sender) {
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
  const store = await storeOfTab(sender);
  if (!store.id) return { ok: false, error: store.error };
  try {
    const found = await browser.cookies.getAll({ url: command.url, storeId: store.id });
    const values = Array.isArray(command.valuesFor) ? command.valuesFor : [];
    return {
      ok: true,
      data: {
        store: store.id,
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

/**
 * The cookie store the polling tab's profile uses: the one store whose
 * `tabIds` holds that tab. Anything short of exactly one is an error that
 * names the cause, never a fallback to the default store, which is the wrong
 * profile's session for every tab outside it.
 */
async function storeOfTab(sender) {
  const unknown =
    "Could not tell which cookie store (Safari profile) this tab uses, so nothing was read: " +
    "the default store can belong to another profile.";
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return { error: unknown + " The poll named no tab." };
  if (typeof browser.cookies.getAllCookieStores !== "function") {
    return { error: unknown + " This Safari does not list its cookie stores." };
  }
  try {
    const holding = ((await browser.cookies.getAllCookieStores()) ?? []).filter(
      (s) => Array.isArray(s.tabIds) && s.tabIds.includes(tabId),
    );
    if (holding.length === 1) return { id: holding[0].id };
    return { error: unknown + ` ${holding.length} stores claim the tab.` };
  } catch (error) {
    return { error: unknown + " " + String(error?.message || error) };
  }
}

/**
 * Which cookie store answers, for one name, measured without a value.
 *
 * Safari keeps a cookie store per profile, and `getAll({url})` with no
 * `storeId` reads whichever one the API defaults to, which need not be the one
 * the polling tab's profile sends from. So this reads the name from the
 * default AND from every store `getAllCookieStores` lists, says which store
 * holds the polling tab, and stands for each value with the first 8 hex of its
 * SHA-256, hashed here: two prefixes that differ are two sessions, and one that
 * does not move across a sign-in is a store the sign-in never touched.
 */
async function cookieProbe(command, poll, sender) {
  if (typeof command.url !== "string" || command.url !== poll?.url) {
    return { ok: false, error: "This cookies command was for another page and was not run." };
  }
  if (!browser.cookies || typeof browser.cookies.getAll !== "function") {
    return { ok: false, error: "browser.cookies is not available to the extension." };
  }
  const tab = sender?.tab ?? {};
  const tabInfo = { id: tab.id ?? null, incognito: tab.incognito ?? null };
  if (typeof tab.cookieStoreId === "string") tabInfo.cookieStoreId = tab.cookieStoreId;

  let stores = null;
  if (typeof browser.cookies.getAllCookieStores === "function") {
    try {
      stores = ((await browser.cookies.getAllCookieStores()) ?? []).map((s) => ({
        id: s.id,
        tabCount: Array.isArray(s.tabIds) ? s.tabIds.length : 0,
        holdsThisTab: Array.isArray(s.tabIds) && s.tabIds.includes(tab.id),
      }));
    } catch (error) {
      stores = { error: String(error?.message || error) };
    }
  }

  const read = async (storeId) => {
    const query = { url: command.url, name: command.name };
    if (storeId !== null) query.storeId = storeId;
    try {
      const found = (await browser.cookies.getAll(query)) ?? [];
      const matches = [];
      for (const c of found) {
        const entry = {
          storeId: c.storeId ?? null,
          domain: c.domain,
          path: c.path,
          hostOnly: c.hostOnly,
          session: c.session,
          valueSha8: await sha8(c.value),
        };
        if (typeof c.expirationDate === "number") entry.expirationDate = c.expirationDate;
        if (c.partitionKey !== undefined) entry.partitionKey = c.partitionKey;
        if (c.firstPartyDomain !== undefined) entry.firstPartyDomain = c.firstPartyDomain;
        matches.push(entry);
      }
      return { storeId, matches };
    } catch (error) {
      return { storeId, error: String(error?.message || error) };
    }
  };

  const reads = [await read(null)];
  if (Array.isArray(stores)) for (const s of stores) reads.push(await read(s.id));
  return { ok: true, data: { tab: tabInfo, stores, reads } };
}

/** The first 8 hex of a value's SHA-256: enough to tell two values apart, never the value. */
async function sha8(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

function manifestVersion() {
  try {
    return browser.runtime.getManifest().version || null;
  } catch {
    return null;
  }
}
