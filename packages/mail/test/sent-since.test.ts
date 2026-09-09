import { describe, expect, it } from "vitest";

import { SENT_SINCE } from "../src/client/jxa/read.js";

/**
 * The Sent lookup, run for real against a fake Mail.
 *
 * It exists to answer one question, on one path: a compose whose composer window
 * has GONE cannot tell a reply that was sent from one that was discarded, and
 * both readings are expensive to get wrong. So the answers this returns are load
 * bearing in a way a listing's are not, and the ways it can be wrong are all
 * quiet ones — a mailbox that resolves to the wrong thing, a date comparison off
 * by a timezone, a head that is not the newest.
 */

type MailBehaviour = {
  /** `account.sentMailbox` resolves. It does not, on any real account. */
  accountBoxWorks?: boolean;
  /** Neither the account's nor the application's sent mailbox can be reached. */
  noSentMailbox?: boolean;
  /** What is in Sent, newest first, as [subject, ISO date sent]. */
  messages?: [string, string][];
  /** Mail answers for dateSent with nothing, the way it does for some accounts. */
  noDateSent?: boolean;
};

/** The Objective-C bridge, as much of it as the prelude touches. */
const ObjC = { import: () => undefined, unwrap: (v: { value: string }) => v.value };
const dollar: any = (value: string) => ({ value });
dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
dollar.NSThread = { sleepForTimeInterval: () => undefined };

const runScript = (params: Record<string, unknown>, behaviour: MailBehaviour = {}) => {
  const {
    accountBoxWorks = false,
    noSentMailbox = false,
    messages = [],
    noDateSent = false,
  } = behaviour;

  const state = { resolvedVia: null as string | null };

  const boxNamed = (name: string) => ({
    name: () => name,
    messages: Object.assign(
      {
        // The batched read: one Apple Event per property across a range.
        slice: (from: number, to: number) => {
          const window = messages.slice(from, to);
          return {
            subject: () => window.map(([subject]) => subject),
            dateSent: () => (noDateSent ? [] : window.map(([, date]) => new Date(date))),
            dateReceived: () => window.map(([, date]) => new Date(date)),
          };
        },
      },
      { length: messages.length },
    ),
  });

  const account = {
    id: () => "UUID",
    sentMailbox: () => {
      if (!accountBoxWorks) throw new Error("Can't get object.");
      state.resolvedVia = "account";
      return boxNamed("Sent Items");
    },
  };
  const mail = {
    accounts: () => [account],
    sentMailbox: () => {
      if (noSentMailbox) throw new Error("Can't get object.");
      state.resolvedVia = "application";
      return boxNamed("All Sent");
    },
  };

  const Application = (name: string) => (name === "Mail" ? mail : { processes: {} });

  const factory = new Function("ObjC", "Application", "$", `${SENT_SINCE}\nreturn run;`);
  const run = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  return { envelope: JSON.parse(run([JSON.stringify(params)])), state };
};

const SUBJECT = "Re: [EXT] dev-rgis-ar | read access + retention rule";
const SENT_AT = "2026-09-09T20:56:54.000Z";
const FLOOR = Date.parse("2026-09-09T20:54:00.000Z");

describe("SENT_SINCE", () => {
  it("finds the reply that went out, and says when", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { messages: [[SUBJECT, SENT_AT]] },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.data.found).toBe(true);
    expect(envelope.data.messages[0].dateSent).toBe(SENT_AT);
  });

  /*
   * The reply's account need not be the account the original was read in — Mail
   * decides which one it sends from. The unified mailbox does not care, which is
   * why it is preferred over the per-account one even when that resolves.
   */
  it("falls back to the application's unified mailbox, which is what actually resolves", () => {
    const { envelope, state } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { messages: [[SUBJECT, SENT_AT]] },
    );
    expect(state.resolvedVia).toBe("application");
    expect(envelope.data.mailbox).toBe("All Sent");
  });

  /*
   * Still tried first, so this repairs itself if Apple ever fixes the property
   * `docs/mail-compose.md` measured answering "Can't get object." on all four
   * account types.
   */
  it("prefers the documented per-account property when it works", () => {
    const { envelope, state } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { accountBoxWorks: true, messages: [[SUBJECT, SENT_AT]] },
    );
    expect(state.resolvedVia).toBe("account");
    expect(envelope.data.mailbox).toBe("Sent Items");
  });

  /*
   * The thread already holds older replies with the identical subject — that is
   * what a reply IS. Only one of them can be this call's.
   */
  it("does not mistake an earlier reply on the same thread for this one", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { messages: [[SUBJECT, "2026-09-02T14:40:00.000Z"]] },
    );
    expect(envelope.data.found).toBe(false);
  });

  it("says nothing was found rather than matching a different subject", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { messages: [["Re: Governance layer for AI assistant", SENT_AT]] },
    );
    expect(envelope.data.found).toBe(false);
  });

  /*
   * `found: false` is only evidence if the listing was showing recent mail. The
   * caller compares `newest` against its own floor to tell "not sent" from "this
   * listing never showed me anything recent" — a false negative here invites a
   * second send.
   */
  it("reports the newest it saw, so a caller can tell a real miss from a blind one", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { messages: [["something else", "2019-01-01T00:00:00.000Z"]] },
    );
    expect(envelope.data.found).toBe(false);
    expect(envelope.data.newest).toBe("2019-01-01T00:00:00.000Z");
  });

  /* Some accounts do not answer for dateSent. dateReceived still dates the row. */
  it("dates the message by when it arrived when Mail will not say when it was sent", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { noDateSent: true, messages: [[SUBJECT, SENT_AT]] },
    );
    expect(envelope.data.found).toBe(true);
    expect(envelope.data.messages[0].dateReceived).toBe(SENT_AT);
  });

  /*
   * Saying "not sent" because no mailbox could be reached would be a guess
   * dressed as an answer, on the one question where guessing costs a duplicate.
   */
  it("refuses to answer at all when no Sent mailbox can be reached", () => {
    const { envelope } = runScript(
      {
        accountUuid: "UUID",
        subject: SUBJECT,
        sinceMs: FLOOR,
      },
      { noSentMailbox: true },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.data.checked).toBe(false);
    expect(envelope.data.found).toBe(false);
  });

  it("handles an empty Sent mailbox without inventing a match", () => {
    const { envelope } = runScript({ accountUuid: "UUID", subject: SUBJECT, sinceMs: FLOOR });
    expect(envelope.data.checked).toBe(true);
    expect(envelope.data.found).toBe(false);
  });
});
