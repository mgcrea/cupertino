import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The content script's CAPTURE TIMING, executed.
 *
 * `content-script.test.ts` covers `actions.js`, whose functions are pure. This
 * file exists for the opposite reason: what is worth pinning about `capture()`
 * is not what it extracts but WHEN it runs, and that is all side effect —
 * timers, a `MutationObserver`, and a route change.
 *
 * The bug it was written for: a single-page app has rendered nothing at
 * `document_idle`, so the only capture of x.com was its pre-boot shell — an
 * empty `<title>`, a loading placeholder, and the static "Something went wrong"
 * block X ships in every response. The store is keyed by URL, so that snapshot
 * was then the permanent answer for that page, and no amount of waiting before
 * `read_page` could improve it.
 *
 * So `content.js` runs in a `node:vm` against a DOM stub whose content the test
 * can change, and a clock the test advances by hand. Real time is never waited
 * on; every assertion below is about ordering.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/content.js", import.meta.url),
  ),
  "utf8",
);

type Capture = { kind: string; url: string; title: string; text: string; html: string };

/**
 * Evaluate content.js against a stub page.
 *
 * The stub is only as rich as the script actually is: `readableText` clones the
 * body, strips a few tags and reads `innerText`, so a clone that answers
 * `querySelectorAll` with nothing and carries the text is enough.
 */
const boot = (initial: { title: string; text: string }) => {
  const page = { title: initial.title, text: initial.text, href: "https://x.com/i/article/1" };
  const captures: Capture[] = [];
  const observers: (() => void)[] = [];

  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const setTimeoutStub = (fn: () => void, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: now + (ms || 0), fn });
    return id;
  };
  const clearTimeoutStub = (id: number) => void timers.delete(id);

  /** Run every timer due within `ms`, in time order, as a real clock would. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };

  const clone = {
    querySelectorAll: () => [] as unknown[],
    get innerText() {
      return page.text;
    },
  };

  const history: Record<string, unknown> = { pushState: () => {} };

  const context = createContext({
    browser: {
      runtime: {
        getManifest: () => ({ version: "1.19.0" }),
        sendMessage: (message: Capture) => {
          if (message.kind === "capture") captures.push(message);
          return Promise.resolve({ commands: [] });
        },
      },
    },
    document: {
      get title() {
        return page.title;
      },
      body: { cloneNode: () => clone },
      documentElement: {
        get outerHTML() {
          return `<html><title>${page.title}</title><body>${page.text}</body></html>`;
        },
      },
      hidden: false,
    },
    location: {
      get href() {
        return page.href;
      },
    },
    history,
    MutationObserver: class {
      readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        observers.push(this.cb);
      }
      disconnect() {
        const i = observers.indexOf(this.cb);
        if (i !== -1) observers.splice(i, 1);
      }
    },
    addEventListener: () => {},
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    window: {} as Record<string, unknown>,
  });

  runInContext(SOURCE, context);

  return {
    captures,
    advance,
    /** Change what the page says, and tell anyone observing that it changed. */
    render(next: Partial<{ title: string; text: string }>) {
      Object.assign(page, next);
      for (const cb of observers.slice()) cb();
    },
    /** A single-page app route change: new URL, then pushState. */
    navigate(href: string) {
      page.href = href;
      (history.pushState as () => void)();
    },
  };
};

/** X's pre-boot shell, as it was actually captured. */
const SHELL = {
  title: "",
  text:
    "Something went wrong, but don’t fret — let’s give it another shot.\nTry again" +
    "⚠️ Some privacy related extensions may cause issues on x.com.",
};
const HYDRATED = { title: "Olivier (@mgcrea) / X", text: "The actual article body." };

describe("capture timing", () => {
  it("captures immediately, so a server-rendered page needs no wait", () => {
    const page = boot({ title: "Hacker News", text: "Top stories" });
    expect(page.captures).toHaveLength(1);
    expect(page.captures[0]!.text).toBe("Top stories");
  });

  /**
   * The regression. Before the settle watcher this was the ONLY capture the
   * page ever produced, and `read_page` returned X's shell for as long as the
   * tab stayed open.
   */
  it("captures again once a single-page app has rendered", () => {
    const page = boot(SHELL);
    expect(page.captures[0]!.text).toContain("Something went wrong");

    page.advance(300);
    page.render(HYDRATED);
    page.advance(2000);

    expect(page.captures.length).toBeGreaterThan(1);
    const last = page.captures.at(-1)!;
    expect(last.text).toBe(HYDRATED.text);
    expect(last.title).toBe(HYDRATED.title);
  });

  /**
   * A live timeline — video, ads, ticking timestamps — never goes quiet, so a
   * debounce on its own would wait forever on exactly the pages this is for.
   */
  it("captures at the deadline on a page that never stops changing", () => {
    const page = boot(SHELL);
    page.advance(300);
    page.render(HYDRATED);
    for (let i = 0; i < 40; i++) {
      page.advance(200);
      page.render({ text: `${HYDRATED.text} ${i}` });
    }

    expect(page.captures.length).toBeGreaterThan(1);
    expect(page.captures.at(-1)!.text).toContain(HYDRATED.text);
  });

  /** A settle capture identical to the stored one is a round trip for nothing. */
  it("does not resend a page that never changed", () => {
    const page = boot({ title: "Hacker News", text: "Top stories" });
    page.advance(30_000);
    expect(page.captures).toHaveLength(1);
  });

  it("captures the new route after an in-app navigation, once it has rendered", () => {
    const page = boot({ title: "Olivier (@mgcrea) / X", text: "profile" });
    page.advance(10_000);

    page.navigate("https://x.com/mgcrea/status/2097319903967539446");
    page.render({ title: "Olivier on X", text: "the post body" });
    page.advance(2000);

    const last = page.captures.at(-1)!;
    expect(last.url).toBe("https://x.com/mgcrea/status/2097319903967539446");
    expect(last.text).toBe("the post body");
  });
});
