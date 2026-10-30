import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * The background worker, EXECUTED: a plain relay to native code, and nothing
 * else.
 *
 * It once also registered the page-world network hook through
 * `scripting.registerContentScripts` and answered a `netDiag` about it. The
 * live test showed Safari runs that registered copy in the isolated world, so
 * the registration bought nothing and the hook is now injected by `network.js`
 * as a page `<script>`. These tests pin the relay down and assert the
 * registration is gone: no `scripting` call, no install/startup listener, and a
 * `netDiag` treated like any other unknown message.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../apps/apple/CupertinoSafariExtension/Resources/background.js",
      import.meta.url,
    ),
  ),
  "utf8",
);

function load(
  native: (...args: unknown[]) => Promise<unknown> = async () => "native-reply",
  // `null` is a browser with no `cookies` namespace at all, which is what an
  // extension without the permission sees.
  cookies: {
    getAll: (...args: unknown[]) => Promise<unknown>;
    getAllCookieStores?: () => Promise<unknown>;
  } | null = {
    getAll: async () => [],
  },
) {
  const sendNativeMessage = vi.fn(native);
  const registerContentScripts = vi.fn(async () => {});
  const lifecycle: string[] = [];
  const messageListeners: ((message: unknown, sender?: unknown) => Promise<unknown>)[] = [];
  const errors: unknown[][] = [];
  const hook = (name: string) => ({ addListener: () => void lifecycle.push(name) });
  const context = createContext({
    browser: {
      runtime: {
        onMessage: {
          addListener: (fn: (message: unknown, sender?: unknown) => Promise<unknown>) =>
            void messageListeners.push(fn),
        },
        onInstalled: hook("installed"),
        onStartup: hook("startup"),
        sendNativeMessage,
        getManifest: () => ({ version: "9.9.9" }),
      },
      scripting: { registerContentScripts, getRegisteredContentScripts: async () => [] },
      ...(cookies ? { cookies } : {}),
    },
    console: { error: (...args: unknown[]) => errors.push(args) },
    // A service worker has Web Crypto and TextEncoder; the probe hashes with them.
    crypto: globalThis.crypto,
    TextEncoder,
  });
  runInContext(SOURCE, context);
  const send = (message: unknown, sender?: unknown) => messageListeners[0]!(message, sender);
  return { sendNativeMessage, registerContentScripts, lifecycle, messageListeners, errors, send };
}

describe("background relay", () => {
  it("listens for messages and nothing else", () => {
    const { messageListeners, lifecycle, registerContentScripts } = load();
    expect(messageListeners).toHaveLength(1);
    expect(lifecycle).toEqual([]);
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it.each(["capture", "poll", "result"])(
    "forwards a %s to native and returns its reply",
    async (kind) => {
      const { send, sendNativeMessage } = load();
      const message = { kind, payload: 1 };
      await expect(send(message)).resolves.toBe("native-reply");
      expect(sendNativeMessage).toHaveBeenCalledWith("application.id", message);
    },
  );

  it("registers nothing, even after messages of every kind", async () => {
    const { send, registerContentScripts } = load();
    await send({ kind: "poll" });
    await send({ kind: "netDiag" });
    expect(registerContentScripts).not.toHaveBeenCalled();
  });

  it("ignores netDiag and other unknown kinds without going to native", async () => {
    const { send, sendNativeMessage } = load();
    await expect(send({ kind: "netDiag" })).resolves.toBeUndefined();
    await expect(send({ kind: "other" })).resolves.toBeUndefined();
    await expect(send(null)).resolves.toBeUndefined();
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });

  it("logs a native failure and answers undefined", async () => {
    const { send, errors } = load(async () => {
      throw new Error("host gone");
    });
    await expect(send({ kind: "poll" })).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

/**
 * `apple_safari_cookies`, answered HERE and never in the page.
 *
 * `browser.cookies` exists only in the background worker, and that is also
 * the right place on its own merits: an HttpOnly cookie is one the page's
 * process is never handed, so routing it through a content script would put
 * it in exactly the process the flag keeps it out of. So the worker takes a
 * `cookies` command out of the poll's reply before the page sees it, reads
 * the cookies, and files the result with native itself.
 *
 * What leaves the worker is metadata, plus a value only for a name the
 * server listed in `valuesFor` — which it does only for `saveAs`. Every value
 * here is an obvious fake.
 */
describe("cookies command", () => {
  const PAGE = "https://finance.example.test/quote";
  const STORE = [
    {
      name: "A3",
      value: "fake-a3-value-0000",
      domain: ".example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      hostOnly: false,
      session: false,
      expirationDate: 1_798_761_600,
      storeId: "0",
    },
    {
      name: "B",
      value: "fake-b-value-3333",
      domain: "finance.example.test",
      path: "/quote",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      hostOnly: true,
      session: true,
      storeId: "0",
    },
  ];
  const command = (extra: Record<string, unknown> = {}) => ({
    id: "c0ffee00-0000-4000-8000-000000000001",
    action: "cookies",
    url: PAGE,
    expiresAt: 9_999_999_999,
    ...extra,
  });

  /** Native answers the poll with `commands`, and records every result filed. */
  const withPoll = (
    commands: unknown[],
    getAll: (...args: unknown[]) => Promise<unknown>,
    cookies: boolean = true,
  ) => {
    const results: Record<string, unknown>[] = [];
    const loaded = load(
      async (_app, message) => {
        const m = message as Record<string, unknown>;
        if (m.kind === "poll") return { commands };
        if (m.kind === "result") results.push(m);
        return { stored: true };
      },
      cookies ? { getAll } : null,
    );
    return { ...loaded, results };
  };

  it("reads the page's cookies by URL, files metadata only, and hides the command from the page", async () => {
    const getAll = vi.fn(async () => STORE);
    const { send, results } = withPoll([command()], getAll);
    const reply = (await send({ kind: "poll", url: PAGE })) as { commands: unknown[] };
    expect(reply.commands).toEqual([]);
    expect(getAll).toHaveBeenCalledWith({ url: PAGE });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "result",
      id: command().id,
      ok: true,
      extensionVersion: "9.9.9",
    });
    const filed = results[0]!.data as { cookies: Record<string, unknown>[] };
    expect(filed.cookies).toEqual([
      {
        name: "A3",
        domain: ".example.test",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        hostOnly: false,
        session: false,
        expirationDate: 1_798_761_600,
      },
      {
        name: "B",
        domain: "finance.example.test",
        path: "/quote",
        secure: false,
        httpOnly: false,
        sameSite: "unspecified",
        hostOnly: true,
        session: true,
      },
    ]);
    expect(JSON.stringify(results)).not.toContain("fake-");
  });

  it("lets out a value only for a name in valuesFor", async () => {
    const { send, results } = withPoll([command({ valuesFor: ["A3"] })], async () => STORE);
    await send({ kind: "poll", url: PAGE });
    const filed = results[0]!.data as { cookies: Record<string, unknown>[] };
    expect(filed.cookies.find((c) => c.name === "A3")?.value).toBe("fake-a3-value-0000");
    expect(filed.cookies.find((c) => c.name === "B")).not.toHaveProperty("value");
    expect(JSON.stringify(results)).not.toContain("fake-b-value");
  });

  it("refuses a command for a different URL than the polling page's", async () => {
    const getAll = vi.fn(async () => STORE);
    const { send, results } = withPoll([command()], getAll);
    await send({ kind: "poll", url: "https://elsewhere.example.test/" });
    expect(getAll).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ ok: false });
  });

  it("says the permission is missing when there is no cookies API", async () => {
    const { send, results } = withPoll([command()], async () => STORE, false);
    const reply = (await send({ kind: "poll", url: PAGE })) as { commands: unknown[] };
    expect(reply.commands).toEqual([]);
    expect(results[0]).toMatchObject({ kind: "result", ok: false });
    expect(String(results[0]!.error)).toMatch(/cookies/);
  });

  it("files a failed read as an error rather than throwing", async () => {
    const { send, results } = withPoll([command()], async () => {
      throw new Error("no host permission");
    });
    await send({ kind: "poll", url: PAGE });
    expect(results[0]).toMatchObject({ ok: false });
    expect(String(results[0]!.error)).toContain("no host permission");
  });

  it("passes every other command through to the page untouched", async () => {
    const getAll = vi.fn(async () => STORE);
    const click = { id: "x", action: "click", url: PAGE, expiresAt: 1 };
    const { send, results } = withPoll([click], getAll);
    const reply = (await send({ kind: "poll", url: PAGE })) as { commands: unknown[] };
    expect(reply.commands).toEqual([click]);
    expect(getAll).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});

/**
 * `cookieProbe`: which cookie store answers, measured without a value.
 *
 * Safari keeps one cookie store per profile, and `getAll({url})` with no
 * `storeId` reads whichever the API defaults to — not necessarily the one the
 * polling tab's profile uses. The probe reads one cookie name from EVERY store
 * the API knows, says which store holds the polling tab, and identifies each
 * value only by the first 8 hex of its SHA-256, computed in the worker. Values
 * are obvious fakes, and every assertion searches the whole filed result.
 */
describe("cookieProbe command", () => {
  const PAGE = "https://finance.example.test/portfolios/";
  const OLD = "fake-t-old-value-0000";
  const NEW = "fake-t-new-value-1111";
  const sha8 = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 8);
  const cookie = (value: string, storeId: string, extra: Record<string, unknown> = {}) => ({
    name: "T",
    value,
    domain: ".example.test",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    hostOnly: false,
    session: false,
    expirationDate: 1_798_761_600,
    storeId,
    ...extra,
  });
  const probe = {
    id: "c0ffee00-0000-4000-8000-000000000002",
    action: "cookieProbe",
    url: PAGE,
    name: "T",
    expiresAt: 9_999_999_999,
  };

  /** Two profiles: store "0" (the API's default) holds an old session, "1" the tab's. */
  const twoStores = () => {
    const getAll = vi.fn(async (query: { storeId?: string }) =>
      query.storeId === "1" ? [cookie(NEW, "1")] : [cookie(OLD, "0")],
    );
    const getAllCookieStores = vi.fn(async () => [
      { id: "0", tabIds: [3] },
      { id: "1", tabIds: [7, 9] },
    ]);
    const results: Record<string, unknown>[] = [];
    const loaded = load(
      async (_app, message) => {
        const m = message as Record<string, unknown>;
        if (m.kind === "poll") return { commands: [probe] };
        if (m.kind === "result") results.push(m);
        return { stored: true };
      },
      { getAll, getAllCookieStores },
    );
    return { ...loaded, results, getAll, getAllCookieStores };
  };

  it("reads the name from every store and says which one holds the polling tab", async () => {
    const { send, results, getAll } = twoStores();
    await send({ kind: "poll", url: PAGE }, { tab: { id: 9, incognito: false } });
    expect(getAll).toHaveBeenCalledWith({ url: PAGE, name: "T" });
    expect(getAll).toHaveBeenCalledWith({ url: PAGE, name: "T", storeId: "0" });
    expect(getAll).toHaveBeenCalledWith({ url: PAGE, name: "T", storeId: "1" });

    expect(results[0]).toMatchObject({ kind: "result", id: probe.id, ok: true });
    const data = results[0]!.data as {
      tab: Record<string, unknown>;
      stores: { id: string; tabCount: number; holdsThisTab: boolean }[];
      reads: { storeId: string | null; matches: Record<string, unknown>[] }[];
    };
    expect(data.tab).toMatchObject({ id: 9, incognito: false });
    expect(data.stores).toEqual([
      { id: "0", tabCount: 1, holdsThisTab: false },
      { id: "1", tabCount: 2, holdsThisTab: true },
    ]);
    // The default read (what the tool did) and one per store.
    expect(data.reads.map((r) => r.storeId)).toEqual([null, "0", "1"]);
    expect(data.reads[0]!.matches[0]).toMatchObject({ storeId: "0", valueSha8: sha8(OLD) });
    expect(data.reads[2]!.matches[0]).toMatchObject({
      storeId: "1",
      domain: ".example.test",
      path: "/",
      expirationDate: 1_798_761_600,
      valueSha8: sha8(NEW),
    });
  });

  it("files no value, only 8-hex prefixes", async () => {
    const { send, results } = twoStores();
    await send({ kind: "poll", url: PAGE }, { tab: { id: 9 } });
    const filed = JSON.stringify(results);
    expect(filed).not.toContain(OLD);
    expect(filed).not.toContain(NEW);
    expect(filed).not.toContain('"value"');
    for (const read of (results[0]!.data as { reads: { matches: { valueSha8: string }[] }[] })
      .reads) {
      for (const m of read.matches) expect(m.valueSha8).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("returns every duplicate of the name, with partition fields when the API gives them", async () => {
    const getAll = vi.fn(async () => [
      cookie(OLD, "0"),
      cookie(NEW, "0", {
        domain: "finance.example.test",
        path: "/portfolios",
        partitionKey: { topLevelSite: "https://example.test" },
      }),
    ]);
    const results: Record<string, unknown>[] = [];
    const { send } = load(
      async (_app, message) => {
        const m = message as Record<string, unknown>;
        if (m.kind === "poll") return { commands: [probe] };
        if (m.kind === "result") results.push(m);
        return { stored: true };
      },
      { getAll },
    );
    await send({ kind: "poll", url: PAGE }, { tab: { id: 9 } });
    const data = results[0]!.data as {
      stores: unknown;
      reads: { matches: Record<string, unknown>[] }[];
    };
    // No getAllCookieStores in this browser: said, not guessed.
    expect(data.stores).toBeNull();
    expect(data.reads).toHaveLength(1);
    expect(data.reads[0]!.matches).toHaveLength(2);
    expect(data.reads[0]!.matches[1]).toMatchObject({
      domain: "finance.example.test",
      path: "/portfolios",
      partitionKey: { topLevelSite: "https://example.test" },
    });
    expect(JSON.stringify(results)).not.toContain("fake-");
  });

  it("does not let the page see the probe", async () => {
    const { send } = twoStores();
    const reply = (await send({ kind: "poll", url: PAGE }, { tab: { id: 9 } })) as {
      commands: unknown[];
    };
    expect(reply.commands).toEqual([]);
  });
});
