import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/**
 * The last commands agents ran on a page, as the popover lists them.
 *
 * The toolbar popover shows "What agents did here" so the person looking at a
 * tab can see what was clicked, filled and recorded on it. It shows a verb and
 * an element's label, never what was typed: a fill's text is the one thing on
 * this list that could be a secret. `actions.js` keeps the list because every
 * page command goes through its runner; the popover reads it from the content
 * script (`content.js`), never through the background worker.
 */

const SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../../apps/apple/CupertinoSafariExtension/Resources/actions.js", import.meta.url),
  ),
  "utf8",
);

type Entry = {
  at: number;
  action: string;
  op?: string;
  ok: boolean;
  label?: string;
  times?: number;
};
type Result = { ok: boolean; data: any; error?: string };

/** An element `enumerate` lists and `click`, `fill` and `submit` can act on. */
const el = (
  tag: string,
  attrs: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) => {
  const node: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      bottom: 20,
      right: 100,
    }),
    isContentEditable: false,
    isConnected: true,
    innerText: "",
    value: "",
    labels: [],
    href: null,
    click: () => {},
    scrollIntoView: () => {},
    focus: () => {},
    dispatchEvent: () => true,
    ...extra,
  };
  return node;
};

/** actions.js over a fixed element list, with its runner and its list. */
const load = (elements: unknown[] = [], network?: (c: unknown) => Result) => {
  const window: Record<string, unknown> = { innerHeight: 800, innerWidth: 1200 };
  if (network) window.cupertinoNetwork = { run: network };
  const context = createContext({
    crypto: webcrypto,
    window,
    Event: class {
      constructor(public type: string) {}
    },
    document: { querySelectorAll: () => elements, getElementById: () => null },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
  runInContext(SOURCE, context);
  const run = window.cupertinoRunCommand as (c: Record<string, unknown>) => Result;
  const recent = () => (window.cupertinoRecentCommands as () => Entry[])();
  const note = window.cupertinoNoteCommand as (e: Omit<Entry, "at">) => void;
  /** Enumerate, and return the id of the nth element. */
  const idOf = (n: number): string => {
    const out = run({ action: "elements", limit: 50 });
    expect(out.ok, out.error).toBe(true);
    return out.data.elements[n].id;
  };
  return { run, recent, note, idOf, page: window.cupertinoPageToken as string };
};

describe("the last commands agents ran on the page", () => {
  it("lists a click by the label it had before the click", () => {
    const button = el("button", { "aria-label": "Rechercher" });
    const page = load([button]);
    const id = page.idOf(0);
    expect(page.run({ action: "click", elementId: id, page: page.page }).ok).toBe(true);

    expect(page.recent()[0]).toMatchObject({ action: "click", ok: true, label: "Rechercher" });
  });

  it("lists a fill by its field's label and never the text filled", () => {
    const field = el("input", { type: "text", "aria-label": "Nom" });
    const page = load([field]);
    const id = page.idOf(0);
    const out = page.run({ action: "fill", elementId: id, page: page.page, text: "hunter2" });
    expect(out.ok, out.error).toBe(true);

    expect(page.recent()[0]).toMatchObject({ action: "fill", ok: true, label: "Nom" });
    expect(JSON.stringify(page.recent())).not.toContain("hunter2");
  });

  it("lists a submit by its button", () => {
    const form: Record<string, unknown> = { action: "/search", method: "get", noValidate: true };
    const button = el(
      "button",
      { type: "submit", "aria-label": "Rechercher" },
      { form, type: "submit" },
    );
    form.elements = [button];
    const page = load([button]);
    const id = page.idOf(0);
    const out = page.run({ action: "submit", elementId: id, page: page.page });
    expect(out.ok, out.error).toBe(true);

    expect(page.recent()[0]).toMatchObject({ action: "submit", ok: true, label: "Rechercher" });
  });

  it("keeps a netRecord's op", () => {
    const page = load([], () => ({ ok: true, data: {} }));
    page.run({ action: "netRecord", op: "stop" });

    expect(page.recent()[0]).toEqual(
      expect.objectContaining({ action: "netRecord", op: "stop", ok: true }),
    );
  });

  it("lists a refused command as failed, with no label", () => {
    const page = load([el("button", { "aria-label": "Rechercher" })]);
    page.run({ action: "click", elementId: "00000000-e1", page: "00000000" });

    const [entry] = page.recent();
    expect(entry).toMatchObject({ action: "click", ok: false });
    expect(entry).not.toHaveProperty("label");
  });

  it("keeps the last ten, newest first", () => {
    const page = load();
    for (let i = 0; i < 12; i++) {
      page.run({ action: i % 2 === 0 ? "scroll" : "find", direction: "down", text: "x" });
    }

    const recent = page.recent();
    expect(recent).toHaveLength(10);
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i]!.at).toBeLessThanOrEqual(recent[i - 1]!.at);
    }
  });

  it("folds a run of the same command into one entry with a count", () => {
    // wait_for checks the page every 500 ms; ten of those would push the click
    // that came before them off the list.
    const button = el("button", { "aria-label": "Rechercher" });
    const page = load([button]);
    const id = page.idOf(0);
    page.run({ action: "click", elementId: id, page: page.page });
    for (let i = 0; i < 12; i++) page.run({ action: "scroll", direction: "down" });

    const recent = page.recent();
    expect(recent[0]).toMatchObject({ action: "scroll", times: 12 });
    expect(recent.find((e) => e.action === "click")).toMatchObject({ label: "Rechercher" });
  });

  it("never lists what was typed into an editable region with no label of its own", () => {
    // A contenteditable's label falls back to its text, which after a fill is
    // what was typed.
    const box: Record<string, unknown> = el(
      "div",
      { contenteditable: "true" },
      { isContentEditable: true, textContent: "" },
    );
    Object.defineProperty(box, "innerText", { get: () => box.textContent, configurable: true });
    const page = load([box]);
    const id = page.idOf(0);
    const out = page.run({
      action: "fill",
      elementId: id,
      page: page.page,
      text: "my one-time code is 482913",
    });
    expect(out.ok, out.error).toBe(true);

    expect(JSON.stringify(page.recent())).not.toContain("482913");
    expect(page.recent()[0]).toMatchObject({ action: "fill", ok: true });
  });

  it("cuts a label to one line of at most 60 characters", () => {
    const long = "Rechercher dans tous les fonds\n" + "x".repeat(200);
    const button = el("button", {}, { innerText: long });
    const page = load([button]);
    const id = page.idOf(0);
    page.run({ action: "click", elementId: id, page: page.page });

    const { label } = page.recent()[0]!;
    expect(label).toBeDefined();
    expect(label).not.toContain("\n");
    expect(label!.length).toBeLessThanOrEqual(60);
  });

  it("takes a note from outside the runner", () => {
    const page = load();
    page.run({ action: "scroll", direction: "down" });
    page.note({ action: "cookies", ok: true });

    expect(page.recent()[0]).toMatchObject({ action: "cookies", ok: true });
    expect(typeof page.recent()[0]!.at).toBe("number");
  });

  it("hands out a copy, so a reader cannot change the list", () => {
    const page = load();
    page.run({ action: "scroll", direction: "down" });
    page.recent().length = 0;

    expect(page.recent()).toHaveLength(1);
  });
});
