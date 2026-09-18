import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailAxLane } from "../src/client/ax.js";
import type { Clipboard } from "../src/client/compose.js";
import { reviseDraftInPlace, type DraftFacts } from "../src/client/revise.js";

/**
 * Editing a draft in its own composer, run against a fake Mail window.
 *
 * The thing being pinned is not that it works. It is that **every way it can go
 * wrong leaves the draft alone**, and the reason this path is allowed to exist
 * at all is that selecting and copying change nothing — so a selection that
 * cannot be proved exact costs a refusal, never a body.
 *
 * So the fake below is built to lie in the ways a real composer does: a window
 * that is a leftover from another thread, a paragraph that wraps so the block
 * count undercounts the lines, an empty selection that leaves the pasteboard as
 * it was, and a tree that has not caught up with the paste yet. The assertion in
 * every refusal case is the same one — **no command-V was ever posted.**
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

/** How many whole rendered lines a caret in this state has selected. */
const selected = (entry: { endLine: number; atEnd: boolean }): number =>
  entry.endLine + (entry.atEnd ? 1 : 0);

/** A composer window: what it holds above the quote, and what it quotes. */
type Composer = {
  title: string;
  /** Rendered lines of the sender's own text. A wrapped paragraph is >1 line. */
  lines: string[];
  /** How many blocks those lines make up — what AXBlockQuoteLevel 0 counts. */
  blocks?: number;
  quote?: string[];
};

type Behaviour = {
  composers: Composer[];
  /** command-C copies nothing, the way it does over an empty selection. */
  copyDoesNothing?: boolean;
  /** The body cannot be focused: someone is using the Mac. */
  unfocusable?: boolean;
  /** How many reads after the paste before the tree shows it. */
  renderAfter?: number;
  /** The paste swallows the quoted original — the damage this must never save. */
  quoteLostOnPaste?: boolean;
};

/**
 * A Mail whose composer really holds a document and a caret.
 *
 * It models the two things the selection depends on: the caret's line, and the
 * selection's extent in rendered lines. `up+command` homes it, `down+shift`
 * extends by a line, `right+shift+command` runs to that line's end, and `c` puts
 * the selected lines on the stub clipboard. Everything past the sender's own
 * lines is quoted text, so a selection that reaches it copies it back — which is
 * exactly the overshoot the real thing has to refuse.
 */
const hostStub = async (
  behaviour: Behaviour,
  clipboard: { value: string | null },
): Promise<{ env: NodeJS.ProcessEnv; seen: Call[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "mail-revise-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: Call[] = [];

  // Which window each body handle belongs to, and where its caret is.
  /*
   * The caret, modelled the way a text view really behaves.
   *
   * `endLine` is the rendered line the selection reaches, and `atEnd` whether it
   * runs to that line's end. Extending DOWN lands mid-line — the column comes
   * from wherever the selection started — so a line is only wholly selected once
   * command-right has run it out. Collapsing those two into one counter is what
   * the first version of this fake did, and it made an overshoot look exact.
   */
  const state = behaviour.composers.map((composer) => ({
    composer,
    endLine: 0,
    atEnd: false,
    pastes: 0,
  }));
  let readsSincePaste = 0;

  const lines = (at: number): string[] => {
    const { composer } = state[at] as (typeof state)[number];
    return [...composer.lines, ...(composer.quote ?? [])];
  };

  const answer = (tool: string, args: Record<string, unknown>): Record<string, unknown> => {
    if (tool === "list_windows") {
      return {
        windows: behaviour.composers.map((composer, index) => ({
          handle: `w${index}`,
          index,
          title: composer.title,
        })),
      };
    }
    if (tool === "ui_tree") {
      // Any window with a body area is a composer.
      return { elements: [{ role: "AXWebArea", depth: 1, handle: `b${args.window}` }] };
    }
    if (tool === "expand") {
      const at = Number(String(args.handle).slice(1));
      const entry = state[at] as (typeof state)[number];
      const own = entry.composer.lines;
      const shown =
        entry.pastes > 0 && readsSincePaste++ < (behaviour.renderAfter ?? 0)
          ? // The tree has not caught up with the paste yet.
            ["ALPHA one", "ALPHA two"]
          : own;
      const blocks = entry.pastes > 0 ? shown.length : (entry.composer.blocks ?? shown.length);
      // One element per block, then the quote as one more block.
      const elements = Array.from({ length: blocks }, (_, block) => ({
        role: "AXGroup",
        depth: 0,
        handle: `${args.handle}q${block}`,
        // Blocks that wrap hold more than one line; join them back for the value.
        value: shown
          .slice(blockStart(shown, blocks, block), blockStart(shown, blocks, block + 1))
          .join(" "),
      }));
      const quoteGone = behaviour.quoteLostOnPaste === true && entry.pastes > 0;
      if ((entry.composer.quote ?? []).length > 0 && !quoteGone) {
        elements.push({
          role: "AXGroup",
          depth: 0,
          handle: `${args.handle}quote`,
          value: "quoted",
        });
      }
      return { elements, matched: elements.length, returned: elements.length };
    }
    if (tool === "get_attribute") {
      return { value: String(args.handle).endsWith("quote") ? 1 : 0 };
    }
    if (tool === "focus") return { focused: behaviour.unfocusable !== true };
    if (tool === "raise_window" || tool === "activate") return {};
    if (tool === "key" || tool === "run") {
      const strokes =
        tool === "run"
          ? (args.steps as Record<string, unknown>[])
          : [args as Record<string, unknown>];
      for (const stroke of strokes) {
        const at = Number(String(stroke.handle).slice(1));
        const entry = state[at] as (typeof state)[number];
        const mods = (stroke.modifiers as string[] | undefined) ?? [];
        const key = String(stroke.key);
        if (key === "up" && mods.includes("command")) {
          entry.endLine = 0;
          entry.atEnd = false;
        } else if (key === "down" && mods.includes("shift")) {
          entry.endLine += 1;
          entry.atEnd = false;
        } else if (key === "right" && mods.includes("shift")) {
          entry.atEnd = true;
        } else if (key === "c" && mods.includes("command")) {
          if (behaviour.copyDoesNothing !== true && selected(entry) > 0) {
            clipboard.value = lines(at).slice(0, selected(entry)).join("\n");
          }
        } else if (key === "v" && mods.includes("command")) {
          entry.pastes += 1;
          entry.composer.lines = String(clipboard.value ?? "").split("\n");
          readsSincePaste = 0;
        }
      }
      return {};
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
            result: { content: [{ type: "text", text: JSON.stringify(answer(tool, args)) }] },
          })}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { env: { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" }, seen };
};

/** Where a block starts, when `lines` rendered lines are shared over `blocks`. */
const blockStart = (lines: string[], blocks: number, block: number): number => {
  const extra = lines.length - blocks;
  // The first block soaks up every wrapped line, which is the awkward shape.
  if (block === 0) return 0;
  return Math.min(lines.length, block + extra);
};

const facts = (over: Partial<DraftFacts> = {}): DraftFacts => ({
  subject: "Re: Quarterly numbers",
  isReply: true,
  attachments: 0,
  recipientCount: 2,
  contentHead: "ALPHA one\nALPHA two\n\nOn 18 Sep 2026, Ada wrote:",
  draftsMailbox: "Drafts",
  ...over,
});

const stubClipboard = (initial = "user's own clipboard") => {
  const box = { value: initial as string | null };
  const clipboard: Clipboard = {
    read: async () => box.value,
    write: async (text) => {
      box.value = text;
    },
  };
  return { box, clipboard };
};

const pastes = (seen: Call[]): number =>
  seen.filter((call) => {
    const steps =
      call.tool === "run" ? (call.args.steps as Record<string, unknown>[]) : [call.args];
    return steps.some(
      (step) => step.key === "v" && ((step.modifiers as string[]) ?? []).includes("command"),
    );
  }).length;

describe("reviseDraftInPlace", () => {
  it("replaces the draft's own text and leaves the quote alone", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          {
            title: "Re: Quarterly numbers",
            lines: ["ALPHA one", "ALPHA two"],
            quote: ["On 18 Sep 2026, Ada wrote:", "the original"],
          },
        ],
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), {
      body: "BRAVO one\nBRAVO two\nBRAVO three",
      clipboard,
      renderTimeoutMs: 2000,
    });
    lane.close();

    expect(result).toMatchObject({
      replaced: true,
      method: "inPlace",
      threadingKept: true,
      quoteKept: true,
      saved: true,
    });
    expect(pastes(seen)).toBe(1);
  });

  /*
   * The clipboard is shared machine state. Borrowing it is the mechanism, so the
   * only acceptable behaviour is to put back exactly what was there — including
   * after a refusal, which is the path where it is easiest to forget.
   */
  it("puts the clipboard back", async () => {
    const { box, clipboard } = stubClipboard("something the user copied");
    const { env } = await hostStub(
      { composers: [{ title: "Re: Quarterly numbers", lines: ["ALPHA one"], quote: ["q"] }] },
      box,
    );
    const lane = MailAxLane.open(env)!;
    await reviseDraftInPlace(lane, facts({ contentHead: "ALPHA one" }), {
      body: "BRAVO",
      clipboard,
      renderTimeoutMs: 2000,
    });
    lane.close();
    expect(box.value).toBe("something the user copied");
  });

  /*
   * `blocks` counts paragraphs; the selection moves by rendered lines. A wrapped
   * paragraph therefore starts the loop SHORT, and the copy-back is what notices
   * and keeps extending. Getting this wrong does not mangle anything — it
   * refuses — but it refuses the ordinary case of a long sentence.
   */
  it("keeps extending the selection when a paragraph wraps", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          {
            title: "Re: Quarterly numbers",
            lines: ["a long sentence that", "wrapped onto three", "rendered lines"],
            blocks: 1,
            quote: ["On 18 Sep 2026, Ada wrote:"],
          },
        ],
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(
      lane,
      facts({ contentHead: "a long sentence that wrapped onto three rendered lines" }),
      { body: "shorter now", clipboard, renderTimeoutMs: 2000 },
    );
    lane.close();
    expect(result).toMatchObject({ replaced: true });
    expect(pastes(seen)).toBe(1);
  });

  /*
   * Two composers under one title cannot be told apart — handles are minted per
   * call — and one of them holds somebody's unsent reply. The same refusal the
   * compose path makes for the same reason.
   */
  it("refuses when two composers share the subject", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          { title: "Re: Quarterly numbers", lines: ["ALPHA one"], quote: ["q"] },
          { title: "Re: Quarterly numbers", lines: ["other reply"], quote: ["q"] },
        ],
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO", clipboard });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(pastes(seen)).toBe(0);
  });

  /*
   * A window with the right title holding a different message. Subject alone is
   * not an identity in a thread where two replies are in flight, and rewriting
   * the wrong one destroys what somebody wrote.
   */
  it("refuses a composer whose contents are not this draft's", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          { title: "Re: Quarterly numbers", lines: ["a different reply entirely"], quote: ["q"] },
        ],
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), { body: "BRAVO", clipboard });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "identity" });
    expect(pastes(seen)).toBe(0);
  });

  /*
   * Belt and braces. Nothing should be able to reach this — the selection was
   * copied back and matched — but a saved draft cannot be undone from here and
   * an unsaved composer can, so a vanished quote stops before command-S.
   */
  it("does not save a paste that swallowed the quoted original", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          { title: "Re: Quarterly numbers", lines: ["ALPHA one", "ALPHA two"], quote: ["q"] },
        ],
        quoteLostOnPaste: true,
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), {
      body: "BRAVO",
      clipboard,
      renderTimeoutMs: 2000,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "confirmation" });
    expect(String((result as { reason: string }).reason)).toContain("GONE");
    const saves = seen.filter((call) => {
      const steps =
        call.tool === "run" ? (call.args.steps as Record<string, unknown>[]) : [call.args];
      return steps.some(
        (step) => step.key === "s" && ((step.modifiers as string[]) ?? []).includes("command"),
      );
    });
    expect(saves).toHaveLength(0);
  });

  /*
   * The selection ran past the sender's own words and copied part of the quoted
   * original back. That is the one outcome this path exists to prevent — the
   * quote is the thing recreation could not keep — so it stops rather than
   * pasting over it, and the draft is left exactly as it was.
   */
  it("refuses when the selection reaches into the quoted original", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          {
            title: "Re: Quarterly numbers",
            lines: ["ALPHA one", "ALPHA two"],
            // One block more than there are lines, so the opening burst
            // overshoots into the quote.
            blocks: 3,
            quote: ["On 18 Sep 2026, Ada wrote:"],
          },
        ],
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts({ contentHead: "ALPHA one ALPHA two" }), {
      body: "BRAVO",
      clipboard,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "selection" });
    expect(pastes(seen)).toBe(0);
  });

  /*
   * command-C over an empty selection leaves the pasteboard untouched, so
   * without the sentinel this would compare against its own previous answer and
   * paste over a selection it never made.
   */
  it("refuses when the selection cannot be read back", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [{ title: "Re: Quarterly numbers", lines: ["ALPHA one"], quote: ["q"] }],
        copyDoesNothing: true,
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts({ contentHead: "ALPHA one" }), {
      body: "BRAVO",
      clipboard,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "selection" });
    expect(pastes(seen)).toBe(0);
  });

  /*
   * No composer at all is NOT a refusal: it is the signal to fall back to
   * recreating the draft, and folding it into one would take that away.
   */
  it("answers null when no composer is open", async () => {
    const { box, clipboard } = stubClipboard();
    const { env } = await hostStub({ composers: [{ title: "Inbox", lines: [] }] }, box);
    const lane = MailAxLane.open(env)!;
    await expect(
      reviseDraftInPlace(lane, facts(), { body: "BRAVO", clipboard }),
    ).resolves.toBeNull();
    lane.close();
  });

  /*
   * Someone is using the Mac, so the keystroke is refused rather than posted
   * into their window. Nothing typed, nothing changed.
   */
  it("refuses when the composer will not take the keyboard", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [{ title: "Re: Quarterly numbers", lines: ["ALPHA one"], quote: ["q"] }],
        unfocusable: true,
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts({ contentHead: "ALPHA one" }), {
      body: "BRAVO",
      clipboard,
      focusTimeoutMs: 0,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "composer" });
    expect(pastes(seen)).toBe(0);
  });

  /*
   * The paste is on the pasteboard before the tree shows it — measured on a real
   * composer, where reading once reported a correct body as a failure. Here the
   * tree lies for two reads and the poll has to outlast it.
   */
  it("waits for the pasted body to reach the tree before saving", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          { title: "Re: Quarterly numbers", lines: ["ALPHA one", "ALPHA two"], quote: ["q"] },
        ],
        renderAfter: 2,
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), {
      body: "BRAVO",
      clipboard,
      renderTimeoutMs: 3000,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: true, saved: true });
    // command-S comes after the verification, never before it.
    const order = seen.flatMap((call) =>
      call.tool === "run"
        ? (call.args.steps as Record<string, unknown>[]).map((s) => s.key)
        : call.tool === "key"
          ? [call.args.key]
          : [call.tool],
    );
    expect(order.lastIndexOf("expand")).toBeLessThan(order.lastIndexOf("s"));
  });

  /*
   * A body that never reads back is NOT saved. The draft keeps its old text and
   * the window is left on screen to be looked at, which is strictly safer than
   * committing something nothing could verify.
   */
  it("does not save a paste it could not verify", async () => {
    const { box, clipboard } = stubClipboard();
    const { env, seen } = await hostStub(
      {
        composers: [
          { title: "Re: Quarterly numbers", lines: ["ALPHA one", "ALPHA two"], quote: ["q"] },
        ],
        renderAfter: 1000,
      },
      box,
    );
    const lane = MailAxLane.open(env)!;
    const result = await reviseDraftInPlace(lane, facts(), {
      body: "BRAVO",
      clipboard,
      renderTimeoutMs: 400,
    });
    lane.close();
    expect(result).toMatchObject({ replaced: false, capability: "confirmation" });
    const saves = seen.filter((call) => {
      const steps =
        call.tool === "run" ? (call.args.steps as Record<string, unknown>[]) : [call.args];
      return steps.some(
        (step) => step.key === "s" && ((step.modifiers as string[]) ?? []).includes("command"),
      );
    });
    expect(saves).toHaveLength(0);
  });
});
