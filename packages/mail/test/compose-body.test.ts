import { describe, expect, it } from "vitest";

import { REPLY_OR_FORWARD } from "../src/client/jxa/write.js";

/**
 * The reply/forward script, run for real against a fake Mail.
 *
 * JXA is plain JavaScript, so the script that ships can be executed here rather
 * than asserted on as a string. It has to be. What this script defends against
 * is Mail accepting an instruction and not carrying it out — a composer that
 * takes a body and keeps nothing, a Send that never fires — and every one of
 * those looks like success from the inside. The fake below is built to lie in
 * exactly those ways, so a regression that trusts Mail's word fails here.
 */

type MailBehaviour = {
  /** Polls before the composer window shows up. Infinity: it never does. */
  windowAfterPolls?: number;
  /** Paste silently does nothing, the way the scripting setters do. */
  pasteDoesNothing?: boolean;
  /** Paste puts something in the body, but not what was on the pasteboard. */
  pasteGarbles?: boolean;
  /** What Mail already put in the body: the quoted original, or nothing. */
  quoted?: string;
  /** Send is refused: the menu item never enables. */
  sendDisabled?: boolean;
  /** Send is clicked, and the window is still there afterwards. */
  sendLeavesWindowOpen?: boolean;
  /**
   * The Mac cannot reach a composer at all, in one of the two ways that look
   * identical from inside one: System Events refuses to be addressed, or it can
   * be addressed and its UI reads back as nothing.
   */
  blind?: "systemEvents" | "accessibility";
  /** What AXIsProcessTrusted claims — consulted only when Mail has no windows. */
  axTrusted?: boolean;
  /** Mail refuses to close the composer this script opened. */
  closeFails?: boolean;
};

const paragraphs = (text: string) => text.split("\n").filter((line) => line.trim());

/** What `$("text")` hands back: an object the pasteboard stub can read. */
const nsString = (value: string) => ({ value });

const staticText = (value: string) => ({
  role: () => "AXStaticText",
  value: () => value,
  uiElements: () => [],
});

const runScript = (params: Record<string, unknown>, behaviour: MailBehaviour = {}) => {
  const {
    windowAfterPolls = 0,
    pasteDoesNothing = false,
    pasteGarbles = false,
    quoted = "",
    sendDisabled = false,
    sendLeavesWindowOpen = false,
    blind,
    axTrusted = true,
    closeFails = false,
  } = behaviour;

  const state = {
    frontmost: "Terminal",
    windowExists: windowAfterPolls === 0,
    windowClosed: false,
    polls: 0,
    bodyFocused: false,
    bodyLines: paragraphs(quoted),
    raises: 0,
    pastes: 0,
    sendClicks: 0,
    sendEnabledChecks: 0,
    clipboard: "something the user copied earlier" as string | null,
    clipboardDuringPaste: null as string | null,
    frontmostDuringPaste: null as string | null,
    // Did a composer get put on screen at all? The pre-flight's whole job is to
    // keep this at 0 when the grants are missing.
    composersOpened: 0,
    closes: 0,
    closedSaving: null as string | null,
  };

  const webArea: any = {
    role: () => "AXWebArea",
    value: () => "",
    uiElements: () => state.bodyLines.map(staticText),
    // The cheap fingerprint the script takes before and after a paste.
    entireContents: () => state.bodyLines.map(staticText),
    set focused(v: boolean) {
      state.bodyFocused = v;
    },
  };
  const composerWindow = {
    name: () => "Re: original",
    uiElements: () => [
      { role: () => "AXScrollArea", value: () => null, uiElements: () => [webArea] },
    ],
    actions: {
      byName: () => ({
        perform: () => {
          state.raises++;
        },
      }),
    },
  };
  const mainWindow = {
    name: () => "Inbox",
    uiElements: () => [],
    actions: { byName: () => ({ perform: () => {} }) },
  };

  const proc = {
    get windows() {
      const list = () => {
        // Accessibility denied does not come back empty, it comes back as a
        // refusal — `prop()` is what used to turn that into `[]`.
        if (blind === "accessibility") throw new Error("-25211 AXError cannot complete");
        if (!state.windowExists && ++state.polls >= windowAfterPolls) state.windowExists = true;
        return state.windowExists && !state.windowClosed
          ? [composerWindow, mainWindow]
          : [mainWindow];
      };
      // `proc.windows()` and `proc.windows[0]` are both used against Mail.
      return Object.assign(list, { 0: composerWindow });
    },
    set frontmost(v: boolean) {
      if (v) state.frontmost = "Mail";
    },
    name: () => "Mail",
    menuBars: [
      {
        menuBarItems: {
          byName: () => ({
            menus: [
              {
                menuItems: {
                  byName: () => ({
                    enabled: () => {
                      state.sendEnabledChecks++;
                      // Mail only validates Send for the active application.
                      return !sendDisabled && state.frontmost === "Mail";
                    },
                    click: () => {
                      state.sendClicks++;
                      if (!sendLeavesWindowOpen) state.windowClosed = true;
                    },
                  }),
                },
              },
            ],
          }),
        },
      },
    ],
  };

  const systemEvents = {
    processes: {
      // Addressing System Events at all: a separate grant from Accessibility,
      // and the first thing the pre-flight asks.
      name: () => {
        if (blind === "systemEvents") throw new Error("Error: -1743 errAEEventNotPermitted");
        return ["Mail", "Finder"];
      },
      byName: (name: string) =>
        name === "Mail"
          ? proc
          : {
              set frontmost(v: boolean) {
                if (v) state.frontmost = name;
              },
            },
    },
    applicationProcesses: { whose: () => [{ name: () => state.frontmost }] },
    keystroke: (key: string, opts: { using: string[] }) => {
      if (key !== "v" || !opts.using.includes("command down")) return;
      // A keystroke reaches the active application, and nowhere else.
      if (state.frontmost !== "Mail" || !state.bodyFocused) return;
      state.pastes++;
      state.clipboardDuringPaste = state.clipboard;
      state.frontmostDuringPaste = state.frontmost;
      if (pasteDoesNothing) return;
      const pasted = pasteGarbles ? "something else entirely" : (state.clipboard ?? "");
      state.bodyLines = [...paragraphs(pasted), ...state.bodyLines];
    },
  };

  const composer = {
    subject: () => "Re: original",
    send: () => {
      throw new Error("send() must not be called on a composer: it is not the verified path");
    },
    toRecipients: { push: (r: { address: string }) => recipients.push(r.address) },
  };
  const recipients: string[] = [];
  const message = { subject: () => "original" };
  const mailbox = { name: () => "INBOX", messages: { byId: () => message } };
  const account = { id: () => "UUID", mailboxes: () => [mailbox] };
  const mail = {
    accounts: () => [account],
    reply: () => {
      state.composersOpened++;
      return composer;
    },
    forward: () => {
      state.composersOpened++;
      return composer;
    },
    close: (_draft: unknown, opts: { saving: string }) => {
      if (closeFails) throw new Error("Mail can't close that");
      state.closes++;
      state.closedSaving = opts.saving;
      state.windowClosed = true;
    },
    ToRecipient: (spec: { address: string }) => spec,
  };

  const Application = (name: string) => (name === "Mail" ? mail : systemEvents);
  const ObjC = { import: () => undefined, unwrap: (v: { value: string }) => v.value };
  // bind() so each run gets its own function object to hang stubs on.
  const dollar: any = nsString.bind(null);
  dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
  dollar.NSThread = { sleepForTimeInterval: () => undefined };
  dollar.AXIsProcessTrusted = () => axTrusted;
  dollar.NSPasteboardTypeString = "public.utf8-plain-text";
  dollar.NSPasteboard = {
    generalPasteboard: {
      get clearContents() {
        state.clipboard = null;
        return 0;
      },
      setStringForType: (value: { value: string }) => {
        state.clipboard = value.value;
      },
      stringForType: () => ({
        isNil: () => state.clipboard === null,
        value: state.clipboard,
      }),
    },
  };

  const factory = new Function("ObjC", "Application", "$", `${REPLY_OR_FORWARD}\nreturn run;`);
  const run = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([JSON.stringify({ accountUuid: "UUID", mailbox: "INBOX", id: 42, ...params })]),
  );
  return { envelope, state, recipients, body: () => state.bodyLines.join("\n") };
};

const BODY = "Bonjour Arkadi,\n\n  - un point\n  - un autre\n\nBien à toi";
const REPLY = { mode: "reply", body: BODY, replyToAll: true, sendNow: false };

describe("reply body", () => {
  it("puts the body in the composer and reads it back out", () => {
    const { envelope, body } = runScript(REPLY);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.bodyVerified).toBe(true);
    expect(body()).toContain("Bonjour Arkadi,");
    expect(body()).toContain("Bien à toi");
  });

  it("waits for the composer instead of writing into the gap", () => {
    const { envelope, state } = runScript(REPLY, { windowAfterPolls: 5 });
    expect(envelope.ok).toBe(true);
    expect(state.pastes).toBe(1);
  });

  it("keeps the quoted original beneath the reply", () => {
    const { envelope, body } = runScript(REPLY, { quoted: "> the original message" });
    expect(envelope.ok).toBe(true);
    expect(body()).toBe(
      "Bonjour Arkadi,\n  - un point\n  - un autre\nBien à toi\n> the original message",
    );
  });

  it("fails loudly rather than reporting a draft that is empty", () => {
    const { envelope } = runScript(REPLY, { pasteDoesNothing: true });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("DRAFT_BODY_NOT_SET");
    // The guarantee, not the wording: whatever is on screen, the caller must
    // not go on to tell the user their reply is ready.
    expect(envelope.error.message).toMatch(/MUST NOT be described to the user as ready/);
  });

  it("retries a paste that landed nowhere", () => {
    const { state } = runScript(REPLY, { pasteDoesNothing: true });
    expect(state.pastes).toBe(2);
  });

  it("does not retry once something has landed, so the body cannot end up twice", () => {
    const { envelope, state } = runScript(REPLY, { pasteGarbles: true });
    expect(envelope.ok).toBe(false);
    expect(state.pastes).toBe(1);
  });

  it("says so when the composer cannot be reached at all", () => {
    const { envelope } = runScript(REPLY, { windowAfterPolls: Infinity });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("COMPOSER_NOT_FOUND");
    // NOT blamed on Accessibility. The pre-flight read Mail's other windows
    // moments earlier, so the grants are provably live and saying otherwise
    // sends the user to a System Settings pane that is already correct.
    expect(envelope.error.message).toMatch(/this is not a permission/);
    expect(envelope.error.message).toMatch(/Inbox/);
  });

  it("reports how much of a long body it actually confirmed", () => {
    // Reading a 4 KB reply plus the quote under it costs seconds of Apple
    // Events, so the check is bounded and says how far it got rather than
    // implying it read everything.
    const long = `${BODY}\n\n${"ligne de remplissage. ".repeat(200)}`;
    const { envelope, body } = runScript({ ...REPLY, body: long });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.verifiedChars).toBe(400);
    expect(body()).toContain("ligne de remplissage.");
  });

  it("holds accents, guillemets and an indented tree", () => {
    const french = "Résumé « détaillé » : voilà.\n\n    projet\n    └── étape";
    const { envelope, body } = runScript({ ...REPLY, body: french });
    expect(envelope.ok).toBe(true);
    expect(body()).toContain("Résumé « détaillé » : voilà.");
    expect(body()).toContain("    └── étape");
  });
});

describe("the user's machine", () => {
  it("pastes with Mail frontmost, because a keystroke goes nowhere else", () => {
    const { envelope, state } = runScript(REPLY);
    expect(envelope.ok).toBe(true);
    expect(state.frontmostDuringPaste).toBe("Mail");
  });

  it("hands the frontmost application back afterwards", () => {
    const { state } = runScript(REPLY);
    expect(state.frontmost).toBe("Terminal");
  });

  it("hands it back even when the body never took", () => {
    const { state } = runScript(REPLY, { pasteDoesNothing: true });
    expect(state.frontmost).toBe("Terminal");
  });

  it("borrows the clipboard and puts it back", () => {
    const { state } = runScript(REPLY);
    expect(state.clipboardDuringPaste).toBe(BODY);
    expect(state.clipboard).toBe("something the user copied earlier");
  });
});

describe("sending", () => {
  it("sends from the window, only after the body verified", () => {
    const { envelope, state } = runScript({ ...REPLY, sendNow: true });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.sent).toBe(true);
    expect(state.sendClicks).toBe(1);
  });

  it("never sends a message whose body did not take", () => {
    const { envelope, state } = runScript({ ...REPLY, sendNow: true }, { pasteDoesNothing: true });
    expect(envelope.ok).toBe(false);
    expect(state.sendClicks).toBe(0);
  });

  it("reports a Send that would not activate rather than claiming it went", () => {
    const { envelope, state } = runScript({ ...REPLY, sendNow: true }, { sendDisabled: true });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("SEND_FAILED");
    expect(envelope.error.message).toMatch(/NOTHING WAS SENT/);
    expect(state.sendClicks).toBe(0);
  });

  it("does not call a window still open after Send a failure, and warns off a retry", () => {
    // "Send did not happen" and "cannot tell whether Send happened" are
    // different answers, and conflating them is how a mail gets sent twice.
    const { envelope } = runScript({ ...REPLY, sendNow: true }, { sendLeavesWindowOpen: true });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("SEND_UNCONFIRMED");
    expect(envelope.error.message).toMatch(/DO NOT send it again/);
  });
});

describe("forward", () => {
  it("addresses the composer once it exists", () => {
    const { envelope, recipients } = runScript(
      { mode: "forward", body: BODY, to: ["a@b.com"], sendNow: false },
      { windowAfterPolls: 3 },
    );
    expect(envelope.ok).toBe(true);
    expect(recipients).toEqual(["a@b.com"]);
  });

  it("forwards with no note at all", () => {
    const { envelope, state } = runScript({
      mode: "forward",
      to: ["a@b.com"],
      body: null,
      sendNow: false,
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.bodyVerified).toBe(null);
    expect(state.pastes).toBe(0);
  });
});

/**
 * The pre-flight, which is about what is left on screen rather than what is
 * returned.
 *
 * The failure this tool was best known for was not the error — it was the empty
 * reply window sitting in Mail afterwards, one per attempt, each of which the
 * user had to close by hand. The grants that fail can all be read before
 * anything is opened, so none of those windows ever needed to exist.
 */
describe("opening nothing it cannot fill", () => {
  it("refuses before a composer exists when System Events cannot be addressed", () => {
    const { envelope, state } = runScript(REPLY, { blind: "systemEvents" });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("COMPOSER_NOT_FOUND");
    expect(state.composersOpened).toBe(0);
  });

  it("refuses before a composer exists when the UI cannot be read", () => {
    const { envelope, state } = runScript(REPLY, { blind: "accessibility" });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toMatch(/Accessibility/);
    expect(state.composersOpened).toBe(0);
  });

  // Mail closed down to the menu bar has no windows, and that reads exactly
  // like being blind to it. Refusing on an empty list alone would block a reply
  // on a Mac where the whole mechanism works.
  it("proceeds on an empty window list when the process is trusted", () => {
    const { envelope, state } = runScript(REPLY, { axTrusted: true });
    expect(envelope.ok).toBe(true);
    expect(state.composersOpened).toBe(1);
  });

  it("takes back the composer it opened when the body never landed", () => {
    const { envelope, state } = runScript(REPLY, { pasteDoesNothing: true });
    expect(envelope.ok).toBe(false);
    expect(state.closes).toBe(1);
    expect(state.closedSaving).toBe("no");
    expect(envelope.error.message).toMatch(/retry is safe/);
  });

  // The one case where the window must survive: something went in that could
  // not be read back, and closing it would destroy a reply with no undo.
  it("leaves the composer alone once something has landed in it", () => {
    const { envelope, state } = runScript(REPLY, { pasteGarbles: true });
    expect(envelope.ok).toBe(false);
    expect(state.closes).toBe(0);
    expect(envelope.error.message).toMatch(/left it open|left open/);
  });

  it("admits it when the composer cannot be closed either", () => {
    const { envelope, state } = runScript(REPLY, { pasteDoesNothing: true, closeFails: true });
    expect(envelope.ok).toBe(false);
    expect(state.closes).toBe(0);
    expect(envelope.error.message).toMatch(/close it in Mail/i);
  });
});
