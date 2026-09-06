import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MapsAxLane, parseGuideRow } from "../src/client/ax.js";

const open = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of open) server.close();
  open.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

const el = (over: Record<string, unknown>) => ({ role: "AXButton", depth: 3, ...over });

/** A stand-in for the app's desktop server, answering per verb. */
const laneOver = async (
  answers: Record<string, unknown>,
): Promise<{
  lane: MapsAxLane;
  seen: { tool: string; args: Record<string, unknown> }[];
  opened: string[];
}> => {
  const dir = mkdtempSync(join(tmpdir(), "maps-ax-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const counts: Record<string, number> = {};
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let greeted = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
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
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(body) }] },
          })}\n`,
        );
      }
    });
  });
  open.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const lane = MapsAxLane.open(
    { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "maps" },
    (url) => opened.push(url),
    // Short, so a "this never appeared" path is pinned without waiting for it.
    { card: 900, sheet: 400 },
  )!;
  return { lane, seen, opened };
};

const BIG_BEN = { name: "Big Ben", latitude: 51.5007, longitude: -0.1246 };

describe("parseGuideRow", () => {
  it("splits Maps' own label into a name and a count", () => {
    expect(parseGuideRow("Favorites, 3 places")).toEqual({ name: "Favorites", places: 3 });
    expect(parseGuideRow("Urgences, 1 place")).toEqual({ name: "Urgences", places: 1 });
  });

  /*
   * The count is a bonus and the name is the point. A guide whose label does not
   * parse must still be selectable, so the whole label becomes the name rather
   * than the row being dropped — an unmatchable guide is worse than an odd name.
   */
  it("keeps an unrecognised label whole rather than dropping the row", () => {
    expect(parseGuideRow("Chez moi")).toEqual({ name: "Chez moi", places: null });
    expect(parseGuideRow("A, B, 2 places")).toEqual({ name: "A, B", places: 2 });
  });
});

describe("MapsAxLane.open", () => {
  it("is null when this server was not started by Cupertino", () => {
    expect(MapsAxLane.open({})).toBeNull();
  });
});

describe("openCard", () => {
  /*
   * The combined q= and ll= form: a coordinate positions the map and a NAME
   * selects a place. `client/write.ts` records the same thing for the same
   * reason.
   */
  it("opens the place by name AND coordinate, then waits for the card", async () => {
    const { lane, opened } = await laneOver({
      ui_tree: { elements: [el({ handle: "e1", id: "AddButton", name: "Add" })] },
    });
    await expect(lane.openCard(BIG_BEN)).resolves.toBe(true);
    expect(opened).toEqual(["maps://?q=Big%20Ben&ll=51.5007,-0.1246"]);
    lane.close();
  });

  /*
   * The trap docs/desktop.md calls the most expensive one it found: a card's
   * chrome appears before its content, so no fixed settle is correct.
   */
  it("polls for the card rather than reading once", async () => {
    const { lane, seen } = await laneOver({
      ui_tree: (_a: unknown, n: number) =>
        n < 3
          ? { elements: [el({ handle: "e9", id: "PlaceCardViewController" })] }
          : { elements: [el({ handle: "e1", id: "AddButton", name: "Add" })] },
    });
    await expect(lane.openCard(BIG_BEN)).resolves.toBe(true);
    expect(seen.filter((c) => c.tool === "ui_tree").length).toBeGreaterThan(2);
    lane.close();
  });
});

describe("isSaved", () => {
  /*
   * Read off AddButton's NAME. FavoriteButton reports identical attributes
   * whether or not the place is saved; the sibling carries the state.
   */
  it("reads the state bit off AddButton", async () => {
    const notSaved = await laneOver({
      ui_tree: { elements: [el({ handle: "e1", id: "AddButton", name: "Add" })] },
    });
    await expect(notSaved.lane.isSaved()).resolves.toBe(false);
    notSaved.lane.close();

    const saved = await laneOver({
      ui_tree: { elements: [el({ handle: "e1", id: "AddButton", name: "Added" })] },
    });
    await expect(saved.lane.isSaved()).resolves.toBe(true);
    saved.lane.close();
  });

  it("is null, not false, when the card cannot be read at all", async () => {
    const { lane } = await laneOver({ ui_tree: { elements: [] } });
    await expect(lane.isSaved()).resolves.toBeNull();
    lane.close();
  });
});

describe("savePlace", () => {
  /*
   * Two presses, not one. AddButton raises a "Name This Location" sheet and
   * nothing is written until its Save is pressed — and that Save carries no
   * AXIdentifier, so it is addressed by name.
   */
  it("presses Add, then the sheet's Save", async () => {
    const { lane, seen } = await laneOver({
      ui_tree: (_a: unknown, n: number) =>
        n === 1
          ? { elements: [el({ handle: "eAdd", id: "AddButton", name: "Add" })] }
          : { elements: [el({ handle: "eSave", name: "Save" })] },
    });
    await expect(lane.savePlace()).resolves.toBe(true);
    expect(seen.filter((c) => c.tool === "press").map((c) => c.args.handle)).toEqual([
      "eAdd",
      "eSave",
    ]);
    lane.close();
  });

  it("refuses when the naming sheet never appears", async () => {
    const { lane } = await laneOver({
      ui_tree: { elements: [el({ handle: "eAdd", id: "AddButton", name: "Add" })] },
    });
    await expect(lane.savePlace()).resolves.toBe(false);
    lane.close();
  });
});

describe("removePlace", () => {
  /*
   * delete_from_places is only in this menu when the place IS saved — the same
   * slot carries add_to_places when it is not. So its absence is a state
   * reading, not a failure, and the two must not be reported the same way.
   */
  it("distinguishes 'not saved' from 'the menu never opened'", async () => {
    const notSaved = await laneOver({
      ui_tree: { elements: [el({ handle: "eMore", id: "MoreButton" })] },
      find_elements: { elements: [el({ handle: "e1", id: "add_to_places", role: "AXMenuItem" })] },
    });
    await expect(notSaved.lane.removePlace()).resolves.toBe("not-saved");
    notSaved.lane.close();

    const noMenu = await laneOver({
      ui_tree: { elements: [el({ handle: "eMore", id: "MoreButton" })] },
      find_elements: { elements: [] },
    });
    await expect(noMenu.lane.removePlace()).resolves.toBe("no-menu");
    noMenu.lane.close();
  });

  it("presses Delete from Places when it is there", async () => {
    const { lane, seen } = await laneOver({
      ui_tree: { elements: [el({ handle: "eMore", id: "MoreButton" })] },
      find_elements: {
        elements: [el({ handle: "eDel", id: "delete_from_places", role: "AXMenuItem" })],
      },
    });
    await expect(lane.removePlace()).resolves.toBe("removed");
    expect(seen.filter((c) => c.tool === "press").map((c) => c.args.handle)).toEqual([
      "eMore",
      "eDel",
    ]);
    lane.close();
  });
});

describe("openGuidePicker", () => {
  /*
   * The picker is the authoritative guide list, and it is not the store's:
   * docs/desktop.md found it showing a "Favorites" guide that
   * apple_maps_list_collections does not return.
   */
  it("reads every guide row with its count", async () => {
    const { lane } = await laneOver({
      ui_tree: (_a: unknown, n: number) =>
        n === 1
          ? { elements: [el({ handle: "eMore", id: "MoreButton" })] }
          : {
              elements: [
                el({ handle: "p", id: "GuidesPickerView", role: "AXGroup" }),
                el({ handle: "g1", id: "UserGuidesPickerRowCell", name: "Favorites, 3 places" }),
                el({ handle: "g2", id: "UserGuidesPickerRowCell", name: "Plages, 3 places" }),
                el({ handle: "g3", id: "UserGuidesPickerRowCell", name: "New Guide, 0 places" }),
              ],
            },
      find_elements: {
        elements: [el({ handle: "eG", id: "add_to_guides", role: "AXMenuItem" })],
      },
    });
    await expect(lane.openGuidePicker()).resolves.toEqual([
      { name: "Favorites", places: 3 },
      { name: "Plages", places: 3 },
      { name: "New Guide", places: 0 },
    ]);
    lane.close();
  });

  it("is null when the menu has no Add to Guides", async () => {
    const { lane } = await laneOver({
      ui_tree: { elements: [el({ handle: "eMore", id: "MoreButton" })] },
      find_elements: { elements: [el({ handle: "e1", id: "share", role: "AXMenuItem" })] },
    });
    await expect(lane.openGuidePicker()).resolves.toBeNull();
    lane.close();
  });
});

describe("chooseGuide", () => {
  const picker = {
    ui_tree: {
      elements: [
        el({ handle: "g1", id: "UserGuidesPickerRowCell", name: "Favorites, 3 places" }),
        el({ handle: "g2", id: "UserGuidesPickerRowCell", name: "Plages, 3 places" }),
        el({ handle: "eDone", id: "CardButtonTypeDone", name: "Done" }),
      ],
    },
  };

  it("matches a guide by name, ignoring the count, then presses Done", async () => {
    const { lane, seen } = await laneOver(picker);
    await expect(lane.chooseGuide("Plages")).resolves.toBe(true);
    expect(seen.filter((c) => c.tool === "press").map((c) => c.args.handle)).toEqual([
      "g2",
      "eDone",
    ]);
    lane.close();
  });

  it("matches case-insensitively", async () => {
    const { lane } = await laneOver(picker);
    await expect(lane.chooseGuide("plAGes")).resolves.toBe(true);
    lane.close();
  });

  /*
   * A near-miss must not file the place into the wrong guide. Matching is exact
   * on the parsed name, never a substring.
   */
  it("refuses a name that is not exactly a guide", async () => {
    const { lane, seen } = await laneOver(picker);
    await expect(lane.chooseGuide("Plage")).resolves.toBe(false);
    expect(seen.filter((c) => c.tool === "press")).toEqual([]);
    lane.close();
  });
});
