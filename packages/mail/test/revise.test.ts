import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailAxLane } from "../src/client/ax.js";
import { reviseDraftInPlace, type DraftFacts } from "../src/client/revise.js";

/**
 * Editing a draft in its own composer, run against a fake Cupertino channel.
 *
 * The keystroke walk lives in the app now (`mail_composer_edit`), so what is
 * pinned here is the Node half of the contract: find the ONE composer that holds
 * this draft by content, hand it to the verb with a head to double-check, and
 * pass whatever the verb answers back unchanged. Null still means "no composer".
 */

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

type Call = { tool: string; args: Record<string, unknown> };

type FakeComposer = {
  composer: string;
  subject: string;
  /** Null for a tab Mail is not showing: it cannot be read without switching. */
  text: string | null;
  tab?: "selected" | "background" | null;
  recipients?: string[];
  quoted?: boolean | null;
  files?: string[];
};

type Behaviour = {
  composers: FakeComposer[];
  /** What `mail_composer_edit` answers. Defaults to a success. */
  editAnswer?: Record<string, unknown>;
};

const hostStub = async (
  behaviour: Behaviour,
): Promise<{ env: NodeJS.ProcessEnv; seen: Call[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "mail-revise-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: Call[] = [];

  const answer = (tool: string): Record<string, unknown> => {
    if (tool === "list_windows") return { windows: [{ handle: "w0", index: 0, title: "Inbox" }] };
    if (tool === "mail_composers") {
      return {
        composers: behaviour.composers.map((c) => ({
          recipients: [],
          quoted: true,
          files: [],
          ...c,
        })),
      };
    }
    if (tool === "mail_composer_edit") {
      return (
        behaviour.editAnswer ?? {
          replaced: true,
          method: "inPlace",
          text: "BRAVO",
          quoteKept: true,
          filesAdded: [],
          saved: true,
          note: "done",
        }
      );
    }
    return {};
  };

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
        const args = message.params.arguments as Record<string, unknown>;
        seen.push({ tool, args });
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(answer(tool)) }] },
          })}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { env: { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" }, seen };
};

const SUBJECT = "Re: Quarterly numbers";

const facts = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  subject: SUBJECT,
  isReply: true,
  attachments: 0,
  recipientCount: 2,
  contentHead: "ALPHA one\nALPHA two\n\nOn 18 Sep 2026, Ada wrote:",
  draftsMailbox: "Drafts",
  ...over,
});

const edits = (seen: Call[]): Call[] => seen.filter((c) => c.tool === "mail_composer_edit");

describe("reviseDraftInPlace", () => {
  it("edits the one composer whose text matches when two share the subject", async () => {
    const { env, seen } = await hostStub({
      composers: [
        { composer: "mc-1", subject: SUBJECT, text: "something else entirely" },
        { composer: "mc-2", subject: SUBJECT, text: "ALPHA one\nALPHA two" },
      ],
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
    lane.close();

    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      threadingKept: true,
      quoteKept: true,
      saved: true,
    });
    expect(edits(seen)).toHaveLength(1);
    expect(edits(seen)[0]!.args).toMatchObject({ composer: "mc-2", body: "BRAVO" });
  });

  it("passes the expected head, the first 120 characters of the draft's content", async () => {
    const head = "x".repeat(200);
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-1", subject: SUBJECT, text: head }],
    });
    const lane = MailAxLane.open(env)!;
    await reviseDraftInPlace(lane, facts({ contentHead: head }), { body: "BRAVO" });
    lane.close();
    expect(edits(seen)[0]!.args.expectHead).toBe("x".repeat(120));
  });

  it("passes the native refusal through unchanged", async () => {
    const refusal = {
      replaced: false,
      degraded: true,
      method: "inPlace",
      capability: "confirmation",
      reason: "The paste did not read back, so IT WAS NOT SAVED.",
      hint: "Look at the composer in Mail.",
      extra: { nested: [1, 2] },
    };
    const { env } = await hostStub({
      composers: [{ composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two" }],
      editAnswer: refusal,
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
    lane.close();
    expect(result).toEqual(refusal);
  });

  it("answers null when no composer has this subject", async () => {
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-1", subject: "Inbox", text: "ALPHA one ALPHA two" }],
    });
    const lane = MailAxLane.open(env)!;
    await expect(reviseDraftInPlace(lane, facts(), { body: "BRAVO" })).resolves.toBeNull();
    lane.close();
    expect(edits(seen)).toHaveLength(0);
  });

  it("refuses a composer under this subject whose text is a different message, and does not call edit", async () => {
    const { env, seen } = await hostStub({
      composers: [
        { composer: "mc-1", subject: "Inbox", text: "ALPHA one ALPHA two" },
        { composer: "mc-2", subject: SUBJECT, text: "a different reply entirely" },
      ],
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
    lane.close();
    expect(result).toMatchObject({
      replaced: false,
      degraded: true,
      method: "inPlace",
      capability: "identity",
      composerText: "a different reply entirely",
      draftText: facts().contentHead,
    });
    expect(edits(seen)).toHaveLength(0);
  });

  it("answers null when no composer is open", async () => {
    const { env } = await hostStub({ composers: [] });
    const lane = MailAxLane.open(env)!;
    await expect(reviseDraftInPlace(lane, facts(), { body: "BRAVO" })).resolves.toBeNull();
    lane.close();
  });

  it("refuses when several windows hold the draft's text", async () => {
    const { env, seen } = await hostStub({
      composers: [
        { composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two" },
        { composer: "mc-2", subject: SUBJECT, text: "ALPHA one\nALPHA two" },
      ],
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "identity" });
    expect(String((result as { reason: string }).reason)).toContain(
      "windows hold this draft's text",
    );
    expect(edits(seen)).toHaveLength(0);
  });

  /*
   * Mail with "Prefer tabs: Always". A tab it is not showing gives its subject
   * and a null text, so it cannot be matched by content here: the app selects
   * it and checks `expectHead` against what the window then shows.
   */
  describe("composers in tabs", () => {
    const background = (composer: string): FakeComposer => ({
      composer,
      subject: SUBJECT,
      text: null,
      tab: "background",
      quoted: null,
      recipients: [],
    });

    it("edits the one background tab under the subject, with the head for the app to check", async () => {
      const { env, seen } = await hostStub({
        composers: [
          { composer: "mc-1", subject: SUBJECT, text: "a different reply", tab: "selected" },
          background("mc-2"),
        ],
      });
      const lane = MailAxLane.open(env)!;
      const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
      lane.close();
      expect(result).toMatchObject({ replaced: true });
      expect(edits(seen)).toHaveLength(1);
      expect(edits(seen)[0]!.args).toMatchObject({
        composer: "mc-2",
        body: "BRAVO",
        expectHead: facts().contentHead.slice(0, 120),
      });
    });

    it("sends an empty head for a background tab, so the app checks its text is empty", async () => {
      const { env, seen } = await hostStub({ composers: [background("mc-2")] });
      const lane = MailAxLane.open(env)!;
      await reviseDraftInPlace(lane, facts({ contentHead: "" }), { body: "BRAVO" });
      lane.close();
      expect(edits(seen)[0]!.args).toMatchObject({ composer: "mc-2", expectHead: "" });
    });

    it("refuses when the shown tab matches but a background tab under the subject could too", async () => {
      const { env, seen } = await hostStub({
        composers: [
          { composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two", tab: "selected" },
          background("mc-2"),
        ],
      });
      const lane = MailAxLane.open(env)!;
      const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
      lane.close();
      expect(result).toMatchObject({ replaced: false, capability: "identity" });
      expect(String((result as { reason: string }).reason)).toContain("tab");
      expect(edits(seen)).toHaveLength(0);
    });

    it("refuses when several background tabs carry the subject", async () => {
      const { env, seen } = await hostStub({
        composers: [background("mc-2"), background("mc-3")],
      });
      const lane = MailAxLane.open(env)!;
      const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
      lane.close();
      expect(result).toMatchObject({ replaced: false, capability: "identity" });
      expect(edits(seen)).toHaveLength(0);
    });

    it("keeps the shown tab's own head behaviour when no background tab shares the subject", async () => {
      const { env, seen } = await hostStub({
        composers: [
          { composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two", tab: "selected" },
          { ...background("mc-2"), subject: "Another draft" },
        ],
      });
      const lane = MailAxLane.open(env)!;
      await reviseDraftInPlace(lane, facts(), { body: "BRAVO" });
      lane.close();
      expect(edits(seen)[0]!.args).toMatchObject({ composer: "mc-1" });
    });
  });

  it("sends edits, not a body, when given edits", async () => {
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two" }],
    });
    const lane = MailAxLane.open(env)!;
    await reviseDraftInPlace(lane, facts(), {
      edits: [{ find: "ALPHA", replace: "BRAVO" }],
    });
    lane.close();
    const args = edits(seen)[0]!.args;
    expect(args.edits).toEqual([{ find: "ALPHA", replace: "BRAVO" }]);
    expect("body" in args).toBe(false);
  });

  it("edits the handle it is given without matching by content", async () => {
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-7", subject: "Unrelated", text: "nothing alike" }],
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO", composer: "mc-7" });
    lane.close();
    expect(result).toMatchObject({ replaced: true });
    expect(edits(seen)[0]!.args.composer).toBe("mc-7");
  });

  it("sends files as attachments and names them in the result", async () => {
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-1", subject: SUBJECT, text: "ALPHA one ALPHA two" }],
      editAnswer: {
        replaced: true,
        method: "inPlace",
        text: "ALPHA one ALPHA two",
        quoteKept: true,
        filesAdded: ["report.pdf"],
        saved: true,
        note: "ok",
      },
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), {
      attachments: ["/Users/me/report.pdf"],
    });
    lane.close();
    expect(edits(seen)[0]!.args.attachments).toEqual(["/Users/me/report.pdf"]);
    expect(result).toMatchObject({ replaced: true, filesAdded: ["report.pdf"] });
  });

  it("ignores the file-character and whitespace when matching content", async () => {
    const { env, seen } = await hostStub({
      composers: [{ composer: "mc-1", subject: SUBJECT, text: "ALPHA\n￼ one   ALPHA two" }],
    });
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts({ contentHead: "ALPHA one ALPHA two" }), {
      body: "BRAVO",
    });
    lane.close();
    expect(result).toMatchObject({ replaced: true });
    expect(edits(seen)).toHaveLength(1);
  });
});
