import { describe, expect, it } from "vitest";

import { SEND_MESSAGE } from "../src/client/jxa/write.js";

/**
 * What the compose script leaves on the user's screen.
 *
 * `stripCitation` hides the composer while it drives Format ▸ Quote Level ▸
 * Decrease, because that menu only validates for the frontmost application. It
 * used to leave it hidden — 1×1 pixel, pushed off the display — which on a
 * `sendNow: false` compose is the very window the caller is told is "open in
 * Mail for review". Worse, Mail persists the compose window's frame, so the
 * next composer the user opened by hand came back the same size.
 *
 * The script is plain JavaScript, so it runs here against a fake Mail whose
 * window records every geometry write. These tests pin the restore, not the
 * removal of the hiding: both halves have to stay.
 */

type Behaviour = {
  /** Blockquote depth Mail wrapped the body in; 0 once Decrease has worked. */
  quoteLevel?: number;
  /** The menu drive blows up part way through, after the window is hidden. */
  menuThrows?: boolean;
  /** The window refuses to report its size and position. */
  geometryUnreadable?: boolean;
};

const START_SIZE = [820, 600];
const START_POSITION = [120, 80];
const SUBJECT = "Quarterly numbers";

const runScript = (params: Record<string, unknown> = {}, behaviour: Behaviour = {}) => {
  const { quoteLevel = 1, menuThrows = false, geometryUnreadable = false } = behaviour;

  const state = {
    frontmost: "Terminal",
    quoteLevel,
    decreaseClicks: 0,
    sends: 0,
    /** Every write to the window's geometry, in order. */
    writes: [] as [string, number[]][],
  };

  let size = [...START_SIZE];
  let position = [...START_POSITION];

  const quotedLine = {
    role: () => "AXStaticText",
    value: () => "Les chiffres du trimestre.",
    uiElements: () => [],
    attributes: {
      byName: (name: string) => ({
        value: () => (name === "AXBlockQuoteLevel" ? state.quoteLevel : null),
      }),
    },
  };
  const webArea: any = {
    role: () => "AXWebArea",
    value: () => "",
    uiElements: () => [quotedLine],
    set focused(_v: boolean) {},
  };
  const composerWindow = {
    name: () => SUBJECT,
    uiElements: () => [
      { role: () => "AXScrollArea", value: () => null, uiElements: () => [webArea] },
    ],
    // Both a reader and a writer: the script asks for the geometry before it
    // moves the window, and hands the same values back afterwards.
    get size() {
      if (geometryUnreadable) throw new Error("-25205 AXError attribute unsupported");
      return () => size;
    },
    set size(v: any) {
      size = v;
      state.writes.push(["size", v]);
    },
    get position() {
      if (geometryUnreadable) throw new Error("-25205 AXError attribute unsupported");
      return () => position;
    },
    set position(v: any) {
      position = v;
      state.writes.push(["position", v]);
    },
    actions: { byName: () => ({ perform: () => {} }) },
  };

  const decrease = {
    enabled: () => state.frontmost === "Mail" && state.quoteLevel > 0,
    click: () => {
      state.decreaseClicks++;
      state.quoteLevel = Math.max(0, state.quoteLevel - 1);
    },
  };
  const proc = {
    windows: () => [composerWindow],
    set frontmost(v: boolean) {
      if (v) state.frontmost = "Mail";
    },
    name: () => "Mail",
    get menuBars() {
      if (menuThrows) throw new Error("-25211 AXError cannot complete");
      return [
        {
          menuBarItems: {
            byName: () => ({
              menus: [
                {
                  menuItems: {
                    byName: () => ({ menus: [{ menuItems: { byName: () => decrease } }] }),
                  },
                },
              ],
            }),
          },
        },
      ];
    },
  };

  const systemEvents = {
    processes: {
      name: () => ["Mail", "Finder"],
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
    keystroke: () => undefined,
  };

  const message = {
    set sender(_v: string) {},
    send: () => {
      state.sends++;
    },
    toRecipients: { push: () => undefined },
    ccRecipients: { push: () => undefined },
    bccRecipients: { push: () => undefined },
  };
  const mail = {
    OutgoingMessage: () => message,
    outgoingMessages: { push: () => undefined },
    ToRecipient: (spec: unknown) => spec,
    CcRecipient: (spec: unknown) => spec,
    BccRecipient: (spec: unknown) => spec,
  };

  const Application = (name: string) => (name === "Mail" ? mail : systemEvents);
  const ObjC = { import: () => undefined, unwrap: (v: { value: string }) => v.value };
  const dollar: any = ((value: string) => ({ value })) as any;
  dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
  dollar.NSThread = { sleepForTimeInterval: () => undefined };
  dollar.AXIsProcessTrusted = () => true;
  dollar.NSPasteboardTypeString = "public.utf8-plain-text";
  dollar.NSPasteboard = { generalPasteboard: {} };

  const factory = new Function("ObjC", "Application", "$", `${SEND_MESSAGE}\nreturn run;`);
  const run = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([
      JSON.stringify({
        subject: SUBJECT,
        body: "Les chiffres du trimestre.",
        to: ["arkadi@example.com"],
        sendNow: false,
        ...params,
      }),
    ]),
  );
  return { envelope, state, geometry: () => ({ size, position }) };
};

describe("the composer window a compose leaves behind", () => {
  it("hides the composer to strip the citation, then puts it back", () => {
    const { envelope, state, geometry } = runScript();

    expect(envelope.ok).toBe(true);
    expect(envelope.data.unquoted).toBe(true);
    // The hiding still happens: this is a restore, not a removal.
    expect(state.writes).toContainEqual(["size", [1, 1]]);
    expect(state.writes).toContainEqual(["position", [-100000, -100000]]);
    // And the window is handed back exactly as it was found.
    expect(geometry()).toEqual({ size: START_SIZE, position: START_POSITION });
  });

  it("restores the geometry before the draft is left on screen", () => {
    const { envelope, state } = runScript();

    expect(envelope.data.sent).toBe(false);
    expect(envelope.data.note).toContain("open in Mail for review");
    // The last thing done to the window is the restore, so what the caller
    // describes as reviewable is a window the user can actually see.
    expect(state.writes.slice(-2)).toEqual([
      ["position", START_POSITION],
      ["size", START_SIZE],
    ]);
  });

  it("restores the geometry when the strip blows up half way", () => {
    const { envelope, geometry } = runScript({}, { menuThrows: true });

    expect(envelope.ok).toBe(true);
    // A failed strip is cosmetic and reported as such...
    expect(envelope.data.unquoted).toBe(false);
    // ...but it must not cost the user their composer.
    expect(geometry()).toEqual({ size: START_SIZE, position: START_POSITION });
  });

  it("never moves a window whose geometry it cannot read back", () => {
    const { envelope, state } = runScript({}, { geometryUnreadable: true });

    expect(envelope.ok).toBe(true);
    expect(envelope.data.unquoted).toBe(true);
    // Nothing was written, so there is nothing left in the wrong place: a
    // composer briefly on screen beats one stuck at 1x1 off the display.
    expect(state.writes).toEqual([]);
  });

  it("still strips the citation on a send", () => {
    const { envelope, state, geometry } = runScript({ sendNow: true });

    expect(envelope.data.sent).toBe(true);
    expect(envelope.data.unquoted).toBe(true);
    expect(state.sends).toBe(1);
    // Restored before send(), so Mail persists the frame the user chose.
    expect(geometry()).toEqual({ size: START_SIZE, position: START_POSITION });
  });
});
