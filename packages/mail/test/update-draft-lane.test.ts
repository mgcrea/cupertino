import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { MailAxLane } from "../src/client/ax.js";
import { LIST_ACCOUNTS } from "../src/client/jxa/read.js";
import {
  COMMIT_REPLACEMENT,
  DRAFT_FACTS,
  OPEN_COMPOSER,
  SEND_MESSAGE,
  UPDATE_DRAFT,
} from "../src/client/jxa/write.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import { loadConfig } from "../src/config.js";

/**
 * Which lane a draft rewrite takes, and when.
 *
 * The choice is the whole feature. Editing the open composer keeps the draft
 * itself; rebuilding a closed one (`rebuild.ts`, tested in rebuild.test.ts)
 * makes a new draft and deletes the old. So arriving at a rebuild while an
 * editable window is open is not a slower answer, it is a second draft that did
 * not have to happen, and that is what these pin.
 *
 * The preflight is also a cost, so the other half of the contract is that it is
 * never paid by a server with no accessibility lane to spend it on. Those are
 * the published npm packages, run by hand with no Cupertino on the machine.
 */

const REF = "m1:98AC2C3D-408C-47E4-8FE4-6E64D1F58E99/Drafts#42";

const NAMES = new Map<string, string>([
  [DRAFT_FACTS, "DRAFT_FACTS"],
  [UPDATE_DRAFT, "UPDATE_DRAFT"],
  [COMMIT_REPLACEMENT, "COMMIT_REPLACEMENT"],
  [LIST_ACCOUNTS, "LIST_ACCOUNTS"],
  [OPEN_COMPOSER, "OPEN_COMPOSER"],
  [SEND_MESSAGE, "SEND_MESSAGE"],
]);

/**
 * A runner that records which scripts it was asked for, by name.
 *
 * It lists no accounts, so a rebuild reaches the draft's message file and
 * refuses there (`capability: "file"`): enough to pin that it was the route
 * taken, without a mail store on disk.
 */
const runnerSeeing = (scripts: string[]): OsascriptRunner => ({
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
    if (name === "LIST_ACCOUNTS") return [];
    if (name === "COMMIT_REPLACEMENT") return { replaced: true, method: "recreate", newId: 99 };
    if (name === "OPEN_COMPOSER") return { subject: "Hello" };
    if (name === "SEND_MESSAGE") return { sent: false, draft: true };
    return { replaced: false, method: "recreate", capability: "threading" };
  }) as OsascriptRunner["run"],
});

/** Some composers and a client that share one world: an edit changes what they show. */
const world = (
  composers: number,
  over: {
    finish?: "pressed" | "refused";
    refuseEdit?: boolean;
    tabs?: boolean;
    /** Composers (by index) whose handle Mail's tab rebuild re-bound: listed `rebound: true`. */
    rebound?: number[];
  } = {},
) => {
  const scripts: string[] = [];
  const runner = runnerSeeing(scripts);
  // What the composer shows above its quote. An edit changes it.
  let shown = "ALPHA one";
  // The files the composer shows.
  const files: string[] = [];
  const edited: Record<string, unknown>[] = [];
  const lane = {
    watch: () => ({ check: async () => null }),
    reach: async () => ({ ok: true, reason: null, windows: [] }),
    composers: async (quoteChars = 2000) => [
      ...Array.from({ length: Math.max(composers, 0) }, (_, at) =>
        // With `tabs`, every composer is a tab of one window, the first one shown.
        over.tabs && at > 0
          ? {
              composer: `mc-${at}`,
              subject: "Re: Quarterly numbers",
              tab: "background",
              main: false,
              from: null,
              to: null,
              cc: null,
              bcc: null,
              recipients: null,
              text: null,
              quoted: null,
              quote: null,
              quoteTruncated: false,
              files: [],
              rebound: over.rebound?.includes(at) ?? false,
            }
          : {
              ...(over.tabs ? { tab: "selected" } : {}),
              rebound: over.rebound?.includes(at) ?? false,
              composer: `mc-${at}`,
              subject: "Re: Quarterly numbers",
              recipients: ["Ann", "Cy"],
              main: at === 0,
              from: "Me – me@example.com",
              to: ["Ann"],
              cc: ["Cy"],
              bcc: null,
              text: shown,
              quoted: true,
              quote: quoteChars > 0 ? "On Monday, Ann wrote:".slice(0, quoteChars) : null,
              quoteTruncated: quoteChars > 0 && quoteChars < "On Monday, Ann wrote:".length,
              files: [...files],
            },
      ),
      // A composer Mail was asked to open appears in the list once it has been:
      // the one handle that was not there before.
      ...(scripts.includes("OPEN_COMPOSER")
        ? [
            {
              composer: "mc-new",
              subject: "Hello",
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
    // What a send needs: a window, and a body to read.
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

  it("falls back to rebuilding when no composer is open", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft({ ref: REF }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, method: "rebuild", capability: "file" });
    expect(scripts).toEqual(["DRAFT_FACTS", "LIST_ACCOUNTS"]);
  });

  /*
   * A composer's subject field is not typed into by this path, so a rewrite that
   * changes the subject goes the way that can set one: a rebuild, with the
   * window closed. With it open, see rebuild.test.ts.
   */
  it("rebuilds when the subject is changing and the window is closed", async () => {
    const { client, scripts, runner } = world(0);
    const result = await client.updateDraft(
      { ref: REF },
      { body: "BRAVO", subject: "A different subject" },
    );
    expect(result).toMatchObject({ method: "rebuild" });
    expect(scripts).toEqual(["DRAFT_FACTS", "LIST_ACCOUNTS"]);
    // The facts list the rows already under the subject the rebuild saves under.
    expect(vi.mocked(runner.run).mock.calls[0]?.[1]).toMatchObject({
      subject: "A different subject",
    });
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

  /* No window: the draft is rebuilt with its own text, and the files added. */
  it("rebuilds for files alone when no composer is open", async () => {
    const { client, scripts } = world(0);
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, method: "rebuild", capability: "file" });
    expect(scripts).toEqual(["DRAFT_FACTS", "LIST_ACCOUNTS"]);
  });

  it("refuses files alone without an accessibility lane, asking Mail nothing", async () => {
    const { client, scripts } = world(-1);
    const result = await client.updateDraft({ ref: REF }, { attachments: [report] });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String((result as { reason: string }).reason)).toMatch(/not started by Cupertino/);
    expect(scripts).toEqual([]);
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

  /*
   * Mail re-mints every tab button when a tab opens or closes, and a handle
   * re-bound to the tab carrying its title may name another draft. By handle
   * there is no text to check it against, so it is refused before the app is
   * asked; by ref the draft's text goes along, and the app checks it.
   */
  it("refuses a re-bound handle, saying to edit by ref or list again", async () => {
    const { client, scripts, edited } = world(2, { rebound: [1] });
    const result = await client.updateDraft({ composer: "mc-1" }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, method: "inPlace", capability: "identity" });
    expect(String((result as { reason: string }).reason)).toMatch(/mc-1.*rebuilt.*another draft/s);
    expect(String((result as { hint: string }).hint)).toMatch(/ref/);
    expect(String((result as { hint: string }).hint)).toMatch(/list the open drafts again/);
    expect(edited).toEqual([]);
    expect(scripts).toEqual([]);
  });

  it("still edits the composer beside a re-bound one by its own handle", async () => {
    const { client, edited } = world(2, { rebound: [1] });
    const result = await client.updateDraft({ composer: "mc-0" }, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: true, method: "inPlace" });
    expect(edited).toEqual([{ composer: "mc-0", body: "BRAVO", save: true }]);
  });

  it("refuses the one open composer the same way when it is re-bound", async () => {
    const { client, edited } = world(1, { rebound: [0] });
    const result = await client.updateDraft({}, { body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "identity" });
    expect(edited).toEqual([]);
  });

  it("edits a re-bound composer by ref, with the draft's text as expectHead", async () => {
    const { client, edited } = world(1, { rebound: [0] });
    const edits = [{ find: "ALPHA", replace: "BRAVO" }];
    const result = await client.updateDraft({ ref: REF }, { edits });
    expect(result).toMatchObject({ replaced: true, method: "inPlace" });
    expect(edited).toEqual([{ composer: "mc-0", edits, expectHead: "ALPHA one" }]);
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

  /* The rebuild reads the draft's own text from its file and edits that. */
  it("edits with a ref and no open composer go to the rebuild", async () => {
    const { client, scripts, edited } = world(0);
    const result = await client.updateDraft({ ref: REF }, { edits });
    expect(result).toMatchObject({ replaced: false, method: "rebuild", capability: "file" });
    expect(scripts).toEqual(["DRAFT_FACTS", "LIST_ACCOUNTS"]);
    expect(edited).toEqual([]);
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
      recipients: ["Ann", "Cy"],
      text: "ALPHA one",
      quoted: true,
    });
    expect(result.drafts[1]).toMatchObject({ composer: "mc-1" });
    expect(result.note).toMatch(/`composer`.*apple_mail_update_draft/s);
  });

  it("keeps the sender, recipients, front window and quote it always had", async () => {
    const { client } = world(2);
    const result = (await client.listOpenDrafts()) as { drafts: Record<string, unknown>[] };
    expect(result.drafts[0]).toMatchObject({
      main: true,
      from: "Me – me@example.com",
      to: ["Ann"],
      cc: ["Cy"],
      bcc: null,
      quote: "On Monday, Ann wrote:",
      quoteTruncated: false,
    });
    expect(result.drafts[1]).toMatchObject({ main: false });
  });

  it("passes quoteChars on, and 0 gives no quote", async () => {
    const { client } = world(1);
    const cut = (await client.listOpenDrafts({ quoteChars: 9 })) as {
      drafts: Record<string, unknown>[];
    };
    expect(cut.drafts[0]).toMatchObject({ quote: "On Monday", quoteTruncated: true });
    const none = (await client.listOpenDrafts({ quoteChars: 0 })) as {
      drafts: Record<string, unknown>[];
    };
    expect(none.drafts[0]).toMatchObject({ quote: null, quoteTruncated: false });
  });

  /*
   * Mail with "Prefer tabs: Always": one window, every draft a tab of it. A
   * tab it is not showing gives its subject and nothing it cannot read without
   * switching, and the note says when that text can be read.
   */
  it("lists a tab Mail is not showing with its subject, and says why its text is null", async () => {
    const { client } = world(2, { tabs: true });
    const result = (await client.listOpenDrafts()) as {
      drafts: Record<string, unknown>[];
      note: string;
    };
    expect(result.drafts.map((d) => d["tab"])).toEqual(["selected", "background"]);
    expect(result.drafts[0]).toMatchObject({ composer: "mc-0", text: "ALPHA one" });
    expect(result.drafts[1]).toMatchObject({
      composer: "mc-1",
      subject: "Re: Quarterly numbers",
      text: null,
      recipients: null,
      quote: null,
    });
    expect(result.drafts[1]).toHaveProperty("savedDrafts");
    expect(result.note).toMatch(/`tab: "background"`/);
    expect(result.note).toMatch(/selected/);
  });

  it("says plainly that none is open", async () => {
    const { client } = world(0);
    const result = (await client.listOpenDrafts()) as { drafts: unknown[]; note: string };
    expect(result.drafts).toEqual([]);
    expect(result.note).toMatch(/No compose window is open in Mail/);
  });
});
