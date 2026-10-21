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

function load(register: (scripts: unknown[]) => Promise<void>) {
  const registerContentScripts = vi.fn(register);
  const listeners: Record<string, () => void> = {};
  const errors: unknown[][] = [];
  const hook = (name: string) => ({
    addListener: (fn: () => void) => {
      listeners[name] = fn;
    },
  });
  const context = createContext({
    browser: {
      runtime: {
        onMessage: { addListener: () => {} },
        onInstalled: hook("installed"),
        onStartup: hook("startup"),
        sendNativeMessage: async () => undefined,
      },
      scripting: { registerContentScripts },
    },
    console: { error: (...args: unknown[]) => errors.push(args) },
  });
  runInContext(SOURCE, context);
  return { registerContentScripts, listeners, errors };
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
});
