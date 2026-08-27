import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { describe, expect, it, vi } from "vitest";

import { COMPOSER_ACCESS } from "../src/client/jxa/write.js";
import { AppleMailClient } from "../src/client/mail.js";
import { loadConfig } from "../src/config.js";

/**
 * The two composer permissions, which nothing else in diagnostics reveals.
 *
 * Worth its own file: these are the grants that can be missing while
 * Automation-to-Mail and Full Disk Access both read as granted and every read
 * tool works. The report has to name them rather than let them surface as a
 * `COMPOSER_NOT_FOUND` on a window that is demonstrably on screen.
 */
const clientWith = (run: OsascriptRunner["run"]) =>
  new AppleMailClient({
    config: loadConfig({ APPLE_MAIL_ALLOW_WRITES: "1" }),
    osascript: { run } as OsascriptRunner,
  });

describe("composerAccess()", () => {
  it("passes both grants through when the probe answers", async () => {
    const client = clientWith(
      vi.fn(async () => ({
        accessibility: "granted",
        systemEvents: "granted",
      })) as OsascriptRunner["run"],
    );
    await expect(client.composerAccess()).resolves.toEqual({
      accessibility: "granted",
      systemEvents: "granted",
    });
  });

  // The whole point of two axes: a denied Accessibility and a denied
  // Automation-to-System-Events look identical at the call site, because
  // `prop()` swallows the exception and yields `[]` either way.
  it("distinguishes a denied Accessibility from a denied System Events", async () => {
    const axDenied = clientWith(
      vi.fn(async () => ({
        accessibility: "denied",
        systemEvents: "granted",
      })) as OsascriptRunner["run"],
    );
    await expect(axDenied.composerAccess()).resolves.toMatchObject({ accessibility: "denied" });

    const seDenied = clientWith(
      vi.fn(async () => ({
        accessibility: "granted",
        systemEvents: "denied",
      })) as OsascriptRunner["run"],
    );
    await expect(seDenied.composerAccess()).resolves.toMatchObject({ systemEvents: "denied" });
  });

  // A probe that cannot answer must not be the reason the whole report fails —
  // diagnostics is what someone reaches for when things are already broken.
  it("reports unknown rather than throwing when the probe fails", async () => {
    const client = clientWith(
      vi.fn(async () => {
        throw new Error("osascript exploded");
      }) as OsascriptRunner["run"],
    );
    await expect(client.composerAccess()).resolves.toEqual({
      accessibility: "unknown",
      systemEvents: "unknown",
      uiRead: "unknown",
      windows: null,
    });
  });

  /**
   * The flag and the measurement, kept apart.
   *
   * MEASURED on macOS 26.6: Cupertino.app's own process answered
   * `AXIsProcessTrusted` true while an `osascript` grandchild of it answered
   * false — a green Accessibility row in the app's own Settings beside a reply
   * that failed every time. The identifier held four separate Accessibility
   * entries, one per path and signature it had been granted at, and the two
   * checks matched different ones. So the probe reports what it could actually
   * read as well as what it was told, and `uiRead` is the one to believe.
   */
  it("reports what it could actually read, not only what the flag claims", async () => {
    const disagreeing = clientWith(
      vi.fn(async () => ({
        accessibility: "denied",
        systemEvents: "granted",
        uiRead: "granted",
        windows: ["Re: original", "Inbox"],
      })) as OsascriptRunner["run"],
    );
    await expect(disagreeing.composerAccess()).resolves.toMatchObject({
      accessibility: "denied",
      uiRead: "granted",
    });
  });

  // Mail closed down to the menu bar has no windows to name, and that is not
  // evidence of a missing grant. Reporting it as denied would send someone to
  // fix a permission that is already correct.
  it("calls an empty window list inconclusive rather than denied", () => {
    expect(COMPOSER_ACCESS).toContain("inconclusive");
  });

  it("asks the current process, without requiring Mail", () => {
    // Not wrapped in `script()`: that gates on Mail running, and neither grant
    // depends on any app being up.
    expect(COMPOSER_ACCESS).toContain("AXIsProcessTrusted");
    expect(COMPOSER_ACCESS).toContain("System Events");
    expect(COMPOSER_ACCESS).not.toContain("isMailRunning");
    // -1743 is errAEEventNotPermitted: the code that means "denied", as
    // opposed to any other scripting failure.
    expect(COMPOSER_ACCESS).toContain("-1743");
    // The runner unwraps `{ ok, data }`; the probe has to speak that envelope.
    expect(COMPOSER_ACCESS).toContain("ok: true");
  });
});
