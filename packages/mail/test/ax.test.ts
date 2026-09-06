import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { containsText, MailAxLane } from "../src/client/ax.js";

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

type Answer = Record<string, unknown> | { refusal: string };

/**
 * A stand-in for the app's desktop server.
 *
 * `answers` maps a bare verb — `list_windows`, `expand` — to what it replies,
 * either a document or a refusal. `seen` records the calls in order, which is
 * what pins the sequence a paste has to follow.
 */
const hostStub = async (
  answers: Record<string, Answer | ((args: Record<string, unknown>, n: number) => Answer)>,
): Promise<{ env: NodeJS.ProcessEnv; seen: { tool: string; args: Record<string, unknown> }[] }> => {
  const dir = mkdtempSync(join(tmpdir(), "mail-ax-"));
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
        const args = message.params.arguments as Record<string, unknown>;
        seen.push({ tool, args });
        counts[tool] = (counts[tool] ?? 0) + 1;
        const entry = answers[tool];
        const answer = typeof entry === "function" ? entry(args, counts[tool] ?? 0) : (entry ?? {});
        socket.write(
          `${JSON.stringify(
            "refusal" in answer
              ? { jsonrpc: "2.0", id: message.id, error: { message: answer.refusal } }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: { content: [{ type: "text", text: JSON.stringify(answer) }] },
                },
          )}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { env: { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "mail" }, seen };
};

const el = (over: Record<string, unknown>) => ({ role: "AXStaticText", depth: 3, ...over });

describe("MailAxLane.open", () => {
  /*
   * The whole reason `client/mail.ts` can keep both lanes: a package installed
   * from npm and run by hand has no app to borrow from, and must not be told
   * that is an error.
   */
  it("is null when this server was not started by Cupertino", () => {
    expect(MailAxLane.open({})).toBeNull();
  });
});

describe("reach", () => {
  it("reports the window titles it can actually read", async () => {
    const { env } = await hostStub({
      list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.reach()).resolves.toEqual({
      ok: true,
      reason: null,
      windows: ["Re: lunch"],
    });
    lane.close();
  });

  /*
   * Mail closed down to the menu bar is legitimate. Refusing on an empty list
   * would fail a reply that would have worked.
   */
  it("an empty window list is not a refusal", async () => {
    const { env } = await hostStub({ list_windows: { windows: [] } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.reach()).resolves.toMatchObject({ ok: true, windows: [] });
    lane.close();
  });

  it("a refused read is reported as the accessibility grant, not as an empty Mail", async () => {
    const { env } = await hostStub({ list_windows: { refusal: "not granted" } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.reach()).resolves.toEqual({
      ok: false,
      reason: "accessibility",
      windows: null,
    });
    lane.close();
  });
});

describe("findComposer", () => {
  /*
   * The subject is the identity, and a body area is required with it. Without
   * that second condition the main window and the drafts list both match.
   */
  it("rejects a window with the right title but no body area", async () => {
    const { env } = await hostStub({
      list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      ui_tree: { elements: [el({ handle: "e1", role: "AXToolbar" })] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.findComposer("Re: lunch", 0)).resolves.toBeNull();
    lane.close();
  });

  it("returns the window and its web area when both are there", async () => {
    const { env } = await hostStub({
      list_windows: { windows: [{ handle: "w9", index: 2, title: "Re: lunch" }] },
      ui_tree: {
        elements: [
          el({ handle: "e1", role: "AXToolbar" }),
          el({ handle: "e7", role: "AXWebArea" }),
        ],
      },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.findComposer("Re: lunch", 0)).resolves.toEqual({
      window: "w9",
      body: "e7",
      index: 2,
    });
    lane.close();
  });

  /*
   * The trap docs/desktop.md calls the most expensive one it found: the chrome
   * appearing is not the content being ready. A single read four seconds in
   * found the control on one run and not the next, so this polls.
   */
  it("polls until the body appears rather than reading once", async () => {
    const { env, seen } = await hostStub({
      list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
      ui_tree: (_args, n) =>
        n < 2
          ? { elements: [el({ handle: "e1", role: "AXToolbar" })] }
          : { elements: [el({ handle: "e7", role: "AXWebArea" })] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.findComposer("Re: lunch", 2000)).resolves.toMatchObject({ body: "e7" });
    expect(seen.filter((c) => c.tool === "ui_tree").length).toBeGreaterThan(1);
    lane.close();
  });
});

describe("bodyText", () => {
  it("joins the accessible values under the body", async () => {
    const { env } = await hostStub({
      expand: {
        elements: [
          el({ handle: "e8", value: "Thanks — Tuesday works." }),
          el({ handle: "e9", value: "   " }),
          el({ handle: "e10", value: null }),
          el({ handle: "e11", value: "> original" }),
        ],
      },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.bodyText("e7")).resolves.toBe("Thanks — Tuesday works.\n> original");
    lane.close();
  });

  /*
   * Blind and empty are different answers and must not collapse: one means the
   * composer holds nothing, the other means we cannot see it, and only the
   * second may abandon a draft.
   */
  it("returns null when the body cannot be read at all", async () => {
    const { env } = await hostStub({ expand: { refusal: "stale handle" } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.bodyText("e7")).resolves.toBeNull();
    lane.close();
  });
});

describe("bodySize", () => {
  /*
   * `matched` rather than the returned length. The response is byte capped, so
   * a long quoted message truncates — and a fingerprint read off a truncated
   * list would compare two bounds instead of two states, which is exactly the
   * comparison that decides whether pasting again is safe.
   */
  it("counts what matched, not what fitted in the response", async () => {
    const { env } = await hostStub({
      expand: { elements: [el({ handle: "e8" })], matched: 412, truncated: "raise maxNodes" },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.bodySize("e7")).resolves.toBe(412);
    lane.close();
  });

  it("is -1, never 0, when the body cannot be read", async () => {
    const { env } = await hostStub({ expand: { refusal: "gone" } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.bodySize("e7")).resolves.toBe(-1);
    lane.close();
  });
});

describe("paste", () => {
  /*
   * The order is load-bearing. A raise orders the window forward inside Mail; an
   * activate makes Mail the app a synthetic keystroke reaches; the focus decides
   * which element inside it receives the key. Drop any one and command-V lands
   * somewhere else.
   */
  it("raises, activates, focuses, then sends command-V, in that order", async () => {
    const { env, seen } = await hostStub({ focus: { focused: true } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.paste({ window: "w1", body: "e7", index: 0 })).resolves.toBe(true);
    expect(seen.map((c) => c.tool)).toEqual(["raise_window", "activate", "focus", "key"]);
    expect(seen[3]?.args).toEqual({ key: "v", modifiers: ["command"] });
    lane.close();
  });

  /*
   * An element can report itself focusable and not take the focus. Pressing on
   * regardless would paste into whatever DID have it.
   */
  it("does not send the keystroke when the focus did not take", async () => {
    const { env, seen } = await hostStub({ focus: { focused: false } });
    const lane = MailAxLane.open(env)!;
    await expect(lane.paste({ window: "w1", body: "e7", index: 0 })).resolves.toBe(false);
    expect(seen.map((c) => c.tool)).not.toContain("key");
    lane.close();
  });
});

describe("maxQuoteLevel", () => {
  it("reports the deepest level any element carries", async () => {
    const { env } = await hostStub({
      expand: { elements: [el({ handle: "e8" }), el({ handle: "e9" }), el({ handle: "e10" })] },
      get_attribute: (args) => ({ value: args.handle === "e9" ? 2 : 0 }),
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.maxQuoteLevel("e7")).resolves.toBe(2);
    lane.close();
  });

  /*
   * An element that does not carry the attribute answers null, which the driver
   * returns rather than throwing — structural absences outnumber the nodes on a
   * healthy walk.
   */
  it("treats a missing attribute as level zero", async () => {
    const { env } = await hostStub({
      expand: { elements: [el({ handle: "e8" })] },
      get_attribute: { value: null },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.maxQuoteLevel("e7")).resolves.toBe(0);
    lane.close();
  });
});

describe("containsText", () => {
  it("ignores where a WebKit view chose to break lines", () => {
    expect(containsText("Thanks —\n  Tuesday   works.", "Thanks — Tuesday works.")).toBe(true);
  });

  it("is false when the text simply is not there", () => {
    expect(containsText("> original message", "Thanks — Tuesday works.")).toBe(false);
  });

  it("an empty needle is vacuously present", () => {
    expect(containsText("anything", "   ")).toBe(true);
  });
});

describe("finish", () => {
  /*
   * Command-shift-D rather than pressing the button named "Send". The button's
   * name is localised — a French Mail says "Envoyer" — and the shortcut is not,
   * so addressing it by name would have worked only on the machine this was
   * written on.
   */
  it("sends with the shortcut, not with a localised button name", async () => {
    const { env, seen } = await hostStub({});
    const lane = MailAxLane.open(env)!;
    await lane.finish(true);
    expect(seen).toEqual([{ tool: "key", args: { key: "d", modifiers: ["command", "shift"] } }]);
    lane.close();
  });

  it("saves a draft with command-S", async () => {
    const { env, seen } = await hostStub({});
    const lane = MailAxLane.open(env)!;
    await lane.finish(false);
    expect(seen).toEqual([{ tool: "key", args: { key: "s", modifiers: ["command"] } }]);
    lane.close();
  });
});

describe("composerGone", () => {
  /*
   * How a send is confirmed. Mail closes the window when it accepts one, so the
   * window still being there means it did not go — checked rather than assumed,
   * because nothing here may report success on the strength of a keystroke
   * having been delivered.
   */
  it("is true once the window with that subject has closed", async () => {
    const { env } = await hostStub({
      list_windows: { windows: [{ handle: "w1", index: 0, title: "Inbox" }] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.composerGone("Re: lunch", 0)).resolves.toBe(true);
    lane.close();
  });

  it("is false while the composer is still on screen", async () => {
    const { env } = await hostStub({
      list_windows: { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.composerGone("Re: lunch", 0)).resolves.toBe(false);
    lane.close();
  });

  it("waits for the window to go rather than reading once", async () => {
    const { env } = await hostStub({
      list_windows: (_args, n) =>
        n < 2
          ? { windows: [{ handle: "w1", index: 0, title: "Re: lunch" }] }
          : { windows: [{ handle: "w1", index: 0, title: "Inbox" }] },
    });
    const lane = MailAxLane.open(env)!;
    await expect(lane.composerGone("Re: lunch", 2000)).resolves.toBe(true);
    lane.close();
  });
});
