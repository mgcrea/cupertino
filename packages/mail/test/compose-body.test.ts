import { describe, expect, it } from "vitest";

import { REPLY_OR_FORWARD } from "../src/client/jxa/write.js";

/**
 * The reply/forward script, run for real.
 *
 * JXA is plain JavaScript, so the script that ships can be executed here
 * against a fake Mail instead of being asserted on as a string. That matters
 * for this particular script: the bug it exists to prevent was a *timing* one —
 * Mail returns a composer reference before the window exists and drops anything
 * assigned in the gap, silently — and no amount of "the source contains the
 * word content" catches a regression in that.
 */

type ComposerOptions = {
  /** Reads of `content` that return "" before the composer becomes real. */
  readyAfterReads?: number;
  /** Writes are dropped until the composer is real, exactly as Mail drops them. */
  keepsWritesWhenNotReady?: boolean;
  /** Mail's own rewriting of what it stores, applied on read-back. */
  normalize?: (stored: string, writes: string[]) => string;
  /** A composer that takes the write but never reports it back. */
  neverReportsContent?: boolean;
};

const QUOTED = "On Tuesday, someone wrote:\n> the original message\n";

const runScript = (
  params: Record<string, unknown>,
  options: ComposerOptions = {},
): {
  envelope: { ok: boolean; data?: any; error?: { code: string; message: string } };
  composer: any;
} => {
  const {
    readyAfterReads = 0,
    keepsWritesWhenNotReady = false,
    normalize = (stored: string) => stored,
    neverReportsContent = false,
  } = options;

  let reads = 0;
  const composer = {
    stored: "",
    writes: [] as string[],
    ready: readyAfterReads === 0,
    sent: false,
    recipients: [] as string[],
    get content() {
      return () => {
        if (!composer.ready && ++reads >= readyAfterReads) composer.ready = true;
        if (!composer.ready) return "";
        if (neverReportsContent) return "";
        return normalize(composer.stored, composer.writes);
      };
    },
    set content(value: unknown) {
      const text = String(value);
      composer.writes.push(text);
      // Mail raises nothing when it discards the assignment. That silence is
      // the whole bug, so the fake is silent too.
      if (composer.ready || keepsWritesWhenNotReady) composer.stored = text;
    },
    subject: () => "Re: original",
    send: () => {
      composer.sent = true;
    },
    toRecipients: {
      push: (r: { address: string }) => composer.recipients.push(r.address),
    },
  };
  // The quoted original is present from the moment the composer becomes real.
  Object.defineProperty(composer, "stored", { value: QUOTED, writable: true, enumerable: true });

  const message = { subject: () => "original", id: () => 42 };
  const mailbox = { name: () => "INBOX", messages: { byId: () => message } };
  const account = { id: () => "UUID", mailboxes: () => [mailbox] };
  const mail = {
    accounts: () => [account],
    reply: () => composer,
    forward: () => composer,
    ToRecipient: (spec: { address: string }) => spec,
  };

  const ObjC = { import: () => undefined };
  const Application = () => mail;
  const $ = {
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) },
    // Time is the thing under test, so it does not pass here: every pause is
    // free and the polling loop is driven by the read counter instead.
    NSThread: { sleepForTimeInterval: () => undefined },
  };

  const factory = new Function("ObjC", "Application", "$", `${REPLY_OR_FORWARD}\nreturn run;`);
  const run = factory(ObjC, Application, $) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([JSON.stringify({ accountUuid: "UUID", mailbox: "INBOX", id: 42, ...params })]),
  );
  return { envelope, composer };
};

const BODY = "Bonjour Arkadi,\n\n  - un point\n  - un autre\n\nBien à toi";

describe("reply body", () => {
  it("waits for the composer instead of writing into the gap", () => {
    const { envelope, composer } = runScript(
      { mode: "reply", body: BODY, replyToAll: true, sendNow: false },
      { readyAfterReads: 4 },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.data.bodyVerified).toBe(true);
    expect(composer.stored).toContain(BODY);
    // Every write landed after the composer was real: none were thrown away.
    expect(composer.writes).toHaveLength(1);
  });

  it("keeps the quoted original beneath the reply", () => {
    const { composer } = runScript({ mode: "reply", body: BODY, sendNow: false });
    expect(composer.stored).toBe(`${BODY}\n\n${QUOTED}`);
  });

  it("fails loudly rather than reporting a draft that is empty", () => {
    const { envelope } = runScript(
      { mode: "reply", body: BODY, sendNow: false },
      { readyAfterReads: 1, neverReportsContent: true },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("DRAFT_BODY_NOT_SET");
    expect(envelope.error?.message).toMatch(/EMPTY/);
  });

  it("never sends a message whose body did not take", () => {
    const { envelope, composer } = runScript(
      { mode: "reply", body: BODY, sendNow: true },
      { readyAfterReads: 1, neverReportsContent: true },
    );
    expect(envelope.ok).toBe(false);
    expect(composer.sent).toBe(false);
  });

  it("retries without stacking a second copy of the body", () => {
    // Reports back nothing after the first write, then behaves: the retry must
    // rebuild from the quote, not from whatever it just read.
    const { envelope, composer } = runScript(
      { mode: "reply", body: BODY, sendNow: false },
      { normalize: (stored, writes) => (writes.length === 1 ? "" : stored) },
    );
    expect(envelope.ok).toBe(true);
    expect(composer.writes.length).toBeGreaterThan(1);
    expect(composer.stored.split(BODY)).toHaveLength(2);
  });

  it("accepts a body Mail rewrote the whitespace of", () => {
    const { envelope } = runScript(
      { mode: "reply", body: BODY, sendNow: false },
      { normalize: (s) => s.replace(/\n/g, "\r").replace(/ {2,}/g, " ").replace(/ +\r/g, "\r") },
    );
    expect(envelope.ok).toBe(true);
    expect(envelope.data.bodyVerified).toBe(true);
  });

  it("holds accented and guillemet-bearing text", () => {
    const french = "Résumé « détaillé » : voilà où ça en est.\n\n    arbre\n    └── feuille";
    const { envelope, composer } = runScript({ mode: "reply", body: french, sendNow: false });
    expect(envelope.ok).toBe(true);
    expect(composer.stored).toContain(french);
  });

  it("addresses a forward only once the composer is real", () => {
    const { envelope, composer } = runScript(
      { mode: "forward", body: BODY, to: ["a@b.com"], sendNow: false },
      { readyAfterReads: 3 },
    );
    expect(envelope.ok).toBe(true);
    expect(composer.recipients).toEqual(["a@b.com"]);
  });

  it("forwards with no note at all", () => {
    const { envelope } = runScript({
      mode: "forward",
      to: ["a@b.com"],
      body: null,
      sendNow: false,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.bodyVerified).toBe(null);
  });
});
