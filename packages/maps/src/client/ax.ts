import { execFileSync } from "node:child_process";

import {
  openAxChannel,
  watchInterference,
  type AxChannel,
  type InterferenceWatch,
} from "@mgcrea/mcp-apple-core";

import { MAPS_SURFACE } from "./errors.js";

/**
 * Maps' place card, driven through Cupertino's native Accessibility driver.
 *
 * ## Why this exists beside the SQL lane rather than replacing it
 *
 * `client/write.ts` writes favourites by copying a record Maps minted and
 * INSERTing it. That lane is correct and stays: pressing the card's `AddButton`
 * does not create a favourite. `docs/desktop.md` measured it — the press lands
 * an **unfiled saved place** and `ZFAVORITEITEM` was 26 rows before and 26
 * after. The two lanes address different objects.
 *
 * What this reaches is the set the SQL lane does not offer at all:
 *
 *   * **The Places library** — `add_to_places` / `delete_from_places`.
 *   * **Guide membership** — `docs/maps.md` lists it as unbuilt: "Adding a place
 *     to a collection needs one `Z_6PLACES` join row".
 *
 * ## The safety argument, which is the real reason to prefer it here
 *
 * The store is mirrored by `NSPersistentCloudKitContainer` and mirroring does
 * not wait to be told, so a malformed row is not a local mistake — it reaches
 * every device on the account. `write.ts` carries the rule that keeps SQL safe:
 * never fabricate a place record, only copy one Maps wrote. **A write made
 * through the interface cannot be malformed at all**, because Maps performs it.
 * Where both lanes could do a job, this one has the smaller blast radius.
 *
 * ## The cost, which is the same one the SQL lane pays
 *
 * Reaching the card means opening `maps://?q=<name>&ll=<lat>,<lon>`, so the
 * place is left in **Recents** whether or not anything is kept. That is the
 * mechanism rather than an oversight, and every tool built on this says so.
 */

const MAPS_BUNDLE = "com.apple.Maps";

/** Identifiers Maps sets on the card. Unlocalised, unlike every name here. */
const CARD = {
  add: "AddButton",
  more: "MoreButton",
  card: "PlaceCardViewController",
  addToGuides: "add_to_guides",
  deleteFromPlaces: "delete_from_places",
  addToPlaces: "add_to_places",
  picker: "GuidesPickerView",
  guideRow: "UserGuidesPickerRowCell",
  done: "CardButtonTypeDone",
  close: "CardButtonTypeClose",
} as const;

type Element = {
  handle: string;
  role: string;
  id?: string | null;
  name?: string | null;
  depth: number;
};
type Tree = { elements?: Element[] };

export type Guide = { name: string; places: number | null };

/** Injected so tests never shell out, matching `write.ts`'s `OpenUrl` seam. */
export type OpenUrl = (url: string) => void;

const defaultOpenUrl: OpenUrl = (url) => {
  // Bounded like `write.ts`'s. `open` normally returns immediately, but it can
  // hang waiting on LaunchServices, and an unbounded synchronous child on a
  // single-threaded server is the whole surface stopping.
  execFileSync("/usr/bin/open", ["-g", url], { timeout: 10_000, stdio: "ignore" });
};

/**
 * `"Favorites, 3 places"` -> `{ name: "Favorites", places: 3 }`.
 *
 * The count is a bonus and the name is the point, so a row whose shape is not
 * recognised keeps its whole label as the name rather than being dropped. A
 * guide that cannot be matched is worse than one with an odd name.
 */
export const parseGuideRow = (label: string): Guide => {
  const match = /^(.*),\s*(\d+)\s+places?$/.exec(label);
  if (!match?.[1]) return { name: label, places: null };
  return { name: match[1], places: Number(match[2]) };
};

/**
 * How long to wait for a card, a sheet or a picker.
 *
 * Overridable so a test can pin a "this never appeared" path without waiting for
 * it. Ten seconds because a place has to resolve over the network before its
 * card exists; sheets and pickers are local and get less.
 */
export type Waits = { card: number; sheet: number };

const DEFAULT_WAITS: Waits = { card: 10_000, sheet: 4_000 };

export class MapsAxLane {
  readonly #channel: AxChannel;
  readonly #openUrl: OpenUrl;
  readonly #waits: Waits;

  private constructor(channel: AxChannel, openUrl: OpenUrl, waits: Waits) {
    this.#channel = channel;
    this.#openUrl = openUrl;
    this.#waits = waits;
  }

  /** Null when this server is not hosted by Cupertino — see `core/src/ax.ts`. */
  static open(
    env: NodeJS.ProcessEnv = process.env,
    openUrl: OpenUrl = defaultOpenUrl,
    waits: Partial<Waits> = {},
  ): MapsAxLane | null {
    const channel = openAxChannel(MAPS_SURFACE, env);
    return channel ? new MapsAxLane(channel, openUrl, { ...DEFAULT_WAITS, ...waits }) : null;
  }

  close(): void {
    this.#channel.close();
  }

  /** Start watching for someone using the Mac during a sequence. */
  watch(): InterferenceWatch {
    return watchInterference(this.#channel);
  }

  #call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#channel.call({ tool: `apple_desktop_${tool}`, args });
  }

  async #tree(): Promise<Element[]> {
    const tree = (await this.#call("ui_tree", {
      bundleId: MAPS_BUNDLE,
      detail: "all",
      maxDepth: 20,
      maxNodes: 4000,
      budgetSeconds: 20,
    })) as Tree;
    return tree.elements ?? [];
  }

  /**
   * Wait for an element rather than for a duration.
   *
   * `docs/desktop.md` calls this the trap that cost it the most: a card's chrome
   * appears before its content, so no fixed settle time is correct. Cheap here —
   * a whole Maps walk is ~0.17 s.
   */
  async #poll(
    match: (element: Element) => boolean,
    timeoutMs = this.#waits.card,
  ): Promise<Element | null> {
    const deadline = Date.now() + timeoutMs;
    // A read can legitimately fail WHILE waiting: `maps://` launches Maps, and
    // for a moment it is running with no window this surface can address. That
    // is a waiting state rather than a verdict, so it is swallowed until the
    // deadline — and then RETHROWN, because "the card never appeared" is a much
    // worse sentence than "Accessibility is not granted" when the latter is why.
    let lastError: unknown = null;
    for (;;) {
      try {
        const found = (await this.#tree()).find(match);
        if (found) return found;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        if (lastError) throw lastError;
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /**
   * Open a place and wait for its card.
   *
   * The combined `q=` and `ll=` form, because a coordinate positions the map and
   * a NAME selects a place — `write.ts` records the same thing for the same
   * reason.
   */
  async openCard(place: { name: string; latitude: number; longitude: number }): Promise<boolean> {
    this.#openUrl(
      `maps://?q=${encodeURIComponent(place.name)}&ll=${place.latitude},${place.longitude}`,
    );
    return (await this.#poll((e) => e.id === CARD.add)) !== null;
  }

  /**
   * Is this place saved?
   *
   * Read off `AddButton`'s NAME, which is the state bit. `docs/desktop.md`
   * corrected itself on this: `FavoriteButton` reports identical attributes
   * either way, and the sibling carries `"Add"` versus `"Added"`.
   *
   * Localised, and that is a real limit rather than an oversight — there is no
   * unlocalised state anywhere on this card.
   */
  async isSaved(): Promise<boolean | null> {
    const add = await this.#poll((e) => e.id === CARD.add, this.#waits.sheet);
    if (!add?.name) return null;
    return add.name !== "Add";
  }

  /**
   * Open the card's overflow menu and return its items.
   *
   * POLLED, not settled. The first version asked for the items in the same
   * breath as the press and got an empty list every time — the menu takes on the
   * order of half a second to appear — and then reported "the overflow menu did
   * not open", which is a sentence about Maps rather than about the race. That
   * is this repo's own rule broken in the file that quotes it: **poll for the
   * control, never wait a fixed time for it.**
   */
  async #openMenu(): Promise<Element[]> {
    const more = await this.#poll((e) => e.id === CARD.more);
    if (!more) return [];
    await this.#call("press", { handle: more.handle });
    const deadline = Date.now() + this.#waits.sheet;
    for (;;) {
      const items = (await this.#call("find_elements", {
        bundleId: MAPS_BUNDLE,
        role: "AXMenuItem",
      })) as Tree;
      if (items.elements?.length) return items.elements;
      if (Date.now() >= deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async #dismiss(): Promise<void> {
    await this.#call("key", { key: "escape", modifiers: [] });
  }

  /**
   * Save the open place into the Places library.
   *
   * Two presses, not one: `AddButton` raises a **"Name This Location"** sheet
   * and nothing is written until its `Save` is pressed. The sheet REPLACES the
   * window list — a full walk during it returns the sheet and nothing else — so
   * the card's elements are unreachable until it closes, and `Save` carries no
   * `AXIdentifier`, which is why it is addressed by name.
   */
  async savePlace(): Promise<boolean> {
    const add = await this.#poll((e) => e.id === CARD.add);
    if (!add) return false;
    await this.#call("press", { handle: add.handle });
    const save = await this.#poll(
      (e) => e.role === "AXButton" && e.name === "Save",
      this.#waits.sheet,
    );
    if (!save) return false;
    await this.#call("press", { handle: save.handle });
    return true;
  }

  /**
   * Remove the open place from the Places library.
   *
   * The menu item is `delete_from_places`, and it is only present when the place
   * IS saved — the same slot carries `add_to_places` when it is not. So its
   * absence is a state reading rather than a failure, and this reports which.
   */
  async removePlace(): Promise<"removed" | "not-saved" | "no-menu"> {
    const items = await this.#openMenu();
    if (!items.length) return "no-menu";
    const remove = items.find((e) => e.id === CARD.deleteFromPlaces);
    if (!remove) {
      await this.#dismiss();
      return items.some((e) => e.id === CARD.addToPlaces) ? "not-saved" : "no-menu";
    }
    await this.#call("press", { handle: remove.handle });
    return "removed";
  }

  /**
   * Every guide Maps knows about, read off its own picker.
   *
   * This is the authoritative list, and it is not the same as the store's:
   * `docs/desktop.md` found the picker showing a "Favorites" guide that
   * `apple_maps_list_collections` does not return. Read here as a side effect of
   * being on the way to a write, rather than as a tool of its own — reaching it
   * needs a place card, which needs a `maps://` open, which leaves a Recents
   * entry. That is too much side effect for something calling itself a read.
   *
   * Leaves the picker OPEN, because the caller is normally about to press a row.
   */
  async openGuidePicker(): Promise<Guide[] | null> {
    const items = await this.#openMenu();
    const guides = items.find((e) => e.id === CARD.addToGuides);
    if (!guides) {
      if (items.length) await this.#dismiss();
      return null;
    }
    await this.#call("press", { handle: guides.handle });
    if (!(await this.#poll((e) => e.id === CARD.picker, this.#waits.sheet))) return null;
    return (await this.#tree())
      .filter((e) => e.id === CARD.guideRow && e.name)
      .map((e) => parseGuideRow(e.name as string));
  }

  /** Press one guide row, then Done. Returns false if no row matched. */
  async chooseGuide(name: string): Promise<boolean> {
    const wanted = name.toLowerCase();
    const row = (await this.#tree()).find(
      (e) => e.id === CARD.guideRow && parseGuideRow(e.name ?? "").name.toLowerCase() === wanted,
    );
    if (!row) return false;
    await this.#call("press", { handle: row.handle });
    const done = await this.#poll((e) => e.id === CARD.done, this.#waits.sheet);
    if (!done) return false;
    await this.#call("press", { handle: done.handle });
    return true;
  }

  /**
   * Re-open the card and read the state bit, which is the only way to verify.
   *
   * **A write closes the card.** Saving through the naming sheet dismisses the
   * whole place card and returns Maps to its main view, so reading `AddButton`
   * straight after a press finds nothing and reports "the card does not say it
   * is saved" — which is a sentence about the write having failed, when what
   * actually happened is that the thing being read went away.
   *
   * So verification re-opens the place first. That costs another `maps://`,
   * which is free in the sense that matters: the Recents entry this leaves was
   * already left by opening the card in the first place.
   */
  async verifySaved(place: {
    name: string;
    latitude: number;
    longitude: number;
  }): Promise<boolean | null> {
    if (!(await this.openCard(place))) return null;
    return this.isSaved();
  }

  /** Abandon the picker without filing anything. */
  async cancelGuidePicker(): Promise<void> {
    const close = await this.#poll((e) => e.id === CARD.close, this.#waits.sheet);
    if (close) await this.#call("press", { handle: close.handle });
  }
}
