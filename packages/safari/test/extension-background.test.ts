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

function load(native: (...args: unknown[]) => Promise<unknown> = async () => "native-reply") {
  const sendNativeMessage = vi.fn(native);
  const registerContentScripts = vi.fn(async () => {});
  const lifecycle: string[] = [];
  const messageListeners: ((message: unknown) => Promise<unknown>)[] = [];
  const errors: unknown[][] = [];
  const hook = (name: string) => ({ addListener: () => void lifecycle.push(name) });
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
      scripting: { registerContentScripts, getRegisteredContentScripts: async () => [] },
    },
    console: { error: (...args: unknown[]) => errors.push(args) },
  });
  runInContext(SOURCE, context);
  const send = (message: unknown) => messageListeners[0]!(message);
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
