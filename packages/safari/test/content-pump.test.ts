import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The command pump's rescheduling, EXECUTED.
 *
 * `content.js` polls the background for commands. After a poll that returned
 * work the next poll must be immediate, or a multi-step flow (click, then
 * read) pays the full interval between steps. After an empty poll it must go
 * back to the interval. The file's capture block runs first and touches the
 * DOM, so it is given inert stubs; the timer stub records only the pump's own
 * reschedules, identified by `cupertinoPumpNow`, which is the same function.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/content.js", import.meta.url),
  ),
  "utf8",
);

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("content.js pump", () => {
  it("re-polls immediately after a command, then returns to the interval", async () => {
    const polls: Array<{ commands: Array<{ id: string }> }> = [
      { commands: [{ id: "c1" }] },
      { commands: [] },
      { commands: [] },
    ];
    const delays: number[] = [];
    const ran: string[] = [];
    const context: Record<string, any> = {
      browser: {
        runtime: {
          getManifest: () => ({ version: "1.0.0" }),
          sendMessage: async (message: { kind: string }) =>
            message.kind === "poll" ? polls.shift() : undefined,
        },
      },
      setTimeout: (fn: unknown, delay: number) => {
        if (fn === context.cupertinoPumpNow) delays.push(delay);
        return 0;
      },
      clearTimeout: () => {},
      addEventListener: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: {
        hidden: false,
        title: "",
        documentElement: { outerHTML: "" },
      },
      history: { pushState: () => {} },
      location: { href: "https://app.example.com/" },
      cupertinoRunCommand: (command: { id: string }) => {
        ran.push(command.id);
        return { ok: true };
      },
    };
    context.window = context;
    createContext(context);
    runInContext(SOURCE, context);
    await flush();
    expect(ran).toEqual(["c1"]);
    expect(delays).toEqual([0]);

    context.cupertinoPumpNow();
    await flush();
    expect(delays).toEqual([0, 1000]);
  });
});
