import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

/**
 * The background worker's registration fallback, EXECUTED.
 *
 * Safari's support for `world` in manifest `content_scripts` is undocumented,
 * so `background.js` also registers the page-world hook through
 * `scripting.registerContentScripts`. These tests evaluate it in a `node:vm`
 * with the four `browser.*` surfaces it touches stubbed, and check that the
 * registration is made on install and on startup, and that a duplicate-id
 * rejection (the second of the two paths to run) is swallowed while anything
 * else is logged.
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
  register: (scripts: unknown[]) => Promise<void>,
  opts: { registered?: string[]; scripting?: boolean; hangList?: boolean } = {},
) {
  const registerContentScripts = vi.fn(register);
  const sendNativeMessage = vi.fn(async (..._args: unknown[]) => "native-reply" as unknown);
  const listeners: Record<string, () => void> = {};
  const messageListeners: ((message: unknown) => Promise<unknown>)[] = [];
  const errors: unknown[][] = [];
  const hook = (name: string) => ({
    addListener: (fn: () => void) => {
      listeners[name] = fn;
    },
  });
  const context = createContext({
    browser: {
      runtime: {
        onMessage: {
          addListener: (fn: (message: unknown) => Promise<unknown>) =>
            void messageListeners.push(fn),
        },
        onInstalled: hook("installed"),
        onStartup: hook("startup"),
        sendNativeMessage,
      },
      scripting:
        opts.scripting === false
          ? undefined
          : {
              registerContentScripts,
              getRegisteredContentScripts: () =>
                opts.hangList
                  ? new Promise<never>(() => {})
                  : Promise.resolve((opts.registered ?? []).map((id) => ({ id }))),
            },
    },
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: never) => globalThis.clearTimeout(id),
    console: { error: (...args: unknown[]) => errors.push(args) },
  });
  runInContext(SOURCE, context);
  const send = (message: unknown) => messageListeners[0]!(message);
  return { registerContentScripts, sendNativeMessage, listeners, errors, send };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const EXPECTED = [
  {
    id: "cupertino-net-hook",
    matches: ["<all_urls>"],
    js: ["network-hook.js"],
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  },
];

describe("background registration fallback", () => {
  it("registers the MAIN-world hook on install", async () => {
    const { registerContentScripts, listeners } = load(async () => {});
    listeners.installed!();
    await flush();
    expect(registerContentScripts).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify(registerContentScripts.mock.calls[0]![0]))).toEqual(EXPECTED);
  });

  it("registers it again on startup", async () => {
    const { registerContentScripts, listeners } = load(async () => {});
    listeners.startup!();
    await flush();
    expect(registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("swallows a duplicate-id rejection", async () => {
    const { listeners, errors } = load(async () => {
      throw new Error("Duplicate script ID 'cupertino-net-hook'");
    });
    listeners.installed!();
    await flush();
    expect(errors).toEqual([]);
  });

  it("logs any other rejection", async () => {
    const { listeners, errors } = load(async () => {
      throw new Error("permission denied");
    });
    listeners.installed!();
    await flush();
    expect(errors).toHaveLength(1);
  });

  it("registers lazily on the first message of any kind, once, without onInstalled", async () => {
    const { registerContentScripts, send } = load(async () => {});
    await send({ kind: "poll" });
    await send({ kind: "capture" });
    await flush();
    expect(registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("does not register a second time when onInstalled already did", async () => {
    const { registerContentScripts, listeners, send } = load(async () => {});
    listeners.installed!();
    await send({ kind: "poll" });
    await flush();
    expect(registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it("answers a poll without waiting for the registration", async () => {
    const { send } = load(() => new Promise(() => {}));
    await expect(send({ kind: "poll" })).resolves.toBe("native-reply");
  });
});

describe("netDiag", () => {
  it("reports the registered ids and no error", async () => {
    const { send } = load(async () => {}, { registered: ["cupertino-net-hook"] });
    expect(await send({ kind: "netDiag" })).toEqual({
      registered: ["cupertino-net-hook"],
      error: null,
      scriptingAvailable: true,
    });
  });

  it("reports the last non-duplicate registration error", async () => {
    const { send } = load(
      async () => {
        throw new Error("permission denied");
      },
      { registered: [] },
    );
    expect(await send({ kind: "netDiag" })).toEqual({
      registered: [],
      error: "permission denied",
      scriptingAvailable: true,
    });
  });

  it("does not count a duplicate-id rejection as an error", async () => {
    const { send } = load(
      async () => {
        throw new Error("Duplicate script ID 'cupertino-net-hook'");
      },
      { registered: ["cupertino-net-hook"] },
    );
    expect(await send({ kind: "netDiag" })).toMatchObject({ error: null });
  });

  it("says so when the scripting API is missing", async () => {
    const { send } = load(async () => {}, { scripting: false });
    const out = (await send({ kind: "netDiag" })) as {
      registered: string[];
      error: string | null;
      scriptingAvailable: boolean;
    };
    expect(out.scriptingAvailable).toBe(false);
    expect(out.registered).toEqual([]);
    expect(out.error).toEqual(expect.any(String));
  });

  it("bounds the wait on a registration that never settles", async () => {
    vi.useFakeTimers();
    try {
      const { send } = load(() => new Promise(() => {}), { registered: ["cupertino-net-hook"] });
      const pending = send({ kind: "netDiag" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({
        registered: ["cupertino-net-hook"],
        error: "registerContentScripts did not settle within 3s",
        scriptingAvailable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the listing too", async () => {
    vi.useFakeTimers();
    try {
      const { send } = load(async () => {}, { hangList: true });
      const pending = send({ kind: "netDiag" });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({
        registered: [],
        error: "getRegisteredContentScripts did not settle within 3s",
        scriptingAvailable: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is never forwarded to native", async () => {
    const { send, sendNativeMessage } = load(async () => {});
    await send({ kind: "netDiag" });
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });
});
