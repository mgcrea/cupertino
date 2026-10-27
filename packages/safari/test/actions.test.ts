import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

/**
 * The action lane, stood up against a FAKE EXTENSION.
 *
 * The real one is JavaScript inside Safari, reachable only from a notarized
 * build, so what can be tested here is precisely the contract between the two:
 * what the server writes into `commands/`, what it expects back in `results/`,
 * and what it does when nothing answers. That last one is the case a user will
 * actually hit — the extension not allowed on that site — so it gets the most
 * attention.
 *
 * `pages/` is pointed at a temp directory, which is also what keeps this suite
 * away from the developer's real extension container.
 */

let root: string;

const paths = () => {
  root = mkdtempSync(join(tmpdir(), "safari-actions-"));
  const pages = join(root, "pages");
  mkdirSync(pages, { recursive: true });
  return { pages, commands: join(root, "commands"), results: join(root, "results") };
};

const fakeOsascript: OsascriptRunner = {
  run: async <T>(): Promise<T> => ({ entries: [], folders: 0, depthTruncated: false }) as T,
};

const connect = async (
  pages: string,
  env: NodeJS.ProcessEnv = {},
  osascript: OsascriptRunner = fakeOsascript,
) => {
  const config: Config = loadConfig({
    APPLE_SAFARI_INDEX_MODE: "off",
    APPLE_SAFARI_PAGES: pages,
    APPLE_SAFARI_ALLOW_WRITES: "true",
    // Short, so the timeout test does not sit for twelve seconds.
    APPLE_SAFARI_ACTION_TIMEOUT_MS: "1200",
    ...env,
  });
  const { server } = createServer({ config, home: "/nonexistent-home", osascript });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = res.content.map((c) => c.text).join("");
  return { isError: Boolean(res.isError), text, json: () => JSON.parse(text) as never };
};

/**
 * Stand in for the content script: claim whatever command appears, and answer
 * it. Claiming by DELETION, exactly as the native handler does — a fake that
 * left the command in place would not exercise the at-most-once property the
 * real one depends on.
 */
const fakeExtension = (
  dirs: { commands: string; results: string },
  reply: (command: Record<string, unknown>) => { ok: boolean; data?: unknown; error?: string },
) => {
  const seen: Record<string, unknown>[] = [];
  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = readdirSync(dirs.commands).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of files) {
      const file = join(dirs.commands, name);
      const command = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      seen.push(command);
      rmSync(file, { force: true });
      mkdirSync(dirs.results, { recursive: true });
      writeFileSync(
        join(dirs.results, `${String(command.id)}.json`),
        JSON.stringify({
          id: command.id,
          completedAt: new Date().toISOString(),
          ...reply(command),
        }),
      );
    }
  }, 10);
  return { seen, stop: () => clearInterval(timer) };
};

/**
 * A capture as the extension writes one, stamped with the build that wrote it.
 * Named by the SHA-256 of the URL, which is how the appex keys these files.
 */
const capture = (
  pages: string,
  url: string,
  extensionVersion: string | null,
  capturedAt = new Date().toISOString(),
) => {
  const entry = {
    url,
    title: "Old",
    capturedAt,
    text: "",
    html: "",
    textTruncated: false,
    htmlTruncated: false,
    ...(extensionVersion === null ? {} : { extensionVersion }),
  };
  writeFileSync(
    join(pages, `${createHash("sha256").update(url).digest("hex")}.json`),
    JSON.stringify(entry),
  );
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

let running: { stop: () => void } | null = null;
afterEach(() => {
  running?.stop();
  running = null;
});

describe("apple_safari_click", () => {
  it("sends the page a command naming the element, and returns what happened", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({
      ok: true,
      data: { clicked: "3f9a2c1d-e7", label: "Sign in", kind: "button" },
    }));
    running = ext;

    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://example.com/",
      elementId: "3f9a2c1d-e7",
    });

    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ clicked: "3f9a2c1d-e7", label: "Sign in" });
    expect(ext.seen[0]).toMatchObject({
      action: "click",
      url: "https://example.com/",
      elementId: "3f9a2c1d-e7",
      // The page load the id came from, which is what the handler routes on.
      page: "3f9a2c1d",
    });
    // The expiry is what stops a command running minutes after the caller gave
    // up, so it must actually be set rather than defaulted away.
    expect(typeof ext.seen[0]?.expiresAt).toBe("number");
  });

  /**
   * A click that navigated invalidates every id the caller is holding. Saying
   * so on every click is deliberate: the alternative is a caller that reuses an
   * id after a navigation, and on the other side that is an error rather than a
   * wrong click — but only because the ids die. The note is what stops the
   * caller treating a dead id as a bug worth retrying.
   */
  it("always warns that ids may now be stale", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({ ok: true, data: { clicked: "3f9a2c1d-e1" } }));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });
    expect(r.text).toContain("dead");
  });

  it("reports the page's own refusal rather than inventing one", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({
      ok: false,
      error: 'No element "3f9a2c1d-e9" on this page.',
    }));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e9",
    });
    expect(r.isError).toBe(true);
    // Parsed rather than matched as text: the tool renders JSON, so the quotes
    // in the page's own message arrive escaped and a substring check on the raw
    // output tests the serializer instead of the behaviour.
    expect((r.json() as { error: string }).error).toContain('No element "3f9a2c1d-e9"');
  });
});

/**
 * The wrong-tab click, from the server's side.
 *
 * Ids were `e12` alone, counted from 1 in every tab, and a command found its
 * tab by URL — so with two tabs on one URL, a click minted from tab A's
 * enumeration could run on tab B's `e12`. The id now names its page load, and
 * the server puts that token on the command for the handler to route by. The
 * other half — the page refusing a token that is not its own — is executed
 * against the real content script in `content-script.test.ts`.
 */
describe("page-addressed commands", () => {
  it("puts the id's page token on a fill as well as a click", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { filled: "0badc0de-e3" } }));
    running = ext;
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_fill", {
      url: "https://x.example/",
      elementId: "0badc0de-e3",
      text: "hello",
    });
    expect(ext.seen[0]).toMatchObject({ action: "fill", page: "0badc0de" });
  });

  it("names no page on a command that has no element", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: {} }));
    running = ext;
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_scroll", { url: "https://x.example/" });
    expect(ext.seen[0]).not.toHaveProperty("page");
  });

  /**
   * A bare `e12` is what the old ids looked like and what a caller that
   * invents one writes. It names no page load, so there is no tab it could
   * safely go to — and it must not fall back to "whichever tab polls first",
   * which is the bug.
   */
  it.each(["e12", "12", "3f9a2c1d", "3F9A2C1D-e12", "3f9a2c1d-e12 "])(
    "refuses %j before writing anything",
    async (elementId) => {
      const dirs = paths();
      const ext = fakeExtension(dirs, () => ({ ok: true, data: { clicked: elementId } }));
      running = ext;
      const c = await connect(dirs.pages);
      const r = await call(c, "apple_safari_click", { url: "https://x.example/", elementId });

      expect(r.isError).toBe(true);
      expect((r.json() as { error: string }).error).toContain("not an element id");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ext.seen).toEqual([]);
    },
  );

  /**
   * The likeliest reason nothing claims a page-addressed command is that the
   * load which minted it is gone, and no other tab will take it. Saying so is
   * what keeps a caller from reading the timeout as a permission problem.
   */
  it("says why nothing claimed it when the id's page load has gone", async () => {
    const dirs = paths();
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no other tab");
    expect(r.text).toContain("reloaded");
  });
});

/**
 * The failure a user will actually hit, and the only one this suite can produce
 * faithfully: the extension is not allowed on that website, so nothing polls.
 */
describe("when no page answers", () => {
  it("names all three conditions instead of blaming a permission", async () => {
    const dirs = paths();
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("enabled in Safari");
    expect(r.text).toContain("allowed on this specific website");
    // The thing a caller would otherwise assume, since every other tool here
    // fails for one of these two.
    expect(r.text).not.toContain("Full Disk Access");
    expect(r.text).not.toContain("Automation");
  });

  /**
   * The command must not outlive the call. Left behind, it would be claimed by
   * the next page to poll — a click landing minutes after the caller was told
   * it had not happened, which is the worst outcome this lane can produce.
   */
  it("takes the command back", async () => {
    const dirs = paths();
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_click", { url: "https://x.example/", elementId: "3f9a2c1d-e1" });

    const left = readdirSync(dirs.commands).filter((f) => f.endsWith(".json"));
    expect(left).toEqual([]);
  });
});

/**
 * The fourth cause of silence, and the only one that is nobody's fault.
 *
 * A Sparkle update replaces the appex immediately, but an already-open tab
 * keeps running the content script it loaded before — orphaned from its own
 * runtime, unable to answer a poll or even to capture. From the server that is
 * indistinguishable from "not allowed on this site", and the fix is completely
 * different: reload the tab.
 */
describe("when the tab is running a pre-update content script", () => {
  it("says to reload the tab when the capture predates this build", async () => {
    const dirs = paths();
    capture(dirs.pages, "https://x.example/", "1.4.0");
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("RELOAD");
    expect(r.text).toContain("1.4.0");
  });

  it("treats an unstamped capture as older, because it is", async () => {
    const dirs = paths();
    capture(dirs.pages, "https://x.example/", null);
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });
    expect(r.text).toContain("too old to say which version");
  });

  /**
   * The half that keeps this honest. With no capture there is no evidence, and
   * a guess would send somebody reloading tabs to fix a per-site grant they
   * never gave.
   */
  it("adds nothing when there is no capture to reason from", async () => {
    const dirs = paths();
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });
    expect(r.text).not.toContain("RELOAD");
  });

  it("adds nothing when the capture is from this very build", async () => {
    const dirs = paths();
    const { BUILD_INFO } = await import("../src/build-info.js");
    capture(dirs.pages, "https://x.example/", BUILD_INFO.version);
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_click", {
      url: "https://x.example/",
      elementId: "3f9a2c1d-e1",
    });
    expect(r.text).not.toContain("RELOAD");
  });
});

/**
 * The cause that looks like a missing permission and is not one.
 *
 * Seen 2026-10-09: nothing captured on any site for four hours, the extension
 * still enabled, and every command timing out. Restarting Cupertino did nothing,
 * because the extension runs inside Safari; quitting and reopening Safari, then
 * reloading the tab, brought it back. The site's permission was never the issue,
 * so a timeout that only names permissions sent the search the wrong way.
 */
describe("when the whole lane has gone quiet", () => {
  /**
   * This URL's own capture shows the site was allowed, but only as of when it
   * was taken: a stale capture outlives a lapsed grant or a closed tab, so the
   * advice stays conditional on both.
   */
  it("says the extension is not running, and to reopen Safari, when this page was captured before", async () => {
    const dirs = paths();
    const { BUILD_INFO } = await import("../src/build-info.js");
    capture(dirs.pages, "https://x.example/", BUILD_INFO.version, hoursAgo(4));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("captured 240 minutes ago, so the extension was allowed on it then");
    expect(r.text).toContain("If the tab is open");
    expect(r.text).toContain("240 minutes");
    expect(r.text).toContain("quit and reopen Safari");
    expect(r.text).toContain("restarting Cupertino");
  });

  /**
   * The extension captures only on a page load, so a healthy one allowed site
   * by site goes just as quiet when no allowed page has loaded for a while. With
   * no capture of this URL the permission is not ruled out, and must stay named.
   */
  it("keeps the permission in the running when this page was never captured", async () => {
    const dirs = paths();
    const { BUILD_INFO } = await import("../src/build-info.js");
    capture(dirs.pages, "https://elsewhere.example/", BUILD_INFO.version, hoursAgo(4));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("240 minutes");
    expect(r.text).toContain("allowed on no site loaded since");
    expect(r.text).toContain("If it is allowed on this site");
    expect(r.text).not.toContain("allowed on it,");
  });

  it("adds nothing while another page captured recently", async () => {
    const dirs = paths();
    const { BUILD_INFO } = await import("../src/build-info.js");
    capture(dirs.pages, "https://elsewhere.example/", BUILD_INFO.version);
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("reopen Safari");
  });

  /** The threshold is the extension's own TTL: inside it, the lane is not quiet. */
  it("adds nothing until the newest capture is older than the TTL", async () => {
    const { BUILD_INFO } = await import("../src/build-info.js");
    for (const [minutes, quiet] of [
      [29, false],
      [31, true],
    ] as const) {
      const dirs = paths();
      capture(dirs.pages, "https://x.example/", BUILD_INFO.version, hoursAgo(minutes / 60));
      const c = await connect(dirs.pages);
      const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });
      expect(r.text.includes("reopen Safari")).toBe(quiet);
    }
  });

  /** A failure on this side is not Safari's, and must not send anyone there. */
  it("adds nothing when the command could not even be written", async () => {
    const dirs = paths();
    const { BUILD_INFO } = await import("../src/build-info.js");
    capture(dirs.pages, "https://x.example/", BUILD_INFO.version, hoursAgo(4));
    // A FILE where the command directory should be, so the write fails at once.
    writeFileSync(dirs.commands, "");
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("Could not reach");
    expect(r.text).not.toContain("reopen Safari");
  });

  it("adds nothing when there are no captures at all", async () => {
    const dirs = paths();
    const c = await connect(join(dirname(dirs.pages), "missing"));
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.isError).toBe(true);
    expect(r.text).toContain("No page answered");
    expect(r.text).not.toContain("reopen Safari");
  });

  /** The tab's own evidence is more specific than the lane's, so it wins. */
  it("still says RELOAD when this tab's capture predates the update", async () => {
    const dirs = paths();
    capture(dirs.pages, "https://x.example/", "1.4.0", hoursAgo(4));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });

    expect(r.text).toContain("RELOAD");
    expect(r.text).not.toContain("reopen Safari");
  });
});

describe("apple_safari_page_elements", () => {
  it("works with writes disabled, because enumerating changes nothing", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({
      ok: true,
      data: { elements: [{ id: "3f9a2c1d-e1", kind: "button", label: "Buy" }], truncated: false },
    }));
    const c = await connect(dirs.pages, { APPLE_SAFARI_ALLOW_WRITES: "false" });
    const r = await call(c, "apple_safari_page_elements", { url: "https://shop.example/" });

    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ elements: [{ id: "3f9a2c1d-e1", label: "Buy" }] });
  });

  it("says the ids are page-scoped", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({ ok: true, data: { elements: [], truncated: false } }));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_page_elements", { url: "https://x.example/" });
    expect(r.text).toContain("until it navigates");
  });
});

describe("the command channel", () => {
  it("writes commands beside the capture store, not inside it", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({ ok: true, data: {} }));
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_scroll", { url: "https://x.example/" });

    // Siblings of `pages`, which is what the native handler resolves from its
    // own container root. Nesting them under `pages` would put commands where
    // the capture reader globs for JSON.
    expect(dirname(dirs.commands)).toBe(dirname(dirs.pages));
    expect(readdirSync(root).toSorted()).toContain("commands");
  });
});

/**
 * The setting reaches the page, and it reaches it from CONFIG rather than from
 * the caller.
 *
 * `page_elements` takes no argument that could turn this on, which is the point:
 * releasing a one-time code is a standing choice the user made in Settings, not
 * something a tool call talks its way into. These two tests are the whole
 * server-side contract — the redaction itself is `test/redaction.test.ts`,
 * against the real content script.
 */
describe("the one-time-code setting on the wire", () => {
  it("marks the command includeCodes:false by default", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { elements: [], truncated: false } }));
    const client = await connect(dirs.pages);
    await call(client, "apple_safari_page_elements", { url: "https://example.com/" });
    ext.stop();
    expect(ext.seen[0]?.includeCodes).toBe(false);
  });

  it("marks it true when APPLE_SAFARI_ALLOW_CODES is set", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { elements: [], truncated: false } }));
    const client = await connect(dirs.pages, { APPLE_SAFARI_ALLOW_CODES: "true" });
    await call(client, "apple_safari_page_elements", { url: "https://example.com/" });
    ext.stop();
    expect(ext.seen[0]?.includeCodes).toBe(true);
  });

  it("ignores an includeCodes argument invented by the caller", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { elements: [], truncated: false } }));
    const client = await connect(dirs.pages);
    // The unknown key is STRIPPED by the input schema, not refused — so this
    // call succeeds and simply does not opt in. That is the property worth
    // pinning: what reaches the page is decided by config alone, and no
    // argument a caller invents can reach `includeCodes`.
    const res = await call(client, "apple_safari_page_elements", {
      url: "https://example.com/",
      includeCodes: true,
    });
    ext.stop();
    expect(ext.seen[0]?.includeCodes).toBe(false);
    expect(res.isError).toBe(false);
  });
});

/**
 * `find_codes`, against the fake extension.
 *
 * The split under test is where the judgement lives: the page returns TEXT and
 * decides nothing, the server runs the shared extractor. A content script that
 * scored its own matches would be a second copy of a heuristic that exists
 * precisely because the naive version is wrong.
 */
/** A page that answers a `codes` command with the passages it was given. */
const answering =
  (excerpts: { text: string; inView?: boolean }[]) => (command: Record<string, unknown>) =>
    command.action === "codes"
      ? {
          ok: true,
          data: {
            excerpts: excerpts.map((e) => ({ text: e.text, inView: e.inView ?? true })),
            truncated: false,
            scannedAt: "2026-09-01T10:00:00.000Z",
            pageAgeSeconds: 12,
          },
        }
      : { ok: true, data: {} };

describe("find_codes", () => {
  const codesEnv = { APPLE_SAFARI_ALLOW_CODES: "true" };

  it("asks the named page for codes", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, answering([]));
    const client = await connect(dirs.pages, codesEnv);
    await call(client, "apple_safari_find_codes", { url: "https://mail.example.com/" });
    ext.stop();
    expect(ext.seen[0]?.action).toBe("codes");
    expect(ext.seen[0]?.url).toBe("https://mail.example.com/");
    expect(typeof ext.seen[0]?.expiresAt).toBe("number");
  });

  it("extracts the code server-side from the page's text", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, answering([{ text: "Your verification code is 481920" }]));
    const client = await connect(dirs.pages, codesEnv);
    const res = await call(client, "apple_safari_find_codes", { url: "https://x.example/" });
    ext.stop();
    const body = res.json() as { count: number; codes: { code: string; confidence: string }[] };
    expect(body.count).toBe(1);
    expect(body.codes[0]!.code).toBe("481920");
    expect(body.codes[0]!.confidence).toBe("high");
  });

  /**
   * The half of the heuristic that matters most, reaching this lane intact: an
   * order number is a digit run in a sentence that also says "code" somewhere,
   * and returning it would be pasted into an auth prompt.
   */
  it("does not return a digit run with no keyword near it", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, answering([{ text: "Order 4829104 shipped on Tuesday" }]));
    const client = await connect(dirs.pages, codesEnv);
    const res = await call(client, "apple_safari_find_codes", { url: "https://x.example/" });
    ext.stop();
    expect((res.json() as { count: number }).count).toBe(0);
  });

  /** Nothing found is the normal answer and must not read as a failure. */
  it("reports an empty result without erroring", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, answering([]));
    const client = await connect(dirs.pages, codesEnv);
    const res = await call(client, "apple_safari_find_codes", { url: "https://x.example/" });
    ext.stop();
    expect(res.isError).toBe(false);
    const body = res.json() as { count: number; note: string };
    expect(body.count).toBe(0);
    expect(body.note).toContain("normal result");
  });

  it("passes the page's freshness through and adds its own round trip", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, answering([{ text: "code 481920" }]));
    const client = await connect(dirs.pages, codesEnv);
    const res = await call(client, "apple_safari_find_codes", { url: "https://x.example/" });
    ext.stop();
    const body = res.json() as { pageAgeSeconds: number; scannedAt: string; roundTripMs: number };
    expect(body.pageAgeSeconds).toBe(12);
    expect(body.scannedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(body.roundTripMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * The timeout a user actually hits — the extension not allowed on that site.
   * It must not blame a permission this lane does not use.
   */
  it("names the three conditions when no page answers", async () => {
    const dirs = paths();
    const client = await connect(dirs.pages, codesEnv);
    const res = await call(client, "apple_safari_find_codes", { url: "https://x.example/" });
    expect(res.isError).toBe(true);
    expect(res.text).not.toContain("Full Disk Access");
    expect(res.text).not.toContain("Automation");
  });
});

/**
 * `read_page` asks the tab first and falls back to the capture.
 *
 * The case this exists for is the one that was broken: a single-page app whose
 * capture is its pre-render shell, while the tab itself holds the real page.
 * The fallback cases matter as much — a capture returned in place of a live
 * read must say that it is one, and why.
 */
describe("read_page, live", () => {
  const url = "https://apps.example/form";
  const shell = (pages: string) => {
    capture(pages, url, "1.0.0");
    // `capture` writes an empty text; give the shell its real signature.
    const file = join(pages, `${createHash("sha256").update(url).digest("hex")}.json`);
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...entry, text: "Skip to content" }));
  };
  const liveData = {
    url,
    title: "App Listing Submission",
    format: "text",
    content: "Skip to content\nApp name\nPrepaid Credits",
    totalChars: 41,
    truncated: false,
    readAt: new Date().toISOString(),
  };

  it("returns what the tab holds now, over the capture", async () => {
    const dirs = paths();
    shell(dirs.pages);
    const ext = fakeExtension(dirs, () => ({ ok: true, data: liveData }));
    running = ext;
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_read_page", { url });

    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({
      source: "live",
      ageSeconds: 0,
      content: liveData.content,
      title: "App Listing Submission",
    });
    expect(r.text).not.toContain("liveRead");
  });

  it("asks for the format and the cap the caller named", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { ...liveData, format: "html" } }));
    running = ext;
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_read_page", { url, format: "html", maxChars: 500 });

    expect(ext.seen[0]).toMatchObject({ action: "read", url, format: "html", maxChars: 500 });
  });

  it("works for a URL that was never captured", async () => {
    const dirs = paths();
    running = fakeExtension(dirs, () => ({ ok: true, data: liveData }));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_read_page", { url });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ source: "live" });
  });

  it("falls back to the capture, and says to reload, when the tab predates live reads", async () => {
    const dirs = paths();
    shell(dirs.pages);
    running = fakeExtension(dirs, (cmd) => ({
      ok: false,
      error: `Unknown action "${String(cmd.action)}".`,
    }));
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_read_page", { url });

    expect(r.isError).toBe(false);
    const body = r.json() as { source: string; content: string; liveRead: string };
    expect(body.source).toBe("capture");
    expect(body.content).toBe("Skip to content");
    expect(body.liveRead).toContain("reload");
  });

  it("falls back to the capture when no tab answers, and says why", async () => {
    const dirs = paths();
    shell(dirs.pages);
    const c = await connect(dirs.pages, { APPLE_SAFARI_LIVE_READ_TIMEOUT_MS: "300" });
    const r = await call(c, "apple_safari_read_page", { url });

    expect(r.isError).toBe(false);
    const body = r.json() as { source: string; liveRead: string };
    expect(body.source).toBe("capture");
    expect(body.liveRead).toContain("did not answer within 0.3s");
    // The unanswered command is taken back rather than left to run later.
    expect(readdirSync(dirs.commands)).toEqual([]);
  });

  /** A failure on this side is not the tab's fault, and must not read as one. */
  it("does not blame the tab when the command could not even be written", async () => {
    const dirs = paths();
    shell(dirs.pages);
    // A FILE where the command directory should be, so the write fails at once.
    writeFileSync(dirs.commands, "");
    const c = await connect(dirs.pages);
    const r = await call(c, "apple_safari_read_page", { url });

    const body = r.json() as { source: string; liveRead: string };
    expect(body.source).toBe("capture");
    expect(body.liveRead).toContain("could not be asked");
    expect(body.liveRead).not.toContain("did not answer");
  });

  it("still fails legibly when there is neither a tab nor a capture", async () => {
    const dirs = paths();
    shell(dirs.pages);
    const c = await connect(dirs.pages, { APPLE_SAFARI_LIVE_READ_TIMEOUT_MS: "300" });
    const r = await call(c, "apple_safari_read_page", { url: "https://elsewhere.example/" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No capture for that exact URL");
  });

  it("does not wait on a tab when live reads are switched off", async () => {
    const dirs = paths();
    shell(dirs.pages);
    const ext = fakeExtension(dirs, () => ({ ok: true, data: liveData }));
    running = ext;
    const c = await connect(dirs.pages, { APPLE_SAFARI_LIVE_READ_TIMEOUT_MS: "0" });
    const r = await call(c, "apple_safari_read_page", { url });
    expect(r.json()).toMatchObject({ source: "capture" });
    expect(ext.seen).toEqual([]);
  });
});

describe("page_elements value cap", () => {
  it("passes the caller's maxValueChars to the page", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { elements: [], truncated: false } }));
    running = ext;
    const c = await connect(dirs.pages);
    await call(c, "apple_safari_page_elements", { url: "https://x.example/", maxValueChars: 5000 });
    expect(ext.seen[0]).toMatchObject({ action: "elements", maxValueChars: 5000 });
  });
});

/** A script runner that answers every script with `payload` and records what ran. */
const tabsScript = (payload: Record<string, unknown>) => {
  const calls: string[] = [];
  const runner: OsascriptRunner = {
    run: async <T>(script: string): Promise<T> => {
      calls.push(script);
      return payload as T;
    },
  };
  return { runner, calls };
};

/**
 * "What is on my screen" used to cost a list_tabs call first, because every
 * page tool wanted an exact URL. The tools that only READ now default to the
 * frontmost tab, and say which URL they used; the ones that act still name
 * their page through the element id.
 */
describe("the frontmost tab, when no url is given", () => {
  const FRONT = "https://front.example/page";
  const SAFARI = {
    running: true,
    windows: 1,
    appFrontmost: true,
    windowOrderUnknown: false,
    tabs: [
      {
        window: 1,
        windowIndex: 1,
        index: 1,
        url: "https://behind.example/",
        title: "B",
        active: false,
        frontmost: false,
      },
      {
        window: 1,
        windowIndex: 1,
        index: 2,
        url: FRONT,
        title: "F",
        active: true,
        frontmost: true,
      },
    ],
  };

  it("reads the frontmost tab live, and says which URL it read", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, (c) => ({
      ok: true,
      data: {
        url: c.url,
        title: "F",
        format: "text",
        content: "hello",
        totalChars: 5,
        truncated: false,
        readAt: new Date().toISOString(),
      },
    }));
    running = ext;
    const { runner } = tabsScript(SAFARI);
    const c = await connect(dirs.pages, {}, runner);
    const r = await call(c, "apple_safari_read_page", {});
    expect(r.isError).toBe(false);
    expect(ext.seen[0]?.url).toBe(FRONT);
    expect((r.json() as { url: string; tab: string }).url).toBe(FRONT);
    expect((r.json() as { url: string; tab: string }).tab).toBe("frontmost");
  });

  it("enumerates the frontmost tab's elements", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { page: "3f9a2c1d", elements: [] } }));
    running = ext;
    const c = await connect(dirs.pages, {}, tabsScript(SAFARI).runner);
    const r = await call(c, "apple_safari_page_elements", {});
    expect(r.isError).toBe(false);
    expect(ext.seen[0]?.url).toBe(FRONT);
    expect((r.json() as { url: string }).url).toBe(FRONT);
  });

  it("scans the frontmost tab for codes", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { excerpts: [] } }));
    running = ext;
    const c = await connect(
      dirs.pages,
      { APPLE_SAFARI_ALLOW_CODES: "true" },
      tabsScript(SAFARI).runner,
    );
    const r = await call(c, "apple_safari_find_codes", {});
    expect(r.isError).toBe(false);
    expect(ext.seen[0]?.url).toBe(FRONT);
  });

  it("sends no Apple Event when a url is given", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: { page: "3f9a2c1d", elements: [] } }));
    running = ext;
    const script = tabsScript(SAFARI);
    const c = await connect(dirs.pages, {}, script.runner);
    await call(c, "apple_safari_page_elements", { url: "https://named.example/" });
    expect(script.calls).toHaveLength(0);
    expect(ext.seen[0]?.url).toBe("https://named.example/");
  });

  it("asks for a url, writing no command, when live tabs are off", async () => {
    const dirs = paths();
    const ext = fakeExtension(dirs, () => ({ ok: true, data: {} }));
    running = ext;
    const script = tabsScript(SAFARI);
    const c = await connect(dirs.pages, { APPLE_SAFARI_LIVE_TABS: "false" }, script.runner);
    const r = await call(c, "apple_safari_page_elements", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("APPLE_SAFARI_LIVE_TABS");
    expect(r.text).toContain("url");
    expect(script.calls).toHaveLength(0);
    expect(ext.seen).toHaveLength(0);
  });

  it("says Safari is not running rather than guessing a page", async () => {
    const dirs = paths();
    const c = await connect(
      dirs.pages,
      {},
      tabsScript({
        running: false,
        windows: 0,
        appFrontmost: null,
        windowOrderUnknown: false,
        tabs: [],
      }).runner,
    );
    const r = await call(c, "apple_safari_read_page", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not running");
  });

  it("refuses when no tab can be called frontmost", async () => {
    const dirs = paths();
    const c = await connect(
      dirs.pages,
      { APPLE_SAFARI_ALLOW_CODES: "true" },
      tabsScript({
        ...SAFARI,
        windowOrderUnknown: true,
        tabs: SAFARI.tabs.map((t) => ({ ...t, frontmost: false })),
      }).runner,
    );
    const r = await call(c, "apple_safari_find_codes", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("frontmost");
  });
});
