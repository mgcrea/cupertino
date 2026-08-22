import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertStaticScript } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import * as write from "../src/client/jxa/write.js";

/**
 * The write lane is one string, and nothing else in the toolchain looks inside
 * it. Here a typo is more expensive than anywhere else in this repo: the script
 * runs against a live Messages, and the thing it does is send something to
 * another human being.
 */
const SCRIPTS = Object.entries(write).filter(([, v]) => typeof v === "string") as [
  string,
  string,
][];

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "jxa");

describe("JXA scripts", () => {
  /** One verb, because the dictionary has one that is safe to expose. */
  it("found exactly one script", () => {
    expect(SCRIPTS.map(([name]) => name)).toEqual(["SEND_MESSAGE"]);
  });

  it.each(SCRIPTS)("%s passes the interpolation tripwire", (_name, source) => {
    expect(source).not.toContain("${");
    expect(() => assertStaticScript(source)).not.toThrow();
  });

  it.each(SCRIPTS)("%s declares the envelope contract", (_name, source) => {
    expect(source).toContain("function run(argv)");
    expect(source).toContain("JSON.parse(argv[0]");
  });

  // osacompile only exists on macOS; the rest of the suite is portable.
  it.skipIf(process.platform !== "darwin").each(SCRIPTS)("%s compiles", (name, source) => {
    const dir = mkdtempSync(join(tmpdir(), "messages-jxa-"));
    const file = join(dir, `${name}.js`);
    writeFileSync(file, source);
    expect(() =>
      execFileSync(
        "/usr/bin/osacompile",
        ["-l", "JavaScript", "-o", join(dir, `${name}.scpt`), file],
        { stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  /**
   * `com.apple.MobileSMS`, not `com.apple.Messages`, which does not exist.
   * Messages.app kept the bundle id it shipped with as the SMS app — the same
   * display-name / bundle-id mismatch as Calendar's `com.apple.iCal`, and a trap
   * this repo has already been caught by once.
   */
  it("targets the right bundle id", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).toContain("com.apple.MobileSMS");
      expect(source).not.toContain("com.apple.Messages");
    }
  });

  /**
   * There is no read lane and there cannot be one. `docs/messages.md` measured
   * every read through this dictionary failing — Messages answers "Application
   * isn't running" while it is running, because it is a windowless background
   * process that declines to wake for a script. This is what stops a read path
   * being re-added here out of helpfulness.
   */
  it("has no read.ts", () => {
    expect(existsSync(join(SRC, "read.ts"))).toBe(false);
  });

  /**
   * The dictionary's other two commands, both deliberately unshipped. `logout`
   * would sign the user out of iMessage on every device they own, from a tool
   * call, with no way back except their Apple account password.
   */
  it("never logs the user in or out", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).not.toMatch(/\.login\(/);
      expect(source).not.toMatch(/\.logout\(/);
    }
  });

  /**
   * `send`'s direct parameter is typed `file` OR `text` in the dictionary, and
   * only the text form ships. A tool that hands an arbitrary local path to a
   * remote person is an exfiltration primitive whose blast radius, unlike the
   * text form's, is not bounded by what the model can say. Shipping it has to
   * break this test first.
   */
  it("never sends a file", () => {
    for (const [, source] of SCRIPTS) expect(source).not.toContain("Path(");
  });

  /**
   * `whose` is allowed here and nowhere else, and only on `accounts` — a list of
   * one or two. It is banned on the collections that are large and on the ones
   * this app refuses to enumerate at all: `chats` is addressed by id, which is
   * the entire reason the file lane picks the target.
   */
  it("never filters chats or messages with whose()", () => {
    for (const [, source] of SCRIPTS) {
      expect(source).not.toContain("chats.whose(");
      expect(source).not.toContain("messages.whose(");
    }
  });

  /**
   * The send must be addressable before it is attempted. A script that called
   * `send` outside the resolved-target branch could deliver to whatever the
   * dictionary picked by default, which on this surface is nobody's idea of a
   * safe fallback.
   */
  it("resolves a target before it sends", () => {
    for (const [, source] of SCRIPTS) {
      expect(source.indexOf("resolveTarget(")).toBeLessThan(source.indexOf("M.send("));
      expect(source).toContain("SEND_TARGET_NOT_FOUND");
    }
  });
});
