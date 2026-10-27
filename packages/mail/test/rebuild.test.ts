import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { MailAxLane, NativeComposer } from "../src/client/ax.js";
import { COMMIT_REPLACEMENT, DRAFT_FACTS, OPEN_COMPOSER } from "../src/client/jxa/write.js";
import { AppleMailClient } from "../src/client/mail.js";
import type { OsascriptRunner } from "../src/client/osascript.js";
import {
  pickOriginal,
  rebuildDraft,
  type OriginalLookup,
  type RebuildDeps,
} from "../src/client/rebuild.js";
import type { DraftFacts } from "../src/client/revise.js";
import { loadConfig } from "../src/config.js";

/**
 * Rebuilding a saved draft whose window is closed (route B).
 *
 * Mail cannot edit a saved draft, so a closed one is rebuilt: a reply is
 * reopened as a reply to its ORIGINAL, so threading survives, and filled with
 * the draft's own HTML and files; the old draft is deleted only once the new
 * one is confirmed in Drafts. Every refusal leaves the original untouched, and
 * most of them happen before any window is opened.
 *
 * The draft is a real `.emlx`, shaped like the one the spike saved on macOS 27
 * (test/fixtures/reply-draft.emlx). Mail and the app are fakes.
 */

const FIXTURE = join(import.meta.dirname, "fixtures", "reply-draft.emlx");
const ORIGINAL_ID = "<A1B2C3D4-0000-4000-8000-000000000001@example.com>";
const SUBJECT = "Re: Quarterly numbers";
const TARGET = { accountUuid: "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99", mailbox: "Drafts", id: 42 };
const ORIGINAL = { accountUuid: TARGET.accountUuid, mailbox: "INBOX", id: 7 };
/** How the reply's composer reads its quote: the fixture's, as blocks. */
const QUOTE =
  "On 22 Oct 2026, at 11:30, Ann Example <ann@example.com> wrote:\n\nHere are the quarterly numbers.";

const FACTS: DraftFacts = {
  subject: SUBJECT,
  isReply: true,
  attachments: 0,
  recipientCount: 2,
  contentHead: "Thanks Ann, the numbers look right.",
  draftsMailbox: "Drafts",
  siblings: [42],
};

const scratch = mkdtempSync(join(tmpdir(), "mail-rebuild-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The fixture's MIME, with its emlx length prefix and plist trailer taken off. */
const fixtureMime = (): string => {
  const raw = readFileSync(FIXTURE, "utf8");
  const newline = raw.indexOf("\n");
  const length = Number.parseInt(raw.slice(0, newline), 10);
  return Buffer.from(raw.slice(newline + 1), "utf8")
    .subarray(0, length)
    .toString("utf8");
};

let variants = 0;
/** Write a MIME message as an emlx and return its path. */
const emlx = (mime: string): string => {
  variants += 1;
  const path = join(scratch, `${variants}.emlx`);
  const bytes = Buffer.from(mime, "utf8");
  writeFileSync(
    path,
    Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes, Buffer.from("<plist/>")]),
  );
  return path;
};

/** A draft carrying a file, in Mail's shape: the HTML split around it. */
const withAttachment = (
  filename = "report.pdf",
  /** An image the QUOTED original shows, by Content-ID; stored, or stripped with no sidecar. */
  quoteImage?: "stored" | "missing",
): string => {
  const html1 =
    '<html><head></head><body style="overflow-wrap: break-word;"><div>Here is the report.</div>' +
    "<div><br></div></body></html>";
  const html2 =
    '<html><head></head><body style="overflow-wrap: break-word;"><div></div>' +
    '<div class="AppleOriginalContents" style="direction: ltr;"><br><blockquote type="cite">' +
    "<div>On 22 Oct 2026, at 11:30, Ann Example &lt;ann@example.com&gt; wrote:</div>" +
    '<br class="Apple-interchange-newline"><div><div>Here are the quarterly numbers.</div></div>' +
    (quoteImage ? '<div><img src="cid:chart@example.com" alt="chart"></div>' : "") +
    "</blockquote></div></body></html>";
  const image = quoteImage
    ? [
        "--MIX",
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: inline; filename="chart.png"',
        'Content-Type: image/png; name="chart.png"',
        "Content-Id: <chart@example.com>",
        "",
        quoteImage === "stored" ? Buffer.from("PNG the chart").toString("base64") : "",
      ]
    : [];
  return emlx(
    [
      "From: Olivier Louvignes <olivier@example.com>",
      'Content-Type: multipart/alternative; boundary="ALT"',
      "X-Uniform-Type-Identifier: com.apple.mail-draft",
      `Subject: ${SUBJECT}`,
      `In-Reply-To: ${ORIGINAL_ID}`,
      "To: Ann Example <ann@example.com>",
      `References: ${ORIGINAL_ID}`,
      "Message-Id: <draft-2@example.com>",
      "",
      "--ALT",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Here is the report.",
      "--ALT",
      'Content-Type: multipart/mixed; boundary="MIX"',
      "",
      "--MIX",
      "Content-Type: text/html; charset=utf-8",
      "",
      html1,
      "--MIX",
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      `Content-Type: application/pdf; name="${filename}"`,
      "",
      Buffer.from("%PDF-1.4 the report").toString("base64"),
      "--MIX",
      "Content-Type: text/html; charset=utf-8",
      "",
      html2,
      ...image,
      "--MIX--",
      "--ALT--",
      "",
    ].join("\n"),
  );
};

type Over = {
  /** Composers already open before anything is asked. */
  open?: Partial<NativeComposer>[];
  /** The quote the new reply composer shows. */
  newQuote?: string | null;
  newQuoteTruncated?: boolean;
  /** The message file to read; the fixture by default. */
  path?: string;
  original?: OriginalLookup;
  commit?: Record<string, unknown> | Error;
  editThrows?: boolean;
  /** OPEN_COMPOSER fails after Mail opened a window (COMPOSER_NOT_FOUND). */
  openThrows?: boolean;
  /** The verb answers replaced without a reading of the text. */
  noReadBack?: boolean;
  /** The verb refuses, or fills and verifies but cannot save. */
  editRefuses?: boolean;
  unsaved?: boolean;
  /** Mail does not apply the recipients it was given. */
  dropsRecipients?: boolean;
};

/** A fake Mail and app, sharing one timeline of what was asked, in order. */
const world = (over: Over = {}) => {
  const timeline: string[] = [];
  const edits: Record<string, unknown>[] = [];
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  /** What existed of each file passed to the verb, at the moment it was passed. */
  const filesSeen: { path: string; existed: boolean }[] = [];
  let opened: { subject: string } | null = null;

  const composer = (quoteChars?: number): NativeComposer[] => [
    ...(over.open ?? []).map((c, at) => ({
      composer: `mc-${at}`,
      subject: "Something else",
      recipients: [],
      text: "",
      quoted: false,
      files: [],
      ...c,
    })),
    ...(opened
      ? [
          {
            composer: "mc-new",
            subject: opened.subject,
            recipients: ["Ann"],
            text: "",
            quoted: over.newQuote !== null,
            quote: quoteChars === undefined ? null : (over.newQuote ?? QUOTE),
            quoteTruncated: over.newQuoteTruncated ?? false,
            files: [],
          },
        ]
      : []),
  ];

  const lane = {
    watch: () => ({ check: async () => null }),
    reach: async () => ({ ok: true, reason: null, windows: [] }),
    composers: async (quoteChars?: number) => {
      timeline.push(quoteChars === undefined ? "composers" : `composers:${quoteChars}`);
      return composer(quoteChars);
    },
    editComposer: async (args: Record<string, unknown>) => {
      timeline.push("edit");
      edits.push(args);
      for (const path of (args.attachments as string[] | undefined) ?? [])
        filesSeen.push({ path, existed: existsSync(path) });
      if (over.editThrows) throw new Error("the app went away");
      if (over.noReadBack)
        return { replaced: true, method: "inPlace", filesAdded: [], saved: true, note: "ok" };
      if (over.editRefuses)
        return {
          replaced: false,
          degraded: true,
          capability: "confirmation",
          reason: "The paste did not read back.",
          hint: "Look at it in Mail.",
        };
      return {
        replaced: true,
        method: "inPlace",
        text: args.body ?? "",
        quoteKept: true,
        filesAdded: ((args.attachments as string[] | undefined) ?? []).map((p) => basename(p)),
        saved: !over.unsaved,
        note: "ok",
      };
    },
  } as unknown as MailAxLane;

  const runner: OsascriptRunner = {
    run: vi.fn(async (script: string, params: Record<string, unknown> = {}) => {
      const name =
        script === OPEN_COMPOSER
          ? "OPEN_COMPOSER"
          : script === COMMIT_REPLACEMENT
            ? "COMMIT_REPLACEMENT"
            : script === DRAFT_FACTS
              ? "DRAFT_FACTS"
              : "OTHER";
      timeline.push(name);
      calls.push({ name, params });
      if (name === "DRAFT_FACTS") return FACTS;
      if (name === "OPEN_COMPOSER") {
        if (over.openThrows) throw new Error("Mail did not return a composer for the reply.");
        opened = { subject: String(params.subject) };
        const recipients = params.recipients as Record<string, string[]>;
        return {
          subject: opened.subject,
          recipients: over.dropsRecipients ? { to: [], cc: [], bcc: [] } : recipients,
        };
      }
      if (name === "COMMIT_REPLACEMENT") {
        if (over.commit instanceof Error) throw over.commit;
        return (
          over.commit ?? {
            replaced: true,
            newId: 99,
            confirmedId: 99,
            draftsMailbox: "Drafts",
            originalDeleted: true,
          }
        );
      }
      return {};
    }) as OsascriptRunner["run"],
  };

  const deps: RebuildDeps = {
    lane,
    runner,
    messageFile: async () => ({ found: true, path: over.path ?? FIXTURE }),
    findOriginal: async () => over.original ?? { ref: ORIGINAL },
    composerTimeoutMs: 50,
  };
  const named = (name: string) => calls.filter((c) => c.name === name);
  return { deps, timeline, edits, calls, named, filesSeen, runner, lane };
};

/** The steps that matter, without the listings around them. */
const steps = (timeline: string[]) => timeline.filter((s) => s !== "composers");

describe("rebuilding a closed reply draft", () => {
  it("rebuilds a closed reply draft as a reply to its original, with its recipients", async () => {
    const { deps, timeline, named } = world();
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });

    expect(result).toMatchObject({
      replaced: true,
      method: "rebuild",
      subject: SUBJECT,
      threadingKept: true,
      inReplyTo: ORIGINAL_ID,
      originalDeleted: true,
    });
    expect(named("OPEN_COMPOSER")[0]?.params).toEqual({
      mode: "reply",
      accountUuid: ORIGINAL.accountUuid,
      mailbox: "INBOX",
      id: 7,
      replyToAll: false,
      subject: SUBJECT,
      recipients: { to: ["ann@example.com"], cc: ["cy@example.com"], bcc: [] },
    });
    // Opened, quote compared, filled and saved, and only THEN the original deleted.
    expect(steps(timeline)).toEqual([
      "OPEN_COMPOSER",
      "composers:20000",
      "edit",
      "COMMIT_REPLACEMENT",
    ]);
    expect(named("COMMIT_REPLACEMENT")[0]?.params).toMatchObject({
      ...TARGET,
      subject: SUBJECT,
      inReplyTo: ORIGINAL_ID,
      head: "BRAVO",
      before: [42],
      files: [],
    });
    // When the composer was asked for, which the new draft's Date header must follow.
    const openedAt = named("COMMIT_REPLACEMENT")[0]?.params.openedAt as number;
    expect(openedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(openedAt).toBeLessThanOrEqual(Date.now());
  });

  it("rebuilds a formatted draft by pasting its own HTML with its text as body", async () => {
    const { deps, edits } = world();
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS });
    expect(result).toMatchObject({ replaced: true });
    expect(edits).toHaveLength(1);
    const args = edits[0] as { composer: string; html: string; body: string; save: boolean };
    expect(args.composer).toBe("mc-new");
    expect(args.save).toBe(true);
    expect(args.html).toContain("<b>right</b>");
    expect(args.html).toContain('<a href="https://example.com/Ann">the sheet</a>');
    // Only the sender's own part: the quote comes from the reply itself.
    expect(args.html).not.toMatch(/AppleOriginalContents|blockquote|<body|<html/);
    expect(args.body.replace(/\s+/g, " ").trim()).toBe(
      "Thanks Ann, the numbers look right. See the sheet.",
    );
  });

  it("pastes a whole new body as plain text, without the old HTML", async () => {
    const { deps, edits } = world();
    await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(edits[0]).toEqual({ composer: "mc-new", body: "BRAVO", save: true });
  });

  it("applies edits to the own HTML's text, not its tags", async () => {
    const { deps, edits } = world();
    const result = await rebuildDraft(deps, TARGET, {
      facts: FACTS,
      edits: [{ find: "Ann", replace: "Anne" }],
    });
    expect(result).toMatchObject({ replaced: true });
    const args = edits[0] as { html: string; body: string };
    // The link's address carries "Ann" too; only the text changed.
    expect(args.html).toContain("Thanks Anne, the numbers look <b>right</b>.");
    expect(args.html).toContain('href="https://example.com/Ann"');
    expect(args.body.replace(/\s+/g, " ").trim()).toBe(
      "Thanks Anne, the numbers look right. See the sheet.",
    );
  });

  it("refuses an edit that spans formatting", async () => {
    const { deps, timeline } = world();
    const result = await rebuildDraft(deps, TARGET, {
      facts: FACTS,
      edits: [{ find: "look right", replace: "look fine" }],
    });
    expect(result).toMatchObject({ replaced: false, capability: "edits" });
    expect(String(result.reason)).toMatch(/across formatting can only be made in the open window/);
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses an edit whose text is not there, before opening anything", async () => {
    const { deps, timeline } = world();
    const result = await rebuildDraft(deps, TARGET, {
      facts: FACTS,
      edits: [{ find: "quarterly", replace: "yearly" }],
    });
    // The quote is not the sender's text, so it is not searched.
    expect(result).toMatchObject({ replaced: false, capability: "edits", find: "quarterly" });
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses while a composer with the same subject is open", async () => {
    const { deps, timeline, edits } = world({ open: [{ subject: SUBJECT }] });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String(result.reason)).toMatch(/mc-0/);
    expect(String(result.hint)).toMatch(/close that window first/i);
    expect(timeline).not.toContain("OPEN_COMPOSER");
    expect(edits).toEqual([]);
  });

  /*
   * A tab Mail is not showing carries no window title, but it is listed with
   * its subject, so the preflight sees a draft open in a background tab too.
   */
  it("refuses while a background tab carries the subject", async () => {
    const { deps, timeline, edits } = world({
      open: [
        { subject: "Another draft", tab: "selected", text: "x" },
        { subject: SUBJECT, tab: "background", text: null, recipients: null, quoted: null },
      ],
    });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String(result.reason)).toMatch(/mc-1/);
    expect(timeline).not.toContain("OPEN_COMPOSER");
    expect(edits).toEqual([]);
  });

  it("refuses when the regenerated quote differs, and the original is not deleted", async () => {
    const { deps, timeline, edits } = world({
      newQuote: "On 22 Oct 2026, at 11:30, Ann Example <ann@example.com> wrote:\nOther numbers.",
    });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "quote", composer: "mc-new" });
    expect(String(result.reason)).toMatch(/original draft was not changed/i);
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(edits).toEqual([]);
    expect(timeline).not.toContain("COMMIT_REPLACEMENT");
  });

  it("compares only the common opening when the composer's quote was cut short", async () => {
    const { deps } = world({ newQuote: "On 22 Oct 2026, at 11:30, Ann", newQuoteTruncated: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: true });
  });

  it("refuses when Mail did not take the draft's recipients", async () => {
    const { deps, timeline } = world({ dropsRecipients: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "recipients" });
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(timeline).not.toContain("edit");
  });

  it("refuses a forward draft", async () => {
    const path = emlx(fixtureMime().replace(/^In-Reply-To: .*\n/m, ""));
    const { deps, timeline } = world({ path });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "forward" });
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses when the original is not in the index", async () => {
    const { deps, timeline } = world({ original: { missing: "not-found" } });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "original" });
    expect(String(result.reason)).toContain(ORIGINAL_ID);
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses when the original is only in another account than the draft's", async () => {
    const { deps, timeline } = world({ original: { missing: "other-account" } });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "original" });
    expect(String(result.reason)).toMatch(/only in another account/);
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses when the index cannot look a message up by its Message-ID", async () => {
    const { deps, timeline } = world({ original: { missing: "column" } });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "original" });
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("refuses a draft that is not in Drafts", async () => {
    const { deps, timeline } = world();
    const result = await rebuildDraft(
      deps,
      { ...TARGET, mailbox: "Sent Messages" },
      { facts: FACTS, body: "BRAVO" },
    );
    expect(result).toMatchObject({ replaced: false, capability: "draft" });
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });

  it("re-attaches the draft's own attachments and removes the temp directory", async () => {
    const { deps, edits, filesSeen } = world({ path: withAttachment() });
    const result = await rebuildDraft(deps, TARGET, {
      facts: { ...FACTS, contentHead: "Here is the report.", attachments: 1 },
    });
    expect(result).toMatchObject({
      replaced: true,
      attachmentsKept: 1,
      filesAdded: ["report.pdf"],
    });
    const args = edits[0] as { html: string; body: string; attachments: string[] };
    expect(args.body.replace(/\s+/g, " ").trim()).toBe("Here is the report.");
    expect(args.html).not.toContain("AppleOriginalContents");
    expect(args.attachments.map((p) => basename(p))).toEqual(["report.pdf"]);
    const dir = dirname(args.attachments[0] as string);
    expect(basename(dir)).toMatch(/^cupertino-rebuild-/);
    expect(filesSeen).toEqual([{ path: args.attachments[0], existed: true }]);
    expect(existsSync(dir)).toBe(false);
  });

  it("adds new files after the draft's own", async () => {
    const extra = join(scratch, "notes.txt");
    writeFileSync(extra, "notes");
    const { deps, edits } = world({ path: withAttachment() });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, attachments: [extra] });
    const args = edits[0] as { attachments: string[] };
    expect(args.attachments.map((p) => basename(p))).toEqual(["report.pdf", "notes.txt"]);
    expect(result).toMatchObject({ attachmentsKept: 1, attachmentsAdded: 1 });
  });

  it("keeps only the base name of a file name that carries a path", async () => {
    const { deps, edits } = world({ path: withAttachment("../../.ssh/config") });
    await rebuildDraft(deps, TARGET, { facts: FACTS });
    const args = edits[0] as { attachments: string[] };
    const path = args.attachments[0] as string;
    expect(basename(path)).toBe("config");
    expect(basename(dirname(path))).toMatch(/^cupertino-rebuild-/);
  });

  it("removes the temp directory when a step throws", async () => {
    const { deps, filesSeen } = world({ path: withAttachment(), editThrows: true });
    await rebuildDraft(deps, TARGET, { facts: FACTS });
    expect(filesSeen).toHaveLength(1);
    expect(existsSync(dirname((filesSeen[0] as { path: string }).path))).toBe(false);
  });

  /* A throw once a window exists is a refusal that names the window, never a bare error. */
  it("refuses, naming the open window, when the app throws mid-fill", async () => {
    const { deps, timeline } = world({ path: withAttachment(), editThrows: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS });
    expect(result).toMatchObject({
      replaced: false,
      capability: "confirmation",
      composer: "mc-new",
    });
    expect(String(result.reason)).toMatch(/went away/);
    expect(String(result.reason)).toMatch(/original draft was not changed/i);
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(timeline).not.toContain("COMMIT_REPLACEMENT");
  });

  it("refuses with the window unknown when Mail fails after opening it", async () => {
    const { deps, timeline } = world({ openThrows: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "composer", composer: "unknown" });
    expect(String(result.reason)).toMatch(/did not return a composer/);
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(timeline).not.toContain("edit");
  });

  /* Nothing is reported as the draft's text that the app did not read back. */
  it("refuses when the app gives back no reading of the text", async () => {
    const { deps, timeline } = world({ noReadBack: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "confirmation" });
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(timeline).not.toContain("COMMIT_REPLACEMENT");
  });

  /* The quote's images are the original's: the new reply quotes them itself. */
  it("does not re-attach an image the quoted original shows", async () => {
    const { deps, edits } = world({ path: withAttachment("report.pdf", "stored") });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS });
    expect(result).toMatchObject({ replaced: true, attachmentsKept: 1 });
    const args = edits[0] as { attachments: string[] };
    expect(args.attachments.map((p) => basename(p))).toEqual(["report.pdf"]);
  });

  it("is not stopped by a quoted image that is not stored on this Mac", async () => {
    const { deps, edits } = world({ path: withAttachment("report.pdf", "missing") });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS });
    expect(result).toMatchObject({ replaced: true });
    const args = edits[0] as { attachments: string[] };
    expect(args.attachments.map((p) => basename(p))).toEqual(["report.pdf"]);
  });

  /* Unfilled or unsaved new draft, untouched original: the commit is never reached. */
  it("does not commit a draft the app could not fill", async () => {
    const { deps, timeline } = world({ editRefuses: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({
      replaced: false,
      capability: "confirmation",
      composer: "mc-new",
    });
    expect(String(result.reason)).toMatch(/original draft was not changed/i);
    expect(String(result.hint)).toMatch(/without saving/i);
    expect(timeline).not.toContain("COMMIT_REPLACEMENT");
  });

  it("does not commit a draft the app filled but could not save", async () => {
    const { deps, timeline } = world({ unsaved: true });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "confirmation" });
    expect(timeline).not.toContain("COMMIT_REPLACEMENT");
  });

  it("keeps both drafts and says so when the new one cannot be confirmed", async () => {
    const { deps } = world({ commit: new Error("Can't get object.") });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "confirmation" });
    expect(String(result.reason)).toMatch(/two drafts now exist/i);
    expect(String(result.reason)).toMatch(/original was not deleted/i);
  });

  it("returns the commit's own refusal when it could not confirm", async () => {
    const refusal = {
      replaced: false,
      degraded: true,
      capability: "confirmation",
      reason: "The new draft never appeared in Drafts. Two drafts now exist.",
    };
    const { deps } = world({ commit: refusal });
    const result = await rebuildDraft(deps, TARGET, { facts: FACTS, body: "BRAVO" });
    expect(result).toMatchObject({ ...refusal, method: "rebuild" });
  });
});

describe("rebuilding a closed draft that is not a reply", () => {
  const fresh = () =>
    emlx(
      [
        "From: Olivier Louvignes <olivier@example.com>",
        'Content-Type: multipart/alternative; boundary="ALT"',
        "X-Uniform-Type-Identifier: com.apple.mail-draft",
        "Subject: GPU VMs",
        'To: Dave <dave@example.com>, "Smith, Arkadi" <arkadi@example.com>',
        "Bcc: me@example.com",
        "Message-Id: <draft-3@example.com>",
        "",
        "--ALT",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Hi Dave, the VMs are up.",
        "--ALT",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><head></head><body><div>Hi Dave, the VMs are <i>up</i>.</div></body></html>",
        "--ALT--",
        "",
      ].join("\n"),
    );
  const facts = { ...FACTS, subject: "GPU VMs", isReply: false, siblings: [42] };

  it("opens a new message with its recipients and subject, and compares no quote", async () => {
    const { deps, timeline, named, edits } = world({ path: fresh() });
    const result = await rebuildDraft(deps, TARGET, { facts });
    expect(result).toMatchObject({ replaced: true, threadingKept: false, inReplyTo: null });
    expect(named("OPEN_COMPOSER")[0]?.params).toEqual({
      mode: "new",
      accountUuid: TARGET.accountUuid,
      subject: "GPU VMs",
      senderAddress: "olivier@example.com",
      to: ["dave@example.com", "arkadi@example.com"],
      cc: [],
      bcc: ["me@example.com"],
      recipients: {
        to: ["dave@example.com", "arkadi@example.com"],
        cc: [],
        bcc: ["me@example.com"],
      },
    });
    expect(steps(timeline)).toEqual(["OPEN_COMPOSER", "edit", "COMMIT_REPLACEMENT"]);
    expect((edits[0] as { html: string }).html).toBe("<div>Hi Dave, the VMs are <i>up</i>.</div>");
    expect(named("COMMIT_REPLACEMENT")[0]?.params).toMatchObject({ inReplyTo: null });
  });

  it("applies a new subject through the override", async () => {
    const { deps, named } = world({ path: fresh() });
    await rebuildDraft(deps, TARGET, { facts, subject: "GPU VMs, ready" });
    expect(named("OPEN_COMPOSER")[0]?.params).toMatchObject({ subject: "GPU VMs, ready" });
    expect(named("COMMIT_REPLACEMENT")[0]?.params).toMatchObject({ subject: "GPU VMs, ready" });
  });

  /* A quoted original with nothing saying what it answers could be a forward. */
  it("refuses a draft that holds a quoted original but answers nothing", async () => {
    const path = emlx(
      fixtureMime()
        .replace(/^In-Reply-To: .*\n/m, "")
        .replace(/^References: .*\n/m, ""),
    );
    const { deps, timeline } = world({ path });
    const result = await rebuildDraft(deps, TARGET, { facts, body: "BRAVO" });
    expect(result).toMatchObject({ replaced: false, capability: "forward" });
    expect(timeline).not.toContain("OPEN_COMPOSER");
  });
});

describe("the route a closed draft takes through updateDraft", () => {
  const REF = `m1:${TARGET.accountUuid}/Drafts#42`;

  const client = (composers: Partial<NativeComposer>[]) => {
    const scripts: string[] = [];
    const runner: OsascriptRunner = {
      run: vi.fn(async (script: string) => {
        scripts.push(script === DRAFT_FACTS ? "DRAFT_FACTS" : "OTHER");
        return FACTS;
      }) as OsascriptRunner["run"],
    };
    const lane = {
      watch: () => ({ check: async () => null }),
      reach: async () => ({ ok: true, reason: null, windows: [] }),
      composers: async () =>
        composers.map((c, at) => ({
          composer: `mc-${at}`,
          subject: SUBJECT,
          recipients: [],
          text: "Thanks Ann, the numbers look right.",
          quoted: true,
          files: [],
          ...c,
        })),
      editComposer: vi.fn(),
    } as unknown as MailAxLane;
    return {
      scripts,
      lane,
      client: new AppleMailClient({
        config: loadConfig({ APPLE_MAIL_ENVELOPE_INDEX: "/nonexistent/Envelope Index" }),
        osascript: runner,
        ax: lane,
      }),
    };
  };

  it("refuses a subject change while the window is open", async () => {
    const { client: mail, scripts, lane } = client([{}]);
    const result = await mail.updateDraft({ ref: REF }, { body: "BRAVO", subject: "New subject" });
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(String(result.reason)).toMatch(
      /close the draft's window first, then change the subject/,
    );
    expect(scripts).toEqual(["DRAFT_FACTS"]);
    expect(vi.mocked(lane.editComposer)).not.toHaveBeenCalled();
  });
});

/*
 * Which copy of the original to reply to. Mail sends a reply from the account
 * the original is in, so only a copy in the draft's own account will do.
 */
describe("picking the original", () => {
  const OTHER = "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D";
  const places = new Map([
    [1, { accountUuid: OTHER, mailbox: "INBOX" }],
    [2, { accountUuid: TARGET.accountUuid, mailbox: "Archive" }],
  ]);
  const place = (mailbox: number) => places.get(mailbox);

  it("prefers a row in the draft's own account over an earlier one elsewhere", () => {
    const rows = [
      { rowid: 501, mailbox: 1 },
      { rowid: 502, mailbox: 2 },
    ];
    expect(pickOriginal(rows, place, TARGET.accountUuid)).toEqual({
      ref: { accountUuid: TARGET.accountUuid, mailbox: "Archive", id: 502 },
    });
  });

  it("says so when the original is only in another account", () => {
    expect(pickOriginal([{ rowid: 501, mailbox: 1 }], place, TARGET.accountUuid)).toEqual({
      missing: "other-account",
    });
  });

  it("is not found when no row maps onto a mailbox at all", () => {
    expect(pickOriginal([{ rowid: 503, mailbox: 9 }], place, TARGET.accountUuid)).toEqual({
      missing: "not-found",
    });
  });
});
