import { describe, expect, it } from "vitest";

import { answeringDiagnosis, type Heartbeat, type HeartbeatStatus } from "../src/client/pages.js";

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
    expect(text).toContain("half a minute");
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
