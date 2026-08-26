import { describe, expect, it } from "vitest";

import { UPDATE_DRAFT } from "../src/client/jxa/write.js";

/**
 * The draft-rewrite script, run for real against a fake Mail.
 *
 * Same approach as `compose-body.test.ts`, for a sharper reason. This script
 * DELETES something the user wrote, and it is allowed to do that only once a
 * replacement has been confirmed to exist. Every interesting failure is Mail
 * accepting an instruction and not carrying it out — `save()` returning quietly
 * with nothing saved is the exact shape of the bug the compose path already
 * shipped once — so the fake below is built to lie in that way, and the
 * assertion that matters is always the same one: **the original is still there.**
 */

type MailBehaviour = {
  /** Polls before the replacement shows up in Drafts. Infinity: it never does. */
  savedAfterPolls?: number;
  /** save() raises, the way a scripting command that cannot run does. */
  saveThrows?: boolean;
  /** The message is a reply: its headers carry the threading. */
  headers?: string;
  attachments?: number;
  /** Which mailbox the ref resolves into. Anything but Drafts is not a draft. */
  mailbox?: string;
  subject?: string;
  /** Deleting the original fails after the replacement is safely in place. */
  deleteThrows?: boolean;
  /**
   * `account.draftsMailbox` works. It does NOT on any account measured — the
   * default here is the real behaviour, and `true` is the hypothetical.
   */
  accountDraftsMailboxWorks?: boolean;
  /** All Drafts cannot be reached either, so nothing identifies the mailbox. */
  allDraftsUnavailable?: boolean;
  /**
   * The row id of the original is rewritten by sync mid-script, invalidating
   * any reference held across the polling loop. Measured on iCloud.
   */
  staleAfterPolling?: boolean;
};

const ORIGINAL_ID = 42;

const addressee = (address: string) => ({ address: () => address });

const runScript = (params: Record<string, unknown>, behaviour: MailBehaviour = {}) => {
  const {
    savedAfterPolls = 0,
    saveThrows = false,
    headers = "From: me@example.com\r\nSubject: Quarterly numbers\r\n",
    attachments = 0,
    mailbox = "Drafts",
    subject = "Quarterly numbers",
    deleteThrows = false,
    accountDraftsMailboxWorks = false,
    allDraftsUnavailable = false,
    staleAfterPolling = false,
  } = behaviour;

  const state = {
    polls: 0,
    saves: 0,
    composed: null as null | { subject: string; content: string; visible: boolean },
    to: [] as string[],
    cc: [] as string[],
    bcc: [] as string[],
    sender: null as string | null,
    deleted: [] as number[],
    /** Rows the Drafts mailbox reports. The replacement is added on save.  */
    draftRows: [{ id: ORIGINAL_ID, subject }],
  };

  const original = {
    id: () => ORIGINAL_ID,
    subject: () => subject,
    sender: () => "me@example.com",
    allHeaders: () => headers,
    mailAttachments: () => Array.from({ length: attachments }, (_, i) => ({ name: () => `f${i}` })),
    toRecipients: () => [addressee("ada@example.com")],
    ccRecipients: () => [addressee("bob@example.com")],
    bccRecipients: () => [],
  };

  const draftsMailbox = {
    name: () => "Drafts",
    account: () => account,
    messages: Object.assign(() => state.draftRows.map((r) => ({ id: () => r.id })), {
      // Mail hands back a live reference. On a syncing account the row is
      // renumbered underneath it, and the reference — not the id — goes dead.
      byId: () => ({ ...original, bornAt: state.polls }),
      whose: (spec: { subject: string }) => () => {
        // The replacement only becomes visible once Mail has caught up.
        if (state.saves > 0 && ++state.polls >= savedAfterPolls) {
          if (!state.draftRows.some((r) => r.id === 99)) {
            state.draftRows.push({ id: 99, subject: state.composed?.subject ?? "" });
          }
        }
        return state.draftRows
          .filter((r) => r.subject === spec.subject)
          .map((r) => ({ id: () => r.id }));
      },
    }),
  };
  const refMailbox =
    mailbox === "Drafts"
      ? draftsMailbox
      : { name: () => mailbox, messages: { byId: () => original } };

  const account: any = {
    id: () => "UUID",
    name: () => "iCloud",
    mailboxes: () => [refMailbox],
    // The measured default: in the dictionary, and raises on every account.
    draftsMailbox: () => {
      if (accountDraftsMailboxWorks) return draftsMailbox;
      throw new Error("Can't get object.");
    },
    moveDeletedMessagesToTrash: () => true,
  };

  const mail = {
    accounts: () => [account],
    // The unified smart mailbox, which does resolve. Its members report their
    // real per-account container, which is how the name is discovered.
    draftsMailbox: () => {
      if (allDraftsUnavailable) throw new Error("Can't get object.");
      return {
        name: () => "All Drafts",
        messages: () => state.draftRows.map(() => ({ mailbox: () => draftsMailbox })),
      };
    },
    OutgoingMessage: (spec: { subject: string; content: string; visible: boolean }) => {
      state.composed = spec;
      return {
        set sender(v: string) {
          state.sender = v;
        },
        save: () => {
          state.saves++;
          if (saveThrows) throw new Error("save is not supported here");
        },
        toRecipients: { push: (r: { address: string }) => state.to.push(r.address) },
        ccRecipients: { push: (r: { address: string }) => state.cc.push(r.address) },
        bccRecipients: { push: (r: { address: string }) => state.bcc.push(r.address) },
      };
    },
    outgoingMessages: { push: () => undefined },
    ToRecipient: (spec: { address: string }) => spec,
    CcRecipient: (spec: { address: string }) => spec,
    BccRecipient: (spec: { address: string }) => spec,
    delete: (m: { id: () => number; bornAt?: number }) => {
      if (deleteThrows) throw new Error("the server refused the delete");
      if (staleAfterPolling && m.bornAt !== state.polls) throw new Error("Can't get object.");
      state.deleted.push(m.id());
      state.draftRows = state.draftRows.filter((r) => r.id !== m.id());
    },
  };

  // stripCitation drives System Events, and the script already treats a failure
  // there as cosmetic. A throwing stub proves that stays true.
  const systemEvents = {
    processes: {
      byName: () => {
        throw new Error("no System Events in this test");
      },
    },
    applicationProcesses: {
      whose: () => {
        throw new Error("no System Events in this test");
      },
    },
  };

  const Application = (name: string) => (name === "Mail" ? mail : systemEvents);
  const ObjC = { import: () => undefined, unwrap: (v: { value: string }) => v.value };
  const dollar: any = ((value: string) => ({ value })) as any;
  dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
  dollar.NSThread = { sleepForTimeInterval: () => undefined };
  dollar.NSPasteboardTypeString = "public.utf8-plain-text";
  dollar.NSPasteboard = { generalPasteboard: {} };

  const factory = new Function("ObjC", "Application", "$", `${UPDATE_DRAFT}\nreturn run;`);
  const run = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([
      JSON.stringify({
        accountUuid: "UUID",
        mailbox,
        id: ORIGINAL_ID,
        body: "The revised numbers are attached below.",
        subject: null,
        ...params,
      }),
    ]),
  );
  return { envelope, state };
};

const REPLY_HEADERS =
  "From: me@example.com\r\nIn-Reply-To: <abc@example.com>\r\nReferences: <abc@example.com>\r\n";

describe("rewriting a draft", () => {
  it("composes a replacement carrying the original's recipients and deletes the old one", () => {
    const { envelope, state } = runScript({});
    expect(envelope.ok).toBe(true);
    expect(envelope.data.replaced).toBe(true);
    expect(envelope.data.newId).toBe(99);
    expect(state.composed).toMatchObject({
      subject: "Quarterly numbers",
      content: "The revised numbers are attached below.",
    });
    expect(state.to).toEqual(["ada@example.com"]);
    expect(state.cc).toEqual(["bob@example.com"]);
    expect(state.sender).toBe("me@example.com");
    expect(state.deleted).toEqual([ORIGINAL_ID]);
  });

  it("takes a new subject when one is given", () => {
    const { envelope, state } = runScript({ subject: "Revised numbers" });
    expect(state.composed?.subject).toBe("Revised numbers");
    expect(envelope.data.subject).toBe("Revised numbers");
  });

  it("waits for Mail to catch up rather than giving up on the first look", () => {
    const { envelope, state } = runScript({}, { savedAfterPolls: 4 });
    expect(envelope.data.replaced).toBe(true);
    expect(state.deleted).toEqual([ORIGINAL_ID]);
  });

  it("reports the account's Trash setting, so recoverability is visible", () => {
    expect(runScript({}).envelope.data.originalMovedToTrash).toBe(true);
  });

  /** Cosmetic, and already wrapped: a broken System Events must not lose a draft. */
  it("still completes when the citation strip cannot run", () => {
    const { envelope } = runScript({});
    expect(envelope.data.unquoted).toBe(false);
    expect(envelope.data.replaced).toBe(true);
  });
});

/**
 * The half that matters. Each of these ends the same way, and the assertion is
 * always `state.deleted` being empty: whatever else went wrong, what the user
 * wrote is still in Mail.
 */
describe("refusing rather than losing the draft", () => {
  it("does not delete the original when the replacement never appears", () => {
    const { envelope, state } = runScript({}, { savedAfterPolls: Infinity });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.replaced).toBe(false);
    expect(envelope.data.capability).toBe("confirmation");
    expect(envelope.data.reason).toMatch(/WAS NOT DELETED/);
    expect(state.deleted).toEqual([]);
  });

  /** save() raising is the honest failure; it must be handled like the quiet one. */
  it("does not delete the original when save raises", () => {
    const { envelope, state } = runScript({}, { saveThrows: true, savedAfterPolls: Infinity });
    expect(envelope.data.replaced).toBe(false);
    expect(envelope.data.saved).toBe(false);
    expect(state.deleted).toEqual([]);
  });

  it("refuses a reply draft, before composing anything", () => {
    const { envelope, state } = runScript({}, { headers: REPLY_HEADERS });
    expect(envelope.data.replaced).toBe(false);
    expect(envelope.data.capability).toBe("threading");
    expect(envelope.data.reason).toMatch(/NEW thread/);
    expect(envelope.data.hint).toMatch(/apple_mail_reply_to_message/);
    expect(state.composed).toBeNull();
    expect(state.deleted).toEqual([]);
  });

  it("refuses a draft carrying attachments", () => {
    const { envelope, state } = runScript({}, { attachments: 2 });
    expect(envelope.data.replaced).toBe(false);
    expect(envelope.data.capability).toBe("attachments");
    expect(envelope.data.draft.attachments).toBe(2);
    expect(state.composed).toBeNull();
    expect(state.deleted).toEqual([]);
  });

  /**
   * The ref for a sent message looks exactly like the ref for a draft, and
   * "editing" a sent message by deleting it and writing a lookalike is forgery.
   */
  it("refuses anything that is not in the Drafts mailbox", () => {
    const { envelope, state } = runScript({}, { mailbox: "Sent" });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("NOT_A_DRAFT");
    expect(envelope.error.message).toMatch(/lookalike/);
    expect(state.composed).toBeNull();
    expect(state.deleted).toEqual([]);
  });

  it("refuses a draft with no subject, because it could not be found again", () => {
    const { envelope, state } = runScript({}, { subject: "" });
    expect(envelope.data.replaced).toBe(false);
    expect(envelope.data.capability).toBe("confirmation");
    expect(state.composed).toBeNull();
    expect(state.deleted).toEqual([]);
  });

  it("accepts a subject-less draft once a subject is supplied", () => {
    const { envelope } = runScript({ subject: "Now it has one" }, { subject: "" });
    expect(envelope.data.replaced).toBe(true);
  });

  /** The replacement is safe; only the cleanup failed. Say so rather than lie. */
  it("reports a failed cleanup instead of claiming a clean swap", () => {
    const { envelope, state } = runScript({}, { deleteThrows: true });
    expect(envelope.data.replaced).toBe(true);
    expect(envelope.data.originalDeleted).toBe(false);
    expect(envelope.data.removeError).toMatch(/refused the delete/);
    expect(state.deleted).toEqual([]);
  });
});

/**
 * Everything below was measured against a live Mail on macOS 26.6 and is not in
 * any documentation. The fake above defaults to the REAL behaviour — an account
 * whose draftsMailbox raises — so these are the assertions that would have
 * caught a fake more capable than the thing it stands in for.
 */
describe("finding the Drafts mailbox, which the dictionary lies about", () => {
  /**
   * `account.draftsMailbox` is declared access="r" and raises "Can't get
   * object." on every account measured: iCloud, two IMAP, one Exchange. The
   * name is discovered from All Drafts instead, whose members report their real
   * per-account container.
   */
  it("discovers the mailbox from All Drafts when the account property raises", () => {
    const { envelope, state } = runScript({});
    expect(envelope.ok).toBe(true);
    expect(envelope.data.replaced).toBe(true);
    expect(state.deleted).toEqual([ORIGINAL_ID]);
  });

  /** Tried first regardless, so this repairs itself if Apple ever fixes it. */
  it("prefers the documented property when it does work", () => {
    const { envelope } = runScript({}, { accountDraftsMailboxWorks: true });
    expect(envelope.data.replaced).toBe(true);
  });

  it("refuses when neither route identifies the mailbox", () => {
    const { envelope, state } = runScript({}, { allDraftsUnavailable: true });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("DRAFTS_MAILBOX_UNKNOWN");
    expect(state.composed).toBeNull();
    expect(state.deleted).toEqual([]);
  });
});

describe("references that go stale mid-script", () => {
  /**
   * Measured: a confirmed draft moved from row 199625 to 199626 while the probe
   * was still running, and the reference held across that gap died with "Can't
   * get object." — which is how the probe's own cleanup failed and left a stray
   * draft behind. The original is refetched by id immediately before the delete
   * rather than reused from the top of the script.
   */
  it("refetches the original instead of reusing a reference held across polling", () => {
    const { envelope, state } = runScript({}, { staleAfterPolling: true });
    expect(envelope.data.replaced).toBe(true);
    expect(envelope.data.originalDeleted).toBe(true);
    expect(state.deleted).toEqual([ORIGINAL_ID]);
  });

  /** The same rewrite can renumber the replacement between confirming and returning. */
  it("reports the id read back last, and the one it confirmed, separately", () => {
    const { envelope } = runScript({});
    expect(envelope.data.newId).toBe(99);
    expect(envelope.data.confirmedId).toBe(99);
  });
});
