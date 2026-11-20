import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  answeringDiagnosis,
  lostPolls,
  type Heartbeat,
  type HeartbeatStatus,
} from "../src/client/pages.js";

/**
 * What a timeout says, read against heartbeats and the moment the command went
 * out.
 *
 * Seen 2026-10-28: bing.com set to Deny in Safari, the tab reloaded, and the
 * first timeout still said "The extension is running on https://www.bing.com
 * right now, so it is allowed there". The last heartbeat from before the Deny
 * was inside the 30-second window, and a 12-second wait is shorter than that.
 * Switching the extension off had the same window. What settles it is whether
 * a page polled DURING the wait, which a running one does: a hidden tab every
 * ten seconds.
 */
const SENT = Date.parse("2026-10-28T14:44:00Z");

const beat = (origin: string, secondsAfterSend: number, now: number): Heartbeat => {
  const at = SENT + secondsAfterSend * 1000;
  return {
    origin,
    at,
    ageSeconds: Math.round((now - at) / 1000),
    extensionVersion: "1.33.0",
  };
};

const status = (...answering: Heartbeat[]): HeartbeatStatus => ({ supported: true, answering });

describe("a timeout read against when the command was sent", () => {
  const now = SENT + 12_500;
  const wait = { sentAt: SENT, now };

  it("does not call a site allowed when its page stopped polling before the command went out", () => {
    const text = answeringDiagnosis(
      status(beat("https://news.ycombinator.com", 4, now), beat("https://www.bing.com", -3, now)),
      "https://www.bing.com/search?q=x",
      wait,
    );

    expect(text).not.toContain("so it is allowed there");
    expect(text).toContain("https://www.bing.com");
    expect(text).toContain("since this command was sent");
    expect(text).toContain("withdrawn");
    expect(text).toContain("https://news.ycombinator.com");
  });

  it("says the extension just went quiet everywhere when no page polled during the wait", () => {
    const text = answeringDiagnosis(
      status(beat("https://news.ycombinator.com", -2, now), beat("https://www.bing.com", -6, now)),
      "https://news.ycombinator.com/",
      wait,
    );

    expect(text).not.toContain("are answering");
    expect(text).not.toContain("so it is allowed there");
    expect(text).toContain("12 seconds");
    expect(text).toContain("switched off");
    // Not "most likely switched off": seen 2026-11-20, the worker stopped and
    // the message sent the agent to blame a setting nobody had touched.
    expect(text).not.toContain("most likely");
    expect(text).toContain("background worker");
    expect(text).toContain("Reload the tab");
  });

  it("still says the page is there when its site polled during the wait", () => {
    const text = answeringDiagnosis(
      status(beat("https://x.example", 5, now)),
      "https://x.example/a",
      wait,
    );

    expect(text).toContain("is running on https://x.example");
    expect(text).toContain("this exact URL");
  });

  it("counts a poll in the second the command went out, which the handler stamps to the second", () => {
    // ISO8601DateFormatter writes no fraction: a poll 0.4 s after the send
    // reads back as the whole second it fell in, before the send.
    const sentMidSecond = { sentAt: SENT + 600, now: SENT + 13_000 };
    const text = answeringDiagnosis(
      status(beat("https://x.example", 0, sentMidSecond.now)),
      "https://x.example/a",
      sentMidSecond,
    );

    expect(text).toContain("is running on https://x.example");
  });

  it("concludes nothing from timing when the wait was too short for a hidden tab to poll", () => {
    const short = { sentAt: SENT, now: SENT + 1_200 };
    const text = answeringDiagnosis(
      status(beat("https://x.example", -3, short.now)),
      "https://x.example/a",
      short,
    );

    expect(text).toContain("is running on https://x.example");
  });
});

/**
 * A capture that landed after its site's polls stopped.
 *
 * Seen 2026-11-07 and 2026-11-20: Safari stopped the extension's background
 * worker and the pages' polls stopped reaching the handler, while a page that
 * loaded still got its capture through. A capture travels the same worker to
 * the same handler as a poll, so one landing well after its site's last poll
 * says the extension is on and the worker was relaying at that moment: the
 * page that sent it polls straight after, and its polls are what went missing.
 */
describe("a timeout after a site's polls were lost", () => {
  const now = SENT + 12_500;
  const wait = { sentAt: SENT, now };
  const lost = { origin: "https://en.geneanet.org", capturedAt: SENT - 40_000 };

  it("says the extension is on and its polls are not getting through", () => {
    const text = answeringDiagnosis(
      status(),
      "https://en.geneanet.org/fonds/individus/",
      wait,
      lost,
    );

    expect(text).toContain("The extension is on");
    expect(text).toContain("https://en.geneanet.org was captured 53 seconds ago");
    expect(text).toContain("background worker");
    expect(text).toContain("Reload the tab");
    expect(text).not.toContain("switched off");
    expect(text).not.toContain("second Cupertino row");
  });

  it("says the same when the site stopped polling inside the answering window", () => {
    const text = answeringDiagnosis(
      status(beat("https://en.geneanet.org", -17, now)),
      "https://en.geneanet.org/fonds/individus/",
      wait,
      { origin: "https://en.geneanet.org", capturedAt: SENT - 1_000 },
    );

    expect(text).toContain("The extension is on");
    expect(text).not.toContain("switched off");
  });

  it("names every cause it cannot tell apart when no capture came after the polls", () => {
    // 2026-11-20 09:39:50: the page loaded, captured and polled in one burst,
    // then everything stopped. That is also what switching it off looks like.
    const text = answeringDiagnosis(
      status(),
      "https://en.geneanet.org/fonds/individus/",
      wait,
      null,
    );

    expect(text).not.toContain("The extension is on");
    expect(text).toContain("switched off");
    expect(text).toContain("background worker");
    expect(text).toContain("Reload the tab");
  });

  it("concludes nothing from it while some page polled during the wait", () => {
    const text = answeringDiagnosis(
      status(beat("https://x.example", 5, now)),
      "https://en.geneanet.org/fonds/individus/",
      wait,
      lost,
    );

    expect(text).not.toContain("The extension is on");
  });

  it("concludes nothing from it over a wait too short for a hidden tab to poll", () => {
    const short = { sentAt: SENT, now: SENT + 2_500 };
    const text = answeringDiagnosis(
      status(),
      "https://en.geneanet.org/fonds/individus/",
      short,
      lost,
    );

    expect(text).not.toContain("The extension is on");
  });
});

/** The container as the handler leaves it: `pages/` and `heartbeat/` side by side. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const iso = (secondsAfterSend: number) =>
  new Date(SENT + secondsAfterSend * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const container = (
  captures: Record<string, number>,
  heartbeats: Record<string, number> | null,
): string => {
  const root = mkdtempSync(join(tmpdir(), "safari-lost-polls-"));
  dirs.push(root);
  const pages = join(root, "pages");
  mkdirSync(pages);
  for (const [url, at] of Object.entries(captures)) {
    writeFileSync(
      join(pages, `${sha(url)}.json`),
      JSON.stringify({ url, title: "", capturedAt: iso(at), text: "", html: "" }),
    );
  }
  if (heartbeats !== null) {
    mkdirSync(join(root, "heartbeat"));
    for (const [origin, at] of Object.entries(heartbeats)) {
      writeFileSync(
        join(root, "heartbeat", `${sha(origin)}.json`),
        JSON.stringify({ origin, at: iso(at), extensionVersion: "1.40.0" }),
      );
    }
  }
  return pages;
};

describe("finding a capture that landed after its site's last poll", () => {
  it("finds one more than 15 s after its own origin's last heartbeat", () => {
    const pages = container(
      { "https://en.geneanet.org/fonds/individus/": -40 },
      { "https://en.geneanet.org": -90 },
    );

    expect(lostPolls(pages)).toEqual({
      origin: "https://en.geneanet.org",
      capturedAt: SENT - 40_000,
    });
  });

  it("finds none 15 s or less after it, which a hidden tab still polling can produce", () => {
    const pages = container(
      { "https://en.geneanet.org/fonds/individus/": -75 },
      { "https://en.geneanet.org": -90 },
    );

    expect(lostPolls(pages)).toBeNull();
  });

  it("finds one at 16 s", () => {
    const pages = container(
      { "https://en.geneanet.org/fonds/individus/": -74 },
      { "https://en.geneanet.org": -90 },
    );

    expect(lostPolls(pages)?.origin).toBe("https://en.geneanet.org");
  });

  it("sets a capture against its own site's poll, not the newest anywhere", () => {
    // Geneanet polled until -90; another site until -10. Against the newest
    // poll anywhere the geneanet capture at -40 would look fine.
    const pages = container(
      { "https://en.geneanet.org/fonds/individus/": -40 },
      { "https://en.geneanet.org": -90, "https://www.bing.com": -10 },
    );

    expect(lostPolls(pages)?.origin).toBe("https://en.geneanet.org");
  });

  it("ignores a page whose site never stamped a heartbeat, such as a file: page", () => {
    // A null origin captures but is never stamped, so it would look like lost
    // polls against any other site's old heartbeat.
    const pages = container(
      { "file:///Users/someone/page.html": -5, "https://other.example/": -6 },
      { "https://www.bing.com": -90 },
    );

    expect(lostPolls(pages)).toBeNull();
  });

  it("finds none from an extension that writes no heartbeats", () => {
    const pages = container({ "https://en.geneanet.org/": -5 }, null);

    expect(lostPolls(pages)).toBeNull();
  });
});

describe("a site with no fresh heartbeat while others answer", () => {
  it("names an update as a reason the tab needs reloading", () => {
    const now = SENT + 12_500;
    const text = answeringDiagnosis(
      status(beat("https://www.bing.com", 5, now)),
      "https://news.ycombinator.com/",
    );

    expect(text).toContain("not on https://news.ycombinator.com");
    expect(text).toContain("updated");
  });
});
