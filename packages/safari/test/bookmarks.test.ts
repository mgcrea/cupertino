import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOsascriptRunner } from "@mgcrea/mcp-apple-core";
import { describe, expect, it } from "vitest";

import { SAFARI_SURFACE } from "../src/client/errors.js";
import { BOOKMARKS_WALK } from "../src/client/jxa/bookmarks.js";

/**
 * The bookmark walker, run for real.
 *
 * docs/safari.md lists this walk as "rewritten after `plutil` failed and
 * verified against a fixture reproducing that exact error, but **not yet run
 * against a real `Bookmarks.plist`**". This does not close that item — the real
 * file needs Full Disk Access — but it closes the half that does not: the
 * script is executed by the actual `osascript` runner against an actual binary
 * property list with the actual structure Safari uses, including the `NSData`
 * value that breaks `plutil -convert json`.
 *
 * Everything here runs through `createOsascriptRunner` rather than a direct
 * `execFileSync`, so the static-script tripwire, argv construction and envelope
 * handling are all exercised too. Mocking the runner would skip precisely the
 * code these guarantees live in.
 *
 * The fixture contains nobody's browsing: it is checked in, synthetic, and
 * three folders deep.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "Bookmarks.plist");

type Entry = {
  uuid: string | null;
  url: string | null;
  title: string | null;
  folder: string | null;
  readingList: boolean;
  dateAdded: string | null;
  dateLastViewed: string | null;
  previewText: string | null;
};

const runner = createOsascriptRunner({
  surface: SAFARI_SURFACE,
  osascriptPath: "/usr/bin/osascript",
  timeoutMs: 30_000,
});

const walk = async (path = FIXTURE) =>
  runner.run<{ entries: Entry[]; folders: number; depthTruncated: boolean }>(BOOKMARKS_WALK, {
    path,
  });

describe("the fixture itself", () => {
  /**
   * The premise of the whole approach. If this ever starts succeeding, the
   * NSData case has stopped being reproduced and this suite has quietly become
   * a test of the easy path.
   */
  it("still breaks plutil's JSON conversion", () => {
    let failed = false;
    try {
      execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", FIXTURE], { stdio: "pipe" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});

// Runs the real /usr/bin/osascript against the fixture, which is the whole
// point of this suite — and which only exists on macOS. The `fixture itself`
// block above is pure file reading and stays portable.
describe.skipIf(process.platform !== "darwin")("BOOKMARKS_WALK", () => {
  it("reads every leaf, at every depth", async () => {
    const r = await walk();
    expect(r.entries.map((e) => e.url).toSorted()).toEqual([
      "https://docs.example.com/guide",
      "https://intranet.example.com/",
      "https://longread.example/essay",
      "https://longread.example/read-already",
    ]);
    expect(r.depthTruncated).toBe(false);
  });

  it("takes the title from URIDictionary", async () => {
    const r = await walk();
    expect(r.entries.find((e) => e.url?.endsWith("guide"))?.title).toBe("The Guide");
  });

  /** Nested folders build a path, so a caller can see where a bookmark lives. */
  it("reports the folder path", async () => {
    const r = await walk();
    expect(r.entries.find((e) => e.url?.includes("intranet"))?.folder).toBe("BookmarksBar/Work");
  });

  /**
   * The Reading List is identified by the literal `com.apple.ReadingList`, and
   * the path it produces is the readable name rather than that identifier.
   */
  it("identifies Reading List entries and renames the folder", async () => {
    const r = await walk();
    const rl = r.entries.filter((e) => e.readingList);
    expect(rl).toHaveLength(2);
    expect(rl.every((e) => e.folder === "Reading List")).toBe(true);
  });

  it("does not mark ordinary bookmarks as Reading List entries", async () => {
    const r = await walk();
    expect(
      r.entries
        .filter((e) => !e.readingList)
        .map((e) => e.url)
        .toSorted(),
    ).toEqual(["https://docs.example.com/guide", "https://intranet.example.com/"]);
  });

  /**
   * The finding that makes a Reading List tool worth having: there is no
   * read/unread boolean anywhere. `DateLastViewed` being ABSENT is the entire
   * unread state.
   */
  it("distinguishes read from unread by DateLastViewed alone", async () => {
    const r = await walk();
    const unread = r.entries.find((e) => e.url?.endsWith("essay"));
    const read = r.entries.find((e) => e.url?.endsWith("read-already"));
    expect(unread?.dateLastViewed).toBeNull();
    expect(read?.dateLastViewed).toBe("2026-07-02T08:00:00.000Z");
  });

  it("converts NSDate to ISO-8601", async () => {
    const r = await walk();
    expect(r.entries.find((e) => e.url?.endsWith("essay"))?.dateAdded).toBe(
      "2026-08-01T10:00:00.000Z",
    );
  });

  it("reads the preview text", async () => {
    const r = await walk();
    expect(r.entries.find((e) => e.url?.endsWith("essay"))?.previewText).toBe("It begins...");
  });

  /**
   * The NSData value sits in a sibling dictionary the walk never opens. This is
   * the whole reason the native object graph is walked instead of a converted
   * document: unrepresentable values stop mattering when they are not touched.
   */
  it("is unbothered by the NSData that defeats plutil", async () => {
    const r = await walk();
    expect(r.entries.find((e) => e.url?.endsWith("essay"))?.title).toBe("An Essay");
  });

  it("counts folders", async () => {
    const r = await walk();
    // BookmarksBar, Work, com.apple.ReadingList — the root is a list too.
    expect(r.folders).toBe(4);
  });

  it("returns a structured failure for a file that is not a plist", async () => {
    await expect(walk("/etc/hosts")).rejects.toThrow(/could not be read as a plist/);
  });

  it("returns a structured failure for a file that is not there", async () => {
    await expect(walk("/nonexistent/Bookmarks.plist")).rejects.toThrow();
  });
});
