import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { MailAxLane } from "../src/client/ax.js";
import {
  COMMIT_REPLACEMENT,
  DRAFT_FACTS,
  OPEN_COMPOSER,
  SEND_MESSAGE,
  STAGE_REPLACEMENT,
  UPDATE_DRAFT,
} from "../src/client/jxa/write.js";
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

const NAMES = new Map<string, string>([
  [DRAFT_FACTS, "DRAFT_FACTS"],
  [UPDATE_DRAFT, "UPDATE_DRAFT"],
  [STAGE_REPLACEMENT, "STAGE_REPLACEMENT"],
  [COMMIT_REPLACEMENT, "COMMIT_REPLACEMENT"],
  [OPEN_COMPOSER, "OPEN_COMPOSER"],
  [SEND_MESSAGE, "SEND_MESSAGE"],
]);

/**
 * A runner that records which scripts it was asked for, by name.
 *
 * Staging refuses unless told to stage, which is what a reply draft does.
 */
const runnerSeeing = (scripts: string[], stages = false): OsascriptRunner => ({
  run: vi.fn(async (script: string) => {
    const name = NAMES.get(script) ?? "OTHER";
    scripts.push(name);
    if (name === "DRAFT_FACTS") {
      return {
        subject: "Re: Quarterly numbers",
        isReply: true,
        attachments: 0,
        recipientCount: 2,
        contentHead: "ALPHA one",
        draftsMailbox: "Drafts",
      };
    }
    if (name === "STAGE_REPLACEMENT" && stages) {
      return { staged: true, subject: "Quarterly numbers", before: [42], draftsMailbox: "Drafts" };
    }
    if (name === "COMMIT_REPLACEMENT") return { replaced: true, method: "recreate", newId: 99 };
    if (name === "OPEN_COMPOSER") return { subject: "Hello" };
    if (name === "SEND_MESSAGE") return { sent: false, draft: true };
    return { replaced: false, method: "recreate", capability: "threading" };
  }) as OsascriptRunner["run"],
});

/** Some composers and a client that share one world: an edit changes what they show. */
const world = (
  composers: number,
  over: { stages?: boolean; finish?: "pressed" | "refused"; refuseEdit?: boolean } = {},
) => {
  const scripts: string[] = [];
  const runner = runnerSeeing(scripts, over.stages);
  // What the composer shows above its quote. An edit changes it.
  let shown = "ALPHA one";
  // The files the composer shows.
  const files: string[] = [];
  const edited: Record<string, unknown>[] = [];
  const lane = {
    watch: () => ({ check: async () => null }),
    reach: async () => ({ ok: true, reason: null, windows: [] }),
    composers: async () => [
      ...Array.from({ length: Math.max(composers, 0) }, (_, at) => ({
        composer: `mc-${at}`,
        subject: "Re: Quarterly numbers",
        recipients: [],
        text: shown,
        quoted: true,
        files: [...files],
      })),
      // A composer Mail was asked to open appears in the list once it has been:
      // the one handle that was not there before.
      ...(scripts.includes("OPEN_COMPOSER") || scripts.includes("STAGE_REPLACEMENT")
        ? [
            {
              composer: "mc-new",
              subject: scripts.includes("OPEN_COMPOSER") ? "Hello" : "Quarterly numbers",
              recipients: [],
              text: shown,
              quoted: false,
              files: [...files],
            },
          ]
        : []),
    ],
    // The native verb: it replaces the body and adds files in one step.
    editComposer: async (args: {
      body?: string;
      edits?: { find: string; replace: string }[];
      attachments?: string[];
    }) => {
      edited.push(args);
      if (over.refuseEdit)
        return {
          replaced: false,
          degraded: true,
          capability: "composer",
          reason: "The window would not take the edit.",
          hint: "Look at it in Mail.",
        };
      if (args.body !== undefined) shown = args.body;
      for (const edit of args.edits ?? []) shown = shown.replace(edit.find, edit.replace);
      const added = (args.attachments ?? []).map((path) => basename(path));
      files.push(...added);
      return {
        replaced: true,
        method: "inPlace",
        text: shown,
        quoteKept: true,
        filesAdded: added,
        saved: true,
        note: "ok",
      };
    },
    finish: async () => over.finish ?? ("pressed" as const),
    // What the recreate route's composer needs: a window, and a body to read.
    findComposer: async () => ({ window: "w9", body: "b9", index: 9 }),
    composerGone: async () => false,
  } as unknown as MailAxLane;

  const client = new AppleMailClient({
    config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/nonexistent/Envelope Index" }),
    osascript: runner,
    ax: composers < 0 ? null : lane,
  });
  return { client, scripts, runner, edited, shownNow: () => shown, files };
};

describe("which lane a draft rewrite takes", () => {
  /*
   * The case the whole thing exists for: a reply draft whose composer is still
   * open. Recreation would have refused it on threading grounds.
   */
  it("edits the open composer rather than recreating a reply draft", async () => {
    const { client, scripts, shownNow } = world(1);
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: true, method: "inPlace", threadingKept: true });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
    expect(shownNow()).toBe("BRAVO");
  });

  it("falls back to recreating when no composer is open", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(result).toMatchObject({ method: "recreate" });
    // Staged, so the body is pasted rather than assigned; a reply refuses there.
    expect(scripts).toEqual(["DRAFT_FACTS", "STAGE_REPLACEMENT"]);
  });

  /*
   * The route that replaced assigning the body. The replacement's window is
   * filled and saved like a reply's, and only then is the original deleted.
   */
  it("recreates by filling the staged replacement, then commits", async () => {
    const { client, scripts, runner, shownNow } = world(0, { stages: true });
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: true, method: "recreate", bodyVerified: true });
    expect(scripts).toEqual(["DRAFT_FACTS", "STAGE_REPLACEMENT", "COMMIT_REPLACEMENT"]);
    expect(shownNow()).toBe("BRAVO");
    const commit = vi.mocked(runner.run).mock.calls.at(-1)?.[1];
    expect(commit).toMatchObject({ subject: "Quarterly numbers", before: [42] });
  });

  /* Unsaved replacement, untouched original: commit is never reached. */
  it("does not commit a replacement it could not save", async () => {
    const { client, scripts } = world(0, { stages: true, refuseEdit: true });
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(/original draft was not changed/);
    expect(scripts).toEqual(["DRAFT_FACTS", "STAGE_REPLACEMENT"]);
  });

  /*
   * A composer's subject field is not typed into by this path, so a rewrite that
   * changes the subject has to go the way that can set one — even with a window
   * open. Silently keeping the old subject would be the worst of both.
   */
  it("goes the recreate way when the subject is changing", async () => {
    const { client, scripts } = world(1);
    await client.updateDraft({ ref: REF }, { body: "BRAVO", subject: "A different subject" });
    expect(scripts).toEqual(["DRAFT_FACTS", "STAGE_REPLACEMENT"]);
  });

  /* A subject that is passed but unchanged is not a change. */
  it("still edits in place when the subject passed is the one it already has", async () => {
    const { client, scripts } = world(1);
    const result = await client.updateDraft(
      { ref: REF },
      {
        body: "BRAVO",
        subject: "Re: Quarterly numbers",
      },
    );
    expect(result).toMatchObject({ method: "inPlace" });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
  });

  /*
   * No lane, no preflight. A package installed from npm and run by hand pays
   * exactly what it always did for a rewrite.
   */
  it("does not read the preflight at all without an accessibility lane", async () => {
    const { client, scripts } = world(-1);
    await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(scripts).toEqual(["UPDATE_DRAFT"]);
  });

  /*
   * Enforced before Mail is touched at all: blanking a draft and reporting
   * success is indistinguishable from having written it.
   */
  it("refuses an empty body on either lane", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft({ ref: REF }, { body: "   " })).rejects.toThrow(
      /cannot be empty/,
    );
    expect(scripts).toEqual([]);
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
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      filesAdded: ["report.pdf"],
      threadingKept: true,
    });
    expect(result).not.toHaveProperty("bodyLength");
    expect(scripts).toEqual(["DRAFT_FACTS"]);
    expect(shownNow()).toBe("ALPHA one");
    expect(files).toEqual(["report.pdf"]);
  });

  it("replaces the body and adds the files in one call", async () => {
    const { client, shownNow, files } = world(1);
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO", attachments: [report] });
    expect(result).toMatchObject({ replaced: true, method: "inPlace", bodyLength: 5 });
    expect(shownNow()).toBe("BRAVO");
    expect(files).toEqual(["report.pdf"]);
  });

  /* No window, no body: recreating would have nothing to write, so it is not tried. */
  it("refuses files alone when no composer is open, without recreating", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(scripts).toEqual(["DRAFT_FACTS"]);
  });

  it("refuses files alone without an accessibility lane, asking Mail nothing", async () => {
    const { client, scripts } = world(-1);
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(/not started by Cupertino/);
    expect(scripts).toEqual([]);
  });

  it("adds the files to the recreated draft when a body comes with them", async () => {
    const { client, scripts, runner, files } = world(0, { stages: true });
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO", attachments: [report] });
    expect(result).toMatchObject({ replaced: true });
    expect(scripts).toEqual(["DRAFT_FACTS", "STAGE_REPLACEMENT", "COMMIT_REPLACEMENT"]);
    expect(files).toEqual(["report.pdf"]);
    const commit = vi.mocked(runner.run).mock.calls.at(-1)?.[1];
    expect(commit).toMatchObject({ attachmentsAdded: 1 });
  });

  /* Without a lane, files ride on the assigned body, as they always did. */
  it("hands the files to the assigning route without a lane", async () => {
    const { client, scripts, runner } = world(-1);
    await client.updateDraft({ ref: REF }, { body: "BRAVO", attachments: [report] });
    expect(scripts).toEqual(["UPDATE_DRAFT"]);
    const calls = vi.mocked(runner.run).mock.calls;
    expect(calls.at(-1)?.[1]).toMatchObject({ body: "BRAVO", attachments: [report] });
  });

  /* Checked before Mail is asked anything, on either lane. */
  it("refuses a call with nothing to change", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft({ ref: REF }, {})).rejects.toThrow(/Nothing to change/);
    expect(scripts).toEqual([]);
  });

  it("refuses a path that is not absolute", async () => {
    const { client, scripts } = world(1);
    await expect(client.updateDraft({ ref: REF }, { attachments: ["report.pdf"] })).rejects.toThrow(
      /not an absolute path/,
    );
    expect(scripts).toEqual([]);
  });
});

/*
 * Which way a new message goes. Assigning its body is what SEND_MESSAGE does
 * and what wrapped the 2026-10-21 mail in a quotation, so with a lane it must
 * not be reached at all.
 */
describe("which lane a new message takes", () => {
  const message = { to: ["dave@example.com"], cc: [], bcc: [], body: "Hi Dave", sendNow: false };

  it("fills the body natively when the app hosts this server", async () => {
    const { client, scripts, shownNow } = world(0);
    const result = await client.sendMessage({ ...message, subject: "Hello" });
    expect(result).toMatchObject({ ok: true, bodyVerified: true });
    expect(scripts).toEqual(["OPEN_COMPOSER"]);
    expect(shownNow()).toBe("Hi Dave");
  });

  /* The subject is the native half's only handle on the window. */
  it("keeps a message with no subject on the assigning route", async () => {
    const { client, scripts } = world(0);
    await client.sendMessage({ ...message, subject: "  " });
    expect(scripts).toEqual(["SEND_MESSAGE"]);
  });

  it("assigns the body without a lane, as it always did", async () => {
    const { client, scripts } = world(-1);
    await client.sendMessage({ ...message, subject: "Hello" });
    expect(scripts).toEqual(["SEND_MESSAGE"]);
  });
});

/*
 * Which composer an edit is aimed at. A ref finds it by content; a handle names
 * it; with neither, the one open composer is it. Every refusal changes nothing.
 */
describe("choosing the composer to edit", () => {
  it("edits the one open composer when given neither a ref nor a handle", async () => {
    const { client, scripts, edited, shownNow } = world(1);
    const result = await client.updateDraft({}, { body: "BRAVO" });
    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      subject: "Re: Quarterly numbers",
    });
    // No ref, so there is nothing to ask Mail about.
    expect(scripts).toEqual([]);
    expect(edited).toEqual([{ composer: "mc-0", body: "BRAVO", save: true }]);
    expect(shownNow()).toBe("BRAVO");
  });

  it("refuses with no target when two composers are open, naming both", async () => {
    const { client, edited } = world(2);
    const result = await client.updateDraft({}, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(result).toMatchObject({
      composers: [
        { composer: "mc-0", subject: "Re: Quarterly numbers" },
        { composer: "mc-1", subject: "Re: Quarterly numbers" },
      ],
    });
    expect(String((result as { reason: string }).reason)).toMatch(/mc-0.*mc-1/s);
    expect(edited).toEqual([]);
  });

  it("refuses with no target when no composer is open", async () => {
    const { client, edited } = world(0);
    const result = await client.updateDraft({}, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(
      /No compose window is open in Mail/,
    );
    expect(edited).toEqual([]);
  });

  it("goes straight to the handle it is given, asking Mail nothing", async () => {
    const { client, scripts, edited } = world(2);
    const result = await client.updateDraft({ composer: "mc-1" }, { body: "BRAVO" });
    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      subject: "Re: Quarterly numbers",
    });
    expect(scripts).toEqual([]);
    // No facts, so no identity check to pass along.
    expect(edited).toEqual([{ composer: "mc-1", body: "BRAVO", save: true }]);
  });

  it("returns the verb's refusal for a handle as it answered", async () => {
    const { client } = world(1, { refuseEdit: true });
    const result = await client.updateDraft({ composer: "mc-0" }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
  });

  it("refuses a ref and a handle together, before anything is read", async () => {
    const { client, scripts } = world(1);
    await expect(
      client.updateDraft({ ref: REF, composer: "mc-0" }, { body: "BRAVO" }),
    ).rejects.toThrow(/not both/);
    expect(scripts).toEqual([]);
  });

  it("refuses body and edits together", async () => {
    const { client } = world(1);
    await expect(
      client.updateDraft({}, { body: "BRAVO", edits: [{ find: "a", replace: "b" }] }),
    ).rejects.toThrow(/either/);
  });

  it("refuses a target-less call that only names a new subject", async () => {
    const { client } = world(1);
    await expect(client.updateDraft({}, { subject: "New" })).rejects.toThrow(/Nothing to change/);
  });

  /* The native verb is the only way to edit a composer by handle. */
  it("refuses edits and handles without an accessibility lane", async () => {
    const { client, scripts } = world(-1);
    const edits = [{ find: "ALPHA", replace: "BRAVO" }];
    const byEdits = await client.updateDraft({ ref: REF }, { edits });
    expect(byEdits).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((byEdits as { reason: string }).reason)).toMatch(/Cupertino/);
    const byHandle = await client.updateDraft({ composer: "mc-0" }, { body: "BRAVO" });
    expect(byHandle).toMatchObject({ replaced: false, capability: "composer" });
    const byNothing = await client.updateDraft({}, { body: "BRAVO" });
    expect(byNothing).toMatchObject({ replaced: false, capability: "composer" });
    expect(scripts).toEqual([]);
  });
});

describe("editing a draft by find and replace", () => {
  const edits = [{ find: "ALPHA", replace: "BRAVO" }];

  it("passes the edits to the draft's own composer, with its identity check", async () => {
    const { client, edited, shownNow } = world(1);
    const result = await client.updateDraft({ ref: REF }, { edits });
    expect(result).toMatchObject({ replaced: true, method: "inPlace", threadingKept: true });
    expect(edited).toEqual([{ composer: "mc-0", edits, expectHead: "ALPHA one" }]);
    expect(shownNow()).toBe("BRAVO one");
  });

  /* Recreating from edits would need the old text, and could only guess at it. */
  it("edits with a ref and no open composer refuse without recreating", async () => {
    const { client, scripts } = world(0, { stages: true });
    const result = await client.updateDraft({ ref: REF }, { edits });
    expect(result).toMatchObject({ replaced: false, method: "recreate", capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(
      /edits need the draft's window open.*nothing was changed/is,
    );
    expect(scripts).toEqual(["DRAFT_FACTS"]);
  });

  it("edits the one open composer with no ref at all", async () => {
    const { client, edited } = world(1);
    await client.updateDraft({}, { edits });
    expect(edited).toEqual([{ composer: "mc-0", edits, save: true }]);
  });
});

describe("the in-place result", () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-draft-count-"));
  const report = join(dir, "report.pdf");
  writeFileSync(report, "%PDF-1.4");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("carries attachmentsAdded as a count", async () => {
    const { client } = world(1);
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({ filesAdded: ["report.pdf"], attachmentsAdded: 1 });
  });

  it("carries it on a handle edit too", async () => {
    const { client } = world(1);
    const result = await client.updateDraft({ composer: "mc-0" }, { attachments: [report] });
    expect(result).toMatchObject({ filesAdded: ["report.pdf"], attachmentsAdded: 1 });
  });
});

describe("listing the open drafts", () => {
  it("gives each one its handle, with the text and recipients the window shows", async () => {
    const { client } = world(2);
    const result = (await client.listOpenDrafts()) as {
      drafts: Record<string, unknown>[];
      note: string;
    };
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts[0]).toMatchObject({
      composer: "mc-0",
      subject: "Re: Quarterly numbers",
      recipients: [],
      text: "ALPHA one",
      quoted: true,
    });
    expect(result.drafts[1]).toMatchObject({ composer: "mc-1" });
    expect(result.note).toMatch(/`composer`.*apple_mail_update_draft/s);
  });

  it("says plainly that none is open", async () => {
    const { client } = world(0);
    const result = (await client.listOpenDrafts()) as { drafts: unknown[]; note: string };
    expect(result.drafts).toEqual([]);
    expect(result.note).toMatch(/No compose window is open in Mail/);
  });
});
