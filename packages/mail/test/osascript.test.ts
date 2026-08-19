import { describe, expect, it, vi } from "vitest";

import {
  MailBusyError,
  MailNotRunningError,
  PlatformError,
  ProtocolError,
  TccDeniedError,
} from "../src/client/errors.js";
import { LIST_ACCOUNTS, LIST_RECENT } from "../src/client/jxa/read.js";
import {
  assertStaticScript,
  createOsascriptRunner,
  mapOsaError,
  withBusyRetry,
} from "../src/client/osascript.js";

/**
 * These tests are the ones that keep the injection guarantee honest. They
 * assert on the *arguments* rather than on script text, because "the payload
 * reached argv[0] and the script was byte-identical to the constant" is exactly
 * the property that makes a shell metacharacter in a mailbox name harmless.
 */

const PAYLOAD = '"; do shell script "touch /tmp/pwned"; //';

describe("assertStaticScript", () => {
  it("accepts the real scripts", () => {
    expect(() => assertStaticScript(LIST_ACCOUNTS)).not.toThrow();
    expect(() => assertStaticScript(LIST_RECENT)).not.toThrow();
  });

  it("rejects a script built by interpolation", () => {
    // The tripwire: someone reaching for a template literal instead of params.
    const interpolated = `function run() { return ${"$"}{userInput} }`;
    expect(() => assertStaticScript(interpolated)).toThrow(PlatformError);
  });
});

describe("mapOsaError", () => {
  it.each([
    ["execution error: Not authorized to send Apple events to Mail. (-1743)", TccDeniedError],
    ["execution error: Application isn't running. (-600)", MailNotRunningError],
    ["execution error: Apple event timed out. (-1712)", MailBusyError],
    ["execution error: Error: boom (-2700)", ProtocolError],
  ])("maps %s", (stderr, expected) => {
    expect(mapOsaError(stderr, 1000)).toBeInstanceOf(expected);
  });

  it("keeps the thrown message when the script itself failed", () => {
    const err = mapOsaError("execution error: Error: no such mailbox (-2700)", 1000);
    expect(err.message).toContain("no such mailbox");
  });
});

/** Substitute only the process boundary; the real run() pipeline still executes. */
const withStdout = (stdout: string) => {
  const calls: { path: string; args: string[]; script: string }[] = [];
  const exec = vi.fn(async (path: string, args: string[], script: string) => {
    calls.push({ path, args, script });
    return stdout;
  });
  const runner = createOsascriptRunner({
    osascriptPath: "/usr/bin/osascript",
    timeoutMs: 1000,
    exec,
  });
  return { runner, calls, exec };
};

describe("runner", () => {
  it("passes params as JSON in argv, never into script text", async () => {
    const { runner, calls } = withStdout(JSON.stringify({ ok: true, data: [] }));
    await runner.run(LIST_RECENT, { accountUuid: "u", mailbox: PAYLOAD, limit: 5 });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // osascript reads the program from stdin (`-`); params follow as argv.
    expect(call!.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-"]);
    // The payload travelled as data...
    expect(JSON.parse(call!.args[3]!)).toMatchObject({ mailbox: PAYLOAD });
    // ...and the script is byte-identical to the constant, so it cannot have
    // been interpolated into.
    expect(call!.script).toBe(LIST_RECENT);
    expect(call!.script).not.toContain("do shell script");
  });

  it("unwraps the ok envelope", async () => {
    const { runner } = withStdout(JSON.stringify({ ok: true, data: { total: 3 } }));
    await expect(runner.run(LIST_ACCOUNTS)).resolves.toEqual({ total: 3 });
  });

  it("re-inflates application-level failures that arrived on exit 0", async () => {
    const notRunning = withStdout(
      JSON.stringify({ ok: false, error: { code: "MAIL_NOT_RUNNING", message: "x" } }),
    );
    await expect(notRunning.runner.run(LIST_ACCOUNTS)).rejects.toBeInstanceOf(MailNotRunningError);

    const denied = withStdout(
      JSON.stringify({ ok: false, error: { code: "NOT_AUTHORIZED", message: "x" } }),
    );
    await expect(denied.runner.run(LIST_ACCOUNTS)).rejects.toBeInstanceOf(TccDeniedError);
  });

  it("rejects non-JSON output rather than returning it", async () => {
    const { runner } = withStdout("not json at all");
    await expect(runner.run(LIST_ACCOUNTS)).rejects.toBeInstanceOf(ProtocolError);
  });

  it("serialises calls, because Mail's event dispatch is single-threaded", async () => {
    let active = 0;
    let maxActive = 0;
    const exec = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return JSON.stringify({ ok: true, data: null });
    });
    const runner = createOsascriptRunner({
      osascriptPath: "/usr/bin/osascript",
      timeoutMs: 1000,
      exec,
    });

    await Promise.all([1, 2, 3, 4].map(() => runner.run(LIST_ACCOUNTS)));
    expect(exec).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(1);
  });

  it("keeps the queue moving after a failure", async () => {
    let call = 0;
    const exec = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return JSON.stringify({ ok: true, data: "second" });
    });
    const runner = createOsascriptRunner({
      osascriptPath: "/usr/bin/osascript",
      timeoutMs: 1000,
      exec,
    });

    await expect(runner.run(LIST_ACCOUNTS)).rejects.toThrow("boom");
    await expect(runner.run(LIST_ACCOUNTS)).resolves.toBe("second");
  });
});

describe("withBusyRetry", () => {
  it("retries once when Mail says it is busy", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new MailBusyError())
      .mockResolvedValueOnce("ok");
    await expect(withBusyRetry(fn, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry other failures", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new TccDeniedError());
    await expect(withBusyRetry(fn, 0)).rejects.toBeInstanceOf(TccDeniedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
