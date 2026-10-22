import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { MailAxLane } from "../src/client/ax.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";

/**
 * Which lane a draft rewrite takes, and when.
 *
 * The choice is the whole feature. Editing the open composer keeps threading,
 * attachments and the quoted original; recreating the draft refuses the first
 * two outright. So arriving at recreation while an editable window is open is
 * not a slower answer, it is a REFUSAL that did not have to happen — and that is
 * what these pin.
 *
 * The preflight is also a cost, so the other half of the contract is that it is
 * never paid by a server with no accessibility lane to spend it on. Those are
 * the published npm packages, run by hand with no Cupertino on the machine.
 */

const REF = "m1:98AC2C3D-408C-47E4-8FE4-6E64D1F58E99/Drafts#42";

/** A runner that records which scripts it was asked for. */
const runnerSeeing = (scripts: string[]): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    if (script.includes("contentHead")) {
      scripts.push("DRAFT_FACTS");
      return {
        subject: "Re: Quarterly numbers",
        isReply: true,
        attachments: 0,
        recipientCount: 2,
        contentHead: "ALPHA one",
        draftsMailbox: "Drafts",
      };
    }
    scripts.push("UPDATE_DRAFT");
    return { replaced: false, method: "recreate", capability: "threading" };
  }) as OsascriptRunner["run"],
});

/**
 * A composer, a pasteboard, and a client that share one world.
 *
 * Not optional that they share it: the in-place lane copies its selection back
 * to read it, so a stub lane copying into one pasteboard while the client reads
 * another can never prove a selection and always refuses. And the pasteboard
 * has to be a fake at all because the real one is the machine's — a test that
 * wrote to it would clobber whatever the person running the suite had copied.
 */
const world = (composers: number) => {
  const scripts: string[] = [];
  const runner = runnerSeeing(scripts);
  let pasteboard: string | null = "whatever was already copied";
  // What the composer shows above its quote. The paste changes it.
  let shown = "ALPHA one";
  // File URLs on the pasteboard, and the files the composer shows.
  let copiedFiles: string[] | null = null;
  const files: string[] = [];
  const clipboard = {
    read: async () => pasteboard,
    write: async (text: string) => {
      pasteboard = text;
      copiedFiles = null;
    },
    writeFiles: async (paths: string[]) => {
      pasteboard = null;
      copiedFiles = paths;
    },
  };
  const lane = {
    watch: () => ({ check: async () => null }),
    reach: async () => ({ ok: true, reason: null, windows: [] }),
    findComposers: async () =>
      Array.from({ length: composers }, (_, at) => ({
        window: `w${at}`,
        body: `b${at}`,
        index: at,
      })),
    composerBody: async () => ({ text: shown, blocks: 1, quoted: true, files: [...files] }),
    keys: async (_ref: unknown, strokes: { key: string; modifiers?: string[] }[]) => {
      for (const stroke of strokes) {
        // command-C puts the selection on the pasteboard; the selection here is
        // the whole of the composer's own text. command-V replaces it.
        if (stroke.key === "c") pasteboard = shown;
        if (stroke.key === "v" && copiedFiles)
          files.push(...copiedFiles.map((path) => basename(path)));
        else if (stroke.key === "v") shown = String(pasteboard);
      }
      return true;
    },
    finish: async () => "pressed" as const,
  } as unknown as MailAxLane;

  const client = new AppleMailClient({
    config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/nonexistent/Envelope Index" }),
    osascript: runner,
    ax: composers < 0 ? null : lane,
    clipboard,
  });
  return { client, clipboard, scripts, runner, shownNow: () => shown, files };
};

describe("which lane a draft rewrite takes", () => {
  /*
   * The case the whole thing exists for: a reply draft whose composer is still
   * open. Recreation would have refused it on threading grounds.
   */
  it("edits the open composer rather than recreating a reply draft", async () => {
    const { client, scripts, shownNow } = world(1);
    const result = await client.updateDraft(REF, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: true, method: "inPlace", threadingKept: true });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
    expect(shownNow()).toBe("BRAVO");
  });

  it("falls back to recreating when no composer is open", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft(REF, { body: "BRAVO" });
    expect(result).toMatchObject({ method: "recreate" });
    expect(scripts).toEqual(["DRAFT_FACTS", "UPDATE_DRAFT"]);
  });

  /*
   * A composer's subject field is not typed into by this path, so a rewrite that
   * changes the subject has to go the way that can set one — even with a window
   * open. Silently keeping the old subject would be the worst of both.
   */
  it("goes the recreate way when the subject is changing", async () => {
    const { client, scripts } = world(1);
    await client.updateDraft(REF, { body: "BRAVO", subject: "A different subject" });
    expect(scripts).toEqual(["DRAFT_FACTS", "UPDATE_DRAFT"]);
  });

  /* A subject that is passed but unchanged is not a change. */
  it("still edits in place when the subject passed is the one it already has", async () => {
    const { client, scripts } = world(1);
    const result = await client.updateDraft(REF, {
      body: "BRAVO",
      subject: "Re: Quarterly numbers",
    });
    expect(result).toMatchObject({ method: "inPlace" });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
  });

  /*
   * No lane, no preflight. A package installed from npm and run by hand pays
   * exactly what it always did for a rewrite.
   */
  it("does not read the preflight at all without an accessibility lane", async () => {
    const { client, scripts } = world(-1);
    await client.updateDraft(REF, { body: "BRAVO" });
    expect(scripts).toEqual(["UPDATE_DRAFT"]);
  });

  /*
   * Enforced before Mail is touched at all: blanking a draft and reporting
   * success is indistinguishable from having written it.
   */
  it("refuses an empty body on either lane", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft(REF, { body: "   " })).rejects.toThrow(/cannot be empty/);
    expect(scripts).toEqual([]);
  });

  /* The pasteboard is borrowed, and put back. */
  it("puts the clipboard back after editing in place", async () => {
    const { client, clipboard } = world(1);
    await client.updateDraft(REF, { body: "BRAVO" });
    expect(await clipboard.read()).toBe("whatever was already copied");
  });
});

/*
 * Adding files to a draft that already exists. The composer is the only handle
 * on one, so the in-place lane is the route; recreation can carry files only as
 * part of a rewrite, and a call with nothing to rewrite must not reach it.
 */
describe("adding files to a draft", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-draft-files-"));
  const report = join(dir, "report.pdf");
  writeFileSync(report, "%PDF-1.4");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("pastes them into the open composer and leaves the text alone", async () => {
    const { client, scripts, shownNow, files } = world(1);
    const result = await client.updateDraft(REF, { attachments: [report] });
    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      attachmentsAdded: ["report.pdf"],
      threadingKept: true,
    });
    expect(result).not.toHaveProperty("bodyLength");
    expect(scripts).toEqual(["DRAFT_FACTS"]);
    expect(shownNow()).toBe("ALPHA one");
    expect(files).toEqual(["report.pdf"]);
  });

  it("replaces the body and adds the files in one call", async () => {
    const { client, shownNow, files } = world(1);
    const result = await client.updateDraft(REF, { body: "BRAVO", attachments: [report] });
    expect(result).toMatchObject({ replaced: true, method: "inPlace", bodyLength: 5 });
    expect(shownNow()).toBe("BRAVO");
    expect(files).toEqual(["report.pdf"]);
  });

  /* No window, no body: recreating would have nothing to write, so it is not tried. */
  it("refuses files alone when no composer is open, without recreating", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft(REF, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
  });

  it("refuses files alone without an accessibility lane, asking Mail nothing", async () => {
    const { client, scripts } = world(-1);
    const result = await client.updateDraft(REF, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(/not started by Cupertino/);
    expect(scripts).toEqual([]);
  });

  it("hands the files to the recreated draft when a body comes with them", async () => {
    const { client, scripts, runner } = world(0);
    await client.updateDraft(REF, { body: "BRAVO", attachments: [report] });
    expect(scripts).toEqual(["DRAFT_FACTS", "UPDATE_DRAFT"]);
    const calls = vi.mocked(runner.run).mock.calls;
    expect(calls.at(-1)?.[1]).toMatchObject({ body: "BRAVO", attachments: [report] });
  });

  /* Checked before Mail is asked anything, on either lane. */
  it("refuses a call with nothing to change", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft(REF, {})).rejects.toThrow(/Nothing to change/);
    expect(scripts).toEqual([]);
  });

  it("refuses a path that is not absolute", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft(REF, { attachments: ["report.pdf"] })).rejects.toThrow(
      /not an absolute path/,
    );
    expect(scripts).toEqual([]);
  });

  it("puts the clipboard back after pasting files", async () => {
    const { client, clipboard } = world(1);
    await client.updateDraft(REF, { attachments: [report] });
    expect(await clipboard.read()).toBe("whatever was already copied");
  });
});
