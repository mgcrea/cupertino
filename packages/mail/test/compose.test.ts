import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailAxLane } from "../src/client/ax.js";
import { awaitNewComposer, composeNatively } from "../src/client/compose.js";
import { SENT_SINCE } from "../src/client/jxa/read.js";

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/**
 * What Mail's window list says before the composer exists.
 *
 * Call 1 to `list_windows` is always the pre-flight reach, taken BEFORE the
 * composer is opened, so the composer cannot be in it.
 */
const BEFORE_OPENING = { windows: [{ handle: "w0", index: 0, title: "Inbox" }] };

/** One composer as the app's `mail_composers` verb reports it. */
const composer = (handle: string, subject: string, over: Record<string, unknown> = {}) => ({
  composer: handle,
  subject,
  recipients: [],
  text: "",
  quoted: true,
  files: [],
  ...over,
});

/** What the verb answers when it filled the composer. */
const filled = (args: { body?: string; attachments?: string[]; save?: boolean }) => ({
  replaced: true,
  method: "inPlace",
  text: args.body ?? "",
  quoteKept: true,
  filesAdded: args.attachments?.length ?? 0,
  saved: args.save === true,
  note: "",
});

/**
 * A composer that behaves. `mail_composers` is empty on the first call, which
 * is the one taken before Mail is asked to open anything, and holds the new
 * composer after it. The verb fills what it is given and reads it back.
 */
const healthyHost = (over: Record<string, unknown> = {}, subject = "Re: lunch") => ({
  list_windows: (_a: unknown, n: number) =>
    n === 1 ? BEFORE_OPENING : { windows: [{ handle: "w1", index: 0, title: subject }] },
  ui_tree: { elements: [{ handle: "e7", role: "AXWebArea", depth: 2 }] },
  mail_composers: (_a: unknown, n: number) => ({
    composers: n === 1 ? [] : [composer("mc-1", subject)],
  }),
  mail_composer_edit: (args: Record<string, unknown>) => filled(args),
  ...over,
});

const laneOver = async (
  answers: Record<string, unknown>,
): Promise<{ lane: MailAxLane; seen: { tool: string; args: Record<string, unknown> }[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "compose-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const counts: Record<string, number> = {};
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let greeted = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!greeted) {
          greeted = true;
          socket.write("ok\n");
          continue;
        }
        const message = JSON.parse(line);
        const tool = String(message.params.name).replace("apple_desktop_", "");
        seen.push({ tool, args: message.params.arguments });
        counts[tool] = (counts[tool] ?? 0) + 1;
        const entry = answers[tool];
        const body =
          typeof entry === "function"
            ? (entry as (a: unknown, n: number) => unknown)(message.params.arguments, counts[tool])
            : (entry ?? {});
        // A dead element handle is not a value the driver returns, it is a
        // REFUSAL — `Failure.staleHandle`, "Element 'e7' no longer exists". A
        // stub that can only answer with documents cannot reach the paths that
        // matter most here, because every one of them is downstream of a throw.
        socket.write(
          `${JSON.stringify(
            body !== null && typeof body === "object" && "refusal" in body
              ? { jsonrpc: "2.0", id: message.id, error: { message: (body as never)["refusal"] } }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { content: [{ type: "text", text: JSON.stringify(body) }] },
                },
          )}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const lane = MailAxLane.open({ CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" })!;
  return { lane, seen };
};

const runnerReturning = (subject: string) => ({ run: async () => ({ subject }) }) as never;

/**
 * A runner that answers the Sent check too.
 *
 * `composeNatively` reaches Apple Events twice now: once to open the
 * composer, and once more — only when the composer has GONE — to ask whether
 * what was in it went out.
 */
const runnerWithSent = (subject: string, sent: Record<string, unknown>) =>
  ({
    run: async (s: string) => (s === SENT_SINCE ? sent : { subject }),
  }) as never;

/** Present while it is filled, gone from the window list once anything is pressed. */
const composerThatVanishes = (over: Record<string, unknown> = {}) =>
  healthyHost({
    // Call 1 is the pre-flight reach; later calls are
    // the presence check in a failure branch, after someone took the window.
    list_windows: (_a: unknown, n: number) =>
      n === 1 ? BEFORE_OPENING : { windows: [{ handle: "w1", index: 0, title: "All Sent" }] },
    // The verb cannot reach a window that went.
    mail_composer_edit: {
      replaced: false,
      degraded: true,
      capability: "composer",
      reason: "No such composer.",
      hint: "Reopen it.",
    },
    ...over,
  });

const PARAMS = {
  accountUuid: "UUID",
  mailbox: "INBOX",
  id: 42,
  mode: "reply" as const,
  body: "PASTED",
  to: [],
  replyToAll: false,
  sendNow: true,
};

const TIMEOUTS = { sendTimeoutMs: 50, composerTimeoutMs: 50 };

const edits = (seen: { tool: string; args: Record<string, unknown> }[]) =>
  seen.filter((c) => c.tool === "mail_composer_edit");
const presses = (seen: { tool: string; args: Record<string, unknown> }[], key: string) =>
  seen.filter((c) => c.tool === "key" && c.args["key"] === key);

describe("awaitNewComposer", () => {
  it("returns the handle that appeared", async () => {
    const { lane } = await laneOver({
      mail_composers: (_a: unknown, n: number) => ({
        composers:
          n < 3
            ? [composer("mc-1", "Re: lunch")]
            : [composer("mc-1", "Re: lunch"), composer("mc-4", "Re: lunch")],
      }),
    });
    await expect(awaitNewComposer(lane, ["mc-1"], 2000)).resolves.toEqual({
      handle: "mc-4",
      text: "",
    });
    lane.close();
  });

  it("returns the text it was listed with, null for a tab Mail is not showing", async () => {
    const { lane } = await laneOver({
      mail_composers: (_a: unknown, n: number) => ({
        composers:
          n === 1
            ? [composer("mc-4", "Re: lunch", { text: "-- \nOlivier" })]
            : [composer("mc-5", "Re: lunch", { tab: "background", text: null })],
      }),
    });
    await expect(awaitNewComposer(lane, [], 30)).resolves.toEqual({
      handle: "mc-4",
      text: "-- \nOlivier",
    });
    await expect(awaitNewComposer(lane, ["mc-4"], 30)).resolves.toEqual({
      handle: "mc-5",
      text: null,
    });
    lane.close();
  });

  it("does not pick a new composer under another subject", async () => {
    const { lane } = await laneOver({
      mail_composers: (_a: unknown, n: number) => ({
        composers: n < 2 ? [] : [composer("mc-7", "Something the person typed")],
      }),
    });
    await expect(awaitNewComposer(lane, [], 30, "Re: lunch")).resolves.toBeNull();
    lane.close();
  });

  it("prefers the one with the subject over a hand-opened one", async () => {
    const { lane } = await laneOver({
      mail_composers: {
        composers: [composer("mc-7", "Mine"), composer("mc-8", "Re: lunch")],
      },
    });
    await expect(awaitNewComposer(lane, [], 30, "Re: lunch")).resolves.toEqual({
      handle: "mc-8",
      text: "",
    });
    lane.close();
  });

  /*
   * LIVE RUN 5: opening a tab re-mints every tab's element, so a tab whose
   * title another shares comes back with a new handle, and the old composer
   * under the subject looks as new as the one just opened. A new composer
   * opens as the SELECTED tab, and only one composer more carries the subject.
   */
  describe("when opening a tab re-mints the handles of the tabs beside it", () => {
    const tab = (
      handle: string,
      subject: string,
      which: "selected" | "background",
      text: string | null = which === "background" ? null : "",
    ) => composer(handle, subject, { tab: which, text });
    const before = [tab("mc-1", "Re: lunch", "selected")];

    it("takes the one selected tab when the subject's count grew by exactly one", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [tab("mc-2", "Re: lunch", "background"), tab("mc-3", "Re: lunch", "selected")],
        },
      });
      await expect(awaitNewComposer(lane, before, 30, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "",
      });
      lane.close();
    });

    /*
     * Whether the new tab opens selected is unmeasured, and the person can
     * click the old one during the poll. The old draft's text gives it away.
     */
    it("refuses when the selected candidate holds the text an older composer had", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "an older reply"),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("takes a selected candidate whose text is not any older composer's", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "-- \nOlivier"),
          ],
        },
      });
      const older = [
        tab("mc-1", "Re: lunch", "selected", "an older reply"),
        tab("mc-9", "Other", "background"),
      ];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "-- \nOlivier",
      });
      lane.close();
    });

    it("takes a selected candidate with empty text, which never matches", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [tab("mc-2", "Re: lunch", "background"), tab("mc-3", "Re: lunch", "selected")],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "",
      });
      lane.close();
    });

    it("refuses when two of them read as selected", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [tab("mc-2", "Re: lunch", "selected"), tab("mc-3", "Re: lunch", "selected")],
        },
      });
      await expect(awaitNewComposer(lane, before, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("refuses when the subject's count grew by two", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "background"),
            tab("mc-4", "Re: lunch", "selected"),
          ],
        },
      });
      await expect(awaitNewComposer(lane, before, 30, "Re: lunch")).resolves.toMatchObject({
        ambiguous: ["mc-2", "mc-3", "mc-4"],
      });
      lane.close();
    });

    it("refuses when only handles were given, so the count before is unknown", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [tab("mc-2", "Re: lunch", "background"), tab("mc-3", "Re: lunch", "selected")],
        },
      });
      await expect(awaitNewComposer(lane, ["mc-1"], 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("fills the selected new tab in a compose whose open re-minted the old one", async () => {
      const { lane, seen } = await laneOver(
        healthyHost({
          mail_composers: (_a: unknown, n: number) => ({
            composers:
              n === 1
                ? before
                : [tab("mc-2", "Re: lunch", "background"), tab("mc-3", "Re: lunch", "selected")],
          }),
        }),
      );
      const result = await composeNatively(
        lane,
        runnerReturning("Re: lunch"),
        { ...PARAMS, sendNow: false },
        TIMEOUTS,
      );
      expect(result).toMatchObject({ ok: true, bodyVerified: true });
      expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-3", save: true });
      expect(edits(seen)[0]?.args).not.toHaveProperty("expectHead");
      lane.close();
    });

    /*
     * Fix round 5: the old draft is judged as the app judges an `expectHead`,
     * since the person may have typed on in it (the selected tab is exactly
     * where they type), and a listing's line breaks may differ between reads.
     */
    it("refuses when the selected candidate's text begins as an older composer's did", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "an older reply, typed on since"),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("refuses when the older composer's text begins as the candidate's does", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "an older"),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("refuses when the texts differ only in whitespace", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "an older\n\nreply "),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an  older reply")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("compares the first 120 characters only, as the app does", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", `${"x".repeat(120)} then this`),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", `${"x".repeat(120)} then that`)];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    /*
     * An older same-subject tab Mail was not showing has no text to compare
     * with, and neither has one whose body the app could not read: nothing
     * can tell it from the new one.
     */
    it("refuses when an older same-subject composer had no text to compare with", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "-- \nOlivier"),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "background")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      const unread = [tab("mc-1", "Re: lunch", "selected", null)];
      await expect(awaitNewComposer(lane, unread, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("polls on while the selected candidate's body is still loading, then takes it", async () => {
      const { lane } = await laneOver({
        mail_composers: (_a: unknown, n: number) => ({
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", n === 1 ? null : "-- \nOlivier"),
          ],
        }),
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "-- \nOlivier",
      });
      lane.close();
    });

    /*
     * Final review I1: the new tab N closed during the poll, Mail re-minted
     * the tabs again, and the OLD draft O came back as the one fresh
     * candidate. Taken unjudged, its text would be replaced and saved.
     */
    it("refuses a lone fresh candidate whose text is an older same-subject composer's", async () => {
      const { lane } = await laneOver({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? [tab("mc-2", "Re: lunch", "background"), tab("mc-3", "Re: lunch", "selected", null)]
              : [tab("mc-5", "Re: lunch", "selected", "an older reply")],
        }),
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-5"],
      });
      lane.close();
    });

    it("polls on while a lone candidate's body is still loading, then takes it", async () => {
      const { lane } = await laneOver({
        mail_composers: (_a: unknown, n: number) => ({
          composers: [tab("mc-3", "Re: lunch", "selected", n < 3 ? null : "-- \nOlivier")],
        }),
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "-- \nOlivier",
      });
      lane.close();
    });

    it("refuses a lone candidate whose text never reads, at the deadline", async () => {
      const { lane, seen } = await laneOver({
        mail_composers: { composers: [tab("mc-3", "Re: lunch", "background")] },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 300, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-3"],
      });
      expect(seen.filter((s) => s.tool.endsWith("composers")).length).toBeGreaterThan(1);
      lane.close();
    });

    it("refuses a lone candidate at once when an older composer had no text", async () => {
      const { lane, seen } = await laneOver({
        mail_composers: { composers: [tab("mc-3", "Re: lunch", "selected", "-- \nOlivier")] },
      });
      const older = [tab("mc-1", "Re: lunch", "background")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-3"],
      });
      expect(seen.filter((s) => s.tool.endsWith("composers"))).toHaveLength(1);
      lane.close();
    });

    it("takes a lone candidate at once when no composer had the subject before", async () => {
      const { lane } = await laneOver({
        mail_composers: { composers: [tab("mc-3", "Re: lunch", "selected", "an older reply")] },
      });
      const unrelated = [tab("mc-1", "Re: dinner", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, unrelated, 1000, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "an older reply",
      });
      lane.close();
    });

    it("refuses a loading candidate once its text reads as an older composer's", async () => {
      const { lane } = await laneOver({
        mail_composers: (_a: unknown, n: number) => ({
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", n === 1 ? null : "an older reply, typed on"),
          ],
        }),
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("refuses a loading candidate at once when an older composer had no text", async () => {
      const { lane, seen } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", null),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "background")];
      await expect(awaitNewComposer(lane, older, 1000, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      expect(seen.filter((s) => s.tool.endsWith("composers"))).toHaveLength(1);
      lane.close();
    });

    it("refuses at the deadline when the selected candidate's own text never reads", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", null),
          ],
        },
      });
      const older = [tab("mc-1", "Re: lunch", "selected", "an older reply")];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        ambiguous: ["mc-2", "mc-3"],
      });
      lane.close();
    });

    it("takes a selected candidate whose text is unrelated to every older one's", async () => {
      const { lane } = await laneOver({
        mail_composers: {
          composers: [
            tab("mc-2", "Re: lunch", "background"),
            tab("mc-7", "Re: lunch", "background"),
            tab("mc-3", "Re: lunch", "selected", "-- \nOlivier"),
          ],
        },
      });
      const older = [
        tab("mc-1", "Re: lunch", "selected", "an older reply"),
        tab("mc-8", "Re: lunch", "selected", "another, -- Olivier"),
      ];
      await expect(awaitNewComposer(lane, older, 30, "Re: lunch")).resolves.toEqual({
        handle: "mc-3",
        text: "-- \nOlivier",
      });
      lane.close();
    });
  });

  it("returns null when nothing new appears in time", async () => {
    const { lane } = await laneOver({
      mail_composers: { composers: [composer("mc-1", "Re: lunch")] },
    });
    await expect(awaitNewComposer(lane, ["mc-1"], 30)).resolves.toBeNull();
    lane.close();
  });
});

describe("composeNatively", () => {
  it("opens, fills without saving, sends, and confirms the window went", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // The composer is there while it is filled and gone after the send, which
        // is how the send is confirmed.
        list_windows: (_a: unknown, n: number) =>
          n === 1 || n > 3
            ? { windows: [{ handle: "w1", index: 0, title: "Inbox" }] }
            : { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: true, sent: true, bodyVerified: true, verifiedChars: 6 });
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-1", body: "PASTED", save: false });
    expect(presses(seen, "d")).toHaveLength(1);
    lane.close();
  });

  /*
   * The fill binds to the draft the composer was judged to be: the text it
   * was listed with goes along as `expectHead`, and the app checks it against
   * what the window shows before pasting.
   */
  it("sends the text the new composer was listed with as expectHead", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers: n === 1 ? [] : [composer("mc-1", "Re: lunch", { text: "-- \nOlivier" })],
        }),
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, bodyVerified: true });
    expect(edits(seen)).toHaveLength(1);
    expect(edits(seen)[0]?.args).toEqual({
      composer: "mc-1",
      body: "PASTED",
      expectHead: "-- \nOlivier",
      save: true,
    });
    lane.close();
  });

  /*
   * Fix round 5: an empty listed text is sent as no head at all. The listing
   * comes within a poll of the composer opening, before a signature may have
   * rendered, and the app matches an empty head to an empty text only, so an
   * empty head would refuse the fill once the signature was there. The app's
   * mark on a re-bound handle covers a re-bind between the listing and the
   * edit.
   */
  it("sends no expectHead for a composer listed with an empty text, nor for an unread tab", async () => {
    const empty = await laneOver(healthyHost());
    await composeNatively(empty.lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(edits(empty.seen)).toHaveLength(1);
    expect(edits(empty.seen)[0]?.args).toMatchObject({ composer: "mc-1" });
    expect(edits(empty.seen)[0]?.args).not.toHaveProperty("expectHead");
    empty.lane.close();

    const unread = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1 ? [] : [composer("mc-1", "Re: lunch", { tab: "background", text: null })],
        }),
      }),
    );
    await composeNatively(unread.lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(edits(unread.seen)).toHaveLength(1);
    expect(edits(unread.seen)[0]?.args).not.toHaveProperty("expectHead");
    unread.lane.close();
  });

  /*
   * A composer from an earlier call under the same subject used to be refused,
   * because the subject was the only identity there was. Handles are stable now,
   * so the one that APPEARED is the one this call opened.
   */
  it("fills the new composer when one with the same subject was already open", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? [composer("mc-1", "Re: lunch", { text: "an older reply" })]
              : [
                  composer("mc-1", "Re: lunch", { text: "an older reply" }),
                  composer("mc-2", "Re: lunch"),
                ],
        }),
        list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, sent: false, bodyVerified: true });
    expect(edits(seen)).toHaveLength(1);
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-2", body: "PASTED", save: true });
    lane.close();
  });

  it("reports no composer when none appears within the timeout", async () => {
    const { lane, seen } = await laneOver(healthyHost({ mail_composers: { composers: [] } }));
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: null, verifiedChars: 0 });
    expect(result.note).toContain("no such window was readable within");
    expect(result.note).toContain("Nothing was written");
    expect(edits(seen)).toEqual([]);
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  /*
   * The send shortcut is aimed by subject, so the verb having filled the right
   * composer does not make it safe to press: with two under one title the key
   * could land on either, and the wrong message sent is the one failure this
   * path is built to refuse.
   */
  it("a sendNow compose still waits for the Sent verdict", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // Open for the fill and the first poll, closed by the second.
        list_windows: (_a: unknown, n: number) =>
          n === 1 || n > 3
            ? { windows: [{ handle: "w1", index: 0, title: "Inbox" }] }
            : { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      }),
    );
    const result = await composeNatively(
      lane,
      runnerWithSent("Re: lunch", { checked: true, mailbox: "Sent", found: true, scanned: 5 }),
      PARAMS,
      TIMEOUTS,
    );
    // Sent is confirmed by the window going, not by the key having been posted.
    expect(result).toMatchObject({ ok: true, sent: true });
    expect(result.note).toBe("Sent.");
    expect(seen.map((c) => c.tool).lastIndexOf("key")).toBeGreaterThan(
      seen.map((c) => c.tool).indexOf("mail_composer_edit"),
    );
    lane.close();
  });

  it("a sendNow with two same-subject composers fills but does not send", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? [composer("mc-1", "Re: lunch")]
              : [composer("mc-1", "Re: lunch"), composer("mc-2", "Re: lunch")],
        }),
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: true });
    expect(result.note).toContain("NOT sent");
    expect(result.note).toContain("open in Mail for review");
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-2", save: false });
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  /*
   * With "Prefer tabs: Always" a composer is a tab, and the send key goes to
   * the window, which sends the tab it SHOWS. So it is pressed only when the
   * composer just filled is that tab, read right before the press.
   */
  it("a sendNow in a tab sends only when that tab is the one shown, read right before the key", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // Gone from the list once sent, as from the window list.
        mail_composers: (_a: unknown, n: number) => ({
          composers: n === 1 || n > 4 ? [] : [composer("mc-1", "Re: lunch", { tab: "selected" })],
        }),
        list_windows: (_a: unknown, n: number) =>
          n === 1 || n > 3
            ? { windows: [{ handle: "w1", index: 0, title: "Inbox" }] }
            : { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: true, sent: true });
    const tools = seen.map((c) => c.tool);
    const key = tools.lastIndexOf("key");
    expect(tools.slice(key - 3, key + 1)).toEqual([
      "raise_window",
      "activate",
      "mail_composers",
      "key",
    ]);
    lane.close();
  });

  it("a sendNow does not send when another tab of its window is shown at the press", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // 1: before opening; 2: the new composer; 3: the title count; 4: right before the key.
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? []
              : [
                  composer("mc-1", "Re: lunch", { tab: n < 4 ? "selected" : "background" }),
                  composer("mc-2", "Another draft", { tab: n < 4 ? "background" : "selected" }),
                ],
        }),
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: true });
    expect(result.note).toContain("NOT sent");
    expect(result.note).toContain("tab");
    expect(result.note).not.toContain("GONE");
    expect(presses(seen, "d")).toEqual([]);
    lane.close();
  });

  /*
   * Fix round 5: the send and save shortcuts go to the window, and a handle
   * Mail's tab rebuild re-bound may name another draft under this title. The
   * key is pressed only while the handle is not re-bound, checked both where
   * the title is counted and right before the key.
   */
  it("a sendNow does not send when the handle reads as re-bound once filled", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // 1: before opening; 2: the new composer; 3: the title count, re-bound.
        mail_composers: (_a: unknown, n: number) => ({
          composers: n === 1 ? [] : [composer("mc-1", "Re: lunch", { rebound: n >= 3 })],
        }),
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, degraded: true, sent: false, bodyVerified: true });
    expect(result.note).toContain("NOT sent");
    expect(result.note).toContain("re-bound");
    expect(result.note).toContain("open in Mail for review");
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  it("a sendNow does not send when the handle reads as re-bound right before the key", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        // 4: right before the key, once Mail is in front.
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1 ? [] : [composer("mc-1", "Re: lunch", { tab: "selected", rebound: n >= 4 })],
        }),
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, degraded: true, sent: false, bodyVerified: true });
    expect(result.note).toContain("NOT sent");
    expect(result.note).toContain("re-bound");
    expect(result.note).toContain("Nothing was pressed");
    expect(result.note).not.toContain("GONE");
    // Mail was raised and brought forward, the handle read right after, and
    // nothing pressed.
    const tools = seen.map((c) => c.tool);
    const activated = tools.lastIndexOf("activate");
    expect(tools.slice(activated - 1, activated + 2)).toEqual([
      "raise_window",
      "activate",
      "mail_composers",
    ]);
    expect(tools).not.toContain("key");
    lane.close();
  });

  it("a forward with nothing to fill is not saved by command-S when its handle is re-bound", async () => {
    const { lane, seen } = await laneOver(
      healthyHost(
        {
          mail_composers: (_a: unknown, n: number) => ({
            composers: n === 1 ? [] : [composer("mc-1", "Fwd: lunch", { rebound: n >= 3 })],
          }),
        },
        "Fwd: lunch",
      ),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Fwd: lunch"),
      { ...PARAMS, mode: "forward", body: null, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(result.note).toContain("NOT saved");
    expect(result.note).toContain("re-bound");
    expect(presses(seen, "s")).toEqual([]);
    lane.close();
  });

  it("a forward saved by command-S in a tab is not saved while another tab is shown", async () => {
    const { lane, seen } = await laneOver(
      healthyHost(
        {
          mail_composers: (_a: unknown, n: number) => ({
            composers:
              n === 1 ? [] : [composer("mc-1", "Fwd: lunch", { tab: n < 4 ? "selected" : null })],
          }),
        },
        "Fwd: lunch",
      ),
    );
    const untabbed = await composeNatively(
      lane,
      runnerReturning("Fwd: lunch"),
      { ...PARAMS, mode: "forward", body: null, sendNow: false },
      TIMEOUTS,
    );
    // A window of its own (tab null) is pressed as before.
    expect(untabbed).toMatchObject({ ok: true });
    expect(presses(seen, "s")).toHaveLength(1);
    lane.close();

    const tabbed = await laneOver(
      healthyHost(
        {
          mail_composers: (_a: unknown, n: number) => ({
            composers:
              n === 1
                ? []
                : [composer("mc-1", "Fwd: lunch", { tab: n < 4 ? "selected" : "background" })],
          }),
        },
        "Fwd: lunch",
      ),
    );
    const result = await composeNatively(
      tabbed.lane,
      runnerReturning("Fwd: lunch"),
      { ...PARAMS, mode: "forward", body: null, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(result.note).toContain("NOT saved");
    expect(presses(tabbed.seen, "s")).toEqual([]);
    tabbed.lane.close();
  });

  it("a compose window opened by hand during the poll, with another subject, is not picked", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? []
              : n === 2
                ? [composer("mc-7", "Something the person typed")]
                : [composer("mc-7", "Something the person typed"), composer("mc-1", "Re: lunch")],
        }),
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      { sendTimeoutMs: 50, composerTimeoutMs: 1000 },
    );
    expect(result.ok).toBe(true);
    expect(edits(seen)).toHaveLength(1);
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-1" });
    lane.close();
  });

  it("two new composers with the subject refuse to fill", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers: n === 1 ? [] : [composer("mc-1", "Re: lunch"), composer("mc-2", "Re: lunch")],
        }),
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: null });
    expect(result.note).toContain("mc-1, mc-2");
    expect(result.note).toContain("left open");
    expect(edits(seen)).toEqual([]);
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  it("fills nothing when the one new composer left reads as the older draft", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? [composer("mc-1", "Re: lunch", { tab: "selected", text: "an older reply" })]
              : n === 2
                ? [
                    composer("mc-2", "Re: lunch", { tab: "background", text: null }),
                    composer("mc-3", "Re: lunch", { tab: "selected", text: null }),
                  ]
                : [composer("mc-4", "Re: lunch", { tab: "selected", text: "an older reply" })],
        }),
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      { ...TIMEOUTS, composerTimeoutMs: 1000 },
    );
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: null });
    expect(result.note).toContain("(mc-4) could not be told from the draft already open");
    expect(edits(seen)).toEqual([]);
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  it("hands attachments to the verb and reports how many", async () => {
    const { lane, seen } = await laneOver(healthyHost());
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false, attachments: ["/Users/me/chart.png"] },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, bodyVerified: true, attachments: 1 });
    expect(edits(seen)[0]?.args).toMatchObject({
      attachments: ["/Users/me/chart.png"],
      save: true,
    });
    lane.close();
  });

  it("maps a refusal from the verb to a failed compose carrying its reason and hint", async () => {
    const { lane } = await laneOver(
      healthyHost({
        mail_composer_edit: {
          replaced: false,
          degraded: true,
          capability: "attachments",
          reason: "chart.png did not read back.",
          hint: "Attach it by hand.",
        },
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, degraded: true, sent: false });
    expect(result.note).toContain("chart.png did not read back.");
    expect(result.note).toContain("Attach it by hand.");
    lane.close();
  });

  /*
   * The failure this whole path is shaped around: a draft correct in every
   * visible respect except the words, reported as a success.
   */
  it("refuses to report a draft ready when the read-back is not the body", async () => {
    const { lane } = await laneOver(
      healthyHost({
        mail_composer_edit: { ...filled({ body: "SOMETHING ELSE", save: true }) },
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: false, bodyVerified: false, sent: false });
    expect(result.note).toContain("MUST NOT be described to the user as ready");
    lane.close();
  });

  it("compares the read-back with whitespace folded", async () => {
    const { lane } = await laneOver(
      healthyHost({
        mail_composer_edit: { ...filled({ body: "Thanks —\n  Tuesday   works.", save: true }) },
      }),
    );
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, body: "Thanks — Tuesday works.", sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, bodyVerified: true });
    lane.close();
  });

  /*
   * The incident this path was rebuilt around, 2026-09-09: a reply composed
   * correctly and sent by hand while the call was still running. The tool said
   * the body had not gone in. The one true sentence — the composer is gone, so
   * someone took it — was never said.
   */
  it("reports a composer that vanished mid-fill as gone, not as a body that failed", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await composeNatively(
      lane,
      runnerWithSent("Re: lunch", { checked: true, mailbox: "Sent", found: false, scanned: 25 }),
      PARAMS,
      TIMEOUTS,
    );
    expect(result.note).toContain("is GONE");
    expect(result.note).not.toContain("the body did not go in");
    expect(result.bodyVerified).toBeNull();
    lane.close();
  });

  /*
   * Sent and discarded leave exactly the same empty screen, and only Mail can
   * tell them apart. A sent reply called a failure invites a retry that sends
   * it twice.
   */
  it("says the reply went when Sent holds it, and does not invite a retry", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await composeNatively(
      lane,
      runnerWithSent("Re: lunch", {
        checked: true,
        mailbox: "Sent Items",
        found: true,
        scanned: 25,
        messages: [{ dateSent: "2026-09-09T20:56:54.000Z" }],
      }),
      PARAMS,
      TIMEOUTS,
    );
    expect(result.sent).toBe(true);
    expect(result.note).toContain("WAS SENT");
    expect(result.note).toContain("2026-09-09T20:56:54.000Z");
    expect(result.note).toContain("Do NOT send it again");
    lane.close();
  });

  it("refuses to call it unsent when Sent's newest entry predates the call", async () => {
    const { lane } = await laneOver(composerThatVanishes());
    const result = await composeNatively(
      lane,
      runnerWithSent("Re: lunch", {
        checked: true,
        mailbox: "Sent",
        found: false,
        scanned: 25,
        newest: "2019-01-01T00:00:00.000Z",
      }),
      PARAMS,
      TIMEOUTS,
    );
    expect(result.sent).toBeNull();
    expect(result.note).toContain("could NOT be told");
    lane.close();
  });

  /*
   * The same vanishing, one step later: filled, and the window gone before the
   * send. Nothing may be pressed into an unknown foreground.
   */
  it("does not press send into whatever replaced a composer that went", async () => {
    const { lane, seen } = await laneOver(
      healthyHost({ raise_window: (_a: unknown, n: number) => (n > 0 ? { refusal: "gone" } : {}) }),
    );
    const result = await composeNatively(
      lane,
      runnerWithSent("Re: lunch", { checked: true, mailbox: "Sent", found: false, scanned: 25 }),
      PARAMS,
      TIMEOUTS,
    );
    expect(result.note).toContain("is GONE");
    expect(presses(seen, "d")).toEqual([]);
    lane.close();
  });

  it("does not report a send whose window is still open", async () => {
    const { lane } = await laneOver(healthyHost());
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(result.note).toContain("may not have gone");
    lane.close();
  });

  /*
   * The send key names the composer's window, so the desktop server refuses it
   * when Mail will not come forward. That is a composer still on screen with
   * nothing pressed, and reporting it as GONE would send the user looking for a
   * message that is sitting unsent in front of them.
   */
  it("does not call a composer that would not come forward gone", async () => {
    const { lane } = await laneOver(
      healthyHost({
        key: (args: { key?: string }) =>
          args.key === "d"
            ? { refusal: "com.apple.mail did not come to the front, so nothing was posted" }
            : {},
      }),
    );
    const result = await composeNatively(lane, runnerReturning("Re: lunch"), PARAMS, TIMEOUTS);
    expect(result).toMatchObject({ ok: false, sent: false, bodyVerified: true });
    expect(result.note).not.toContain("GONE");
    expect(result.note).toContain("still open");
    expect(result.note).toContain("nothing was pressed");
    lane.close();
  });

  it("saves through the verb, with no keystroke of its own", async () => {
    const { lane, seen } = await laneOver(healthyHost());
    const result = await composeNatively(
      lane,
      runnerReturning("Re: lunch"),
      { ...PARAMS, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, sent: false, bodyVerified: true });
    expect(edits(seen)[0]?.args).toMatchObject({ save: true });
    expect(seen.filter((c) => c.tool === "key")).toEqual([]);
    lane.close();
  });

  /*
   * A forward's body is optional. With neither a body nor files there is
   * nothing for the verb to do, so it is not called, and the draft is saved the
   * way it always was.
   */
  it("saves a forward with no body and no files with command-S, without the verb", async () => {
    const { lane, seen } = await laneOver(healthyHost({}, "Fwd: lunch"));
    const result = await composeNatively(
      lane,
      runnerReturning("Fwd: lunch"),
      { ...PARAMS, mode: "forward", body: null, sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, sent: false, bodyVerified: null });
    expect(edits(seen)).toEqual([]);
    expect(seen.at(-1)).toEqual({
      tool: "key",
      args: { key: "s", modifiers: ["command"], handle: "w1" },
    });
    lane.close();
  });

  it("fills only the files of a forward with no body", async () => {
    const { lane, seen } = await laneOver(healthyHost({}, "Fwd: lunch"));
    const result = await composeNatively(
      lane,
      runnerReturning("Fwd: lunch"),
      { ...PARAMS, mode: "forward", body: null, attachments: ["/a.pdf"], sendNow: false },
      TIMEOUTS,
    );
    expect(result).toMatchObject({ ok: true, bodyVerified: null, attachments: 1 });
    expect(edits(seen)[0]?.args).toEqual({
      composer: "mc-1",
      attachments: ["/a.pdf"],
      save: true,
    });
    lane.close();
  });

  /*
   * Asked BEFORE anything is opened: the failure this tool was best known for
   * left an empty reply window on screen on every attempt.
   */
  it("refuses before opening a composer when Mail's windows cannot be read", async () => {
    const { lane, seen } = await laneOver({});
    lane.close();
    const dead = MailAxLane.open({
      CUPERTINO_AX_SOCKET: "/nonexistent.sock",
      CUPERTINO_AX_FOR: "mail",
    })!;
    await expect(composeNatively(dead, runnerReturning("Re: lunch"), PARAMS, {})).rejects.toThrow(
      /Accessibility/,
    );
    expect(seen).toEqual([]);
  });
});

/*
 * A NEW message, composed the way a reply is. The incident this exists for,
 * 2026-10-21: a new message's body was assigned to `content`, Mail wrapped it
 * in a quotation it hides and Outlook shows. Nothing here may assign it; the
 * verb types it and reads it back.
 */
/** A runner that opens "GPU VMs" and records what it was asked. */
const recording = () => {
  const calls: { script: string; params: Record<string, unknown> }[] = [];
  const runner = {
    run: async (script: string, params: Record<string, unknown>) => {
      calls.push({ script, params });
      return { subject: "GPU VMs" };
    },
  } as never;
  return { calls, runner };
};

describe("composeNatively, a new message", () => {
  const NEW = {
    mode: "new" as const,
    accountUuid: null,
    subject: "GPU VMs",
    senderAddress: "me@example.com",
    body: "PASTED",
    to: ["dave@example.com"],
    cc: [],
    bcc: [],
    sendNow: false,
  };
  const newHost = (over: Record<string, unknown> = {}) => healthyHost(over, "GPU VMs");

  it("opens it without a body, fills the body through the verb, and saves", async () => {
    const { lane, seen } = await laneOver(newHost());
    const { calls, runner } = recording();
    const result = await composeNatively(lane, runner, NEW, TIMEOUTS);
    lane.close();
    expect(result).toMatchObject({ ok: true, bodyVerified: true, sent: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({ mode: "new", subject: "GPU VMs" });
    // Neither the body nor the files travel to Mail's scripting object.
    expect(calls[0]?.params).not.toHaveProperty("attachments");
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-1", body: "PASTED", save: true });
  });

  it("no longer refuses a subject that is already a window", async () => {
    const { lane, seen } = await laneOver(
      newHost({
        mail_composers: (_a: unknown, n: number) => ({
          composers:
            n === 1
              ? [composer("mc-1", "GPU VMs")]
              : [composer("mc-1", "GPU VMs"), composer("mc-3", "GPU VMs")],
        }),
        list_windows: { windows: [{ handle: "w1", index: 0, title: "GPU VMs" }] },
      }),
    );
    const { calls, runner } = recording();
    const result = await composeNatively(lane, runner, NEW, TIMEOUTS);
    lane.close();
    expect(result).toMatchObject({ ok: true, sent: false });
    expect(calls).toHaveLength(1);
    expect(edits(seen)[0]?.args).toMatchObject({ composer: "mc-3" });
  });
});
