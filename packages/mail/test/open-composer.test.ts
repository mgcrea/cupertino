import { describe, expect, it } from "vitest";

import { OPEN_COMPOSER } from "../src/client/jxa/write.js";

/**
 * The Apple Events half of the native composer path.
 *
 * Driven the way `compose-body.test.ts` drives the System Events one: the script
 * is a static string, so it can be evaluated against stubs and its real
 * behaviour asserted rather than its text.
 */
const nsString = (value: string) => ({ value });

/** The `$` bridge the prelude reaches for. Hoisted: it captures nothing. */
const makeDollar = () => {
  // bind() so each run gets its own function object to hang stubs on, matching
  // the harness in compose-body.test.ts.
  const dollar: any = nsString.bind(null);
  dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
  dollar.NSThread = { sleepForTimeInterval: () => undefined };
  return dollar;
};

/** JXA's Path(): a file reference, which the stubs read back as `.path`. */
const Path = (path: string) => ({ path });

const runScript = (
  params: Record<string, unknown>,
  opts: { subject?: string; messageExists?: boolean; attachFails?: boolean } = {},
) => {
  const recipients: string[] = [];
  const attached: string[] = [];
  const closed: unknown[] = [];
  const opened: { mode: string | null; replyToAll: boolean | null } = {
    mode: null,
    replyToAll: null,
  };

  const draft = {
    subject: () => opts.subject ?? "Re: lunch",
    toRecipients: { push: (r: { address: string }) => recipients.push(r.address) },
    content: {
      attachments: {
        push: (a: { fileName: { path: string } }) => {
          if (opts.attachFails) throw new Error("-10000 AppleEvent handler failed");
          attached.push(a.fileName.path);
        },
      },
    },
  };
  const message = {
    subject: () => {
      if (opts.messageExists === false) throw new Error("no such message");
      return "lunch";
    },
  };
  const mail = {
    accounts: () => [{ id: () => "UUID", name: () => "Work" }],
    reply: (_m: unknown, o: { replyToAll: boolean }) => {
      opened.mode = "reply";
      opened.replyToAll = o.replyToAll;
      return draft;
    },
    forward: () => {
      opened.mode = "forward";
      return draft;
    },
    ToRecipient: (spec: { address: string }) => spec,
    Attachment: (spec: { fileName: { path: string } }) => spec,
    close: (d: unknown) => closed.push(d),
  };
  const account = {
    id: () => "UUID",
    name: () => "Work",
    mailboxes: () => [{ name: () => "INBOX", messages: { byId: () => message } }],
  };
  mail.accounts = () => [account] as never;

  const addressed: string[] = [];
  const Application = (name: string) => {
    addressed.push(name);
    return mail;
  };
  const ObjC = { import: () => undefined, unwrap: (v: { value: string }) => v.value };
  const dollar = makeDollar();

  const factory = new Function("ObjC", "Application", "$", "Path", `${OPEN_COMPOSER}\nreturn run;`);
  const run = factory(ObjC, Application, dollar, Path) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([JSON.stringify({ accountUuid: "UUID", mailbox: "INBOX", id: 42, ...params })]),
  );
  return { envelope, recipients, opened, addressed, attached, closed };
};

describe("OPEN_COMPOSER", () => {
  /*
   * The split exists because a JXA object reference cannot outlive the osascript
   * process that made it. This half must therefore hand back something the
   * NATIVE half can address a window by, and the subject is that identity.
   */
  it("returns the subject, which is what the native half addresses the window by", () => {
    const { envelope } = runScript({ mode: "reply", replyToAll: true });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.subject).toBe("Re: lunch");
  });

  it("carries replyToAll through to Mail", () => {
    expect(runScript({ mode: "reply", replyToAll: true }).opened).toEqual({
      mode: "reply",
      replyToAll: true,
    });
    expect(runScript({ mode: "reply", replyToAll: false }).opened).toEqual({
      mode: "reply",
      replyToAll: false,
    });
  });

  /*
   * Recipients go through the scripting object, which does work for them —
   * unlike the body — and only once the composer exists.
   */
  it("addresses a forward through the scripting object", () => {
    const { recipients, opened } = runScript({
      mode: "forward",
      to: ["a@example.com", "b@example.com"],
    });
    expect(opened.mode).toBe("forward");
    expect(recipients).toEqual(["a@example.com", "b@example.com"]);
  });

  it("does not push recipients on a reply", () => {
    expect(runScript({ mode: "reply", to: ["a@example.com"] }).recipients).toEqual([]);
  });

  /*
   * A composer with no subject is not addressable by the native half at all, so
   * it is refused here rather than handed on to fail later with a window it
   * cannot name.
   */
  it("refuses when Mail returns a composer with no subject", () => {
    const { envelope } = runScript({ mode: "reply" }, { subject: "" });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("COMPOSER_NOT_FOUND");
  });

  it("refuses a message that is not there, before opening anything", () => {
    const { envelope, opened } = runScript({ mode: "reply" }, { messageExists: false });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("MESSAGE_NOT_FOUND");
    expect(opened.mode).toBeNull();
  });

  it("refuses an unknown mailbox", () => {
    const { envelope } = runScript({ mode: "reply", mailbox: "Nope" });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("MAILBOX_NOT_FOUND");
  });

  /*
   * The whole point of the split: this half needs Automation for Mail, which
   * every other write tool already has, and nothing else. The second grant goes
   * with the second half.
   */
  it("addresses Mail and nothing else", () => {
    // Asserted on what it ADDRESSES, not on the script text: the shared prelude
    // defines the System Events helpers for every script that includes it, so a
    // text search finds them in a script that never calls one.
    const { addressed } = runScript({ mode: "reply" });
    expect(new Set(addressed)).toEqual(new Set(["Mail"]));
  });

  /*
   * The scripting object is the only handle on the composer, and it dies with
   * this process, so attachments go on here or not at all. Each one is the
   * path the client resolved, wrapped in Path() and nothing else.
   */
  it("attaches every file to the composer it opened", () => {
    const { envelope, attached } = runScript({
      mode: "reply",
      attachments: ["/tmp/a.pdf", "/tmp/b.png"],
    });
    expect(envelope.ok).toBe(true);
    expect(attached).toEqual(["/tmp/a.pdf", "/tmp/b.png"]);
    expect(envelope.data.attachments).toBe(2);
  });

  it("attaches nothing when none were asked for", () => {
    const { envelope, attached } = runScript({ mode: "forward", to: ["a@example.com"] });
    expect(attached).toEqual([]);
    expect(envelope.data.attachments).toBe(0);
  });

  /*
   * Nothing has been typed into the composer yet, so it is ours to take back:
   * a reply that silently lost the file the caller asked for is worse than no
   * reply, and an empty window left behind is the failure this path removed.
   */
  it("closes the composer and refuses when a file cannot be attached", () => {
    const { envelope, closed } = runScript(
      { mode: "reply", attachments: ["/tmp/a.pdf"] },
      { attachFails: true },
    );
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("ATTACHMENT_FAILED");
    expect(envelope.error.message).toContain("/tmp/a.pdf");
    expect(closed).toHaveLength(1);
  });
});
