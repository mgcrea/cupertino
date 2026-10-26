import { describe, expect, it, vi } from "vitest";

import { PreconditionError } from "../src/errors.js";
import {
  normalizeFilter,
  WatchRegistry,
  type ArrivalRow,
  type ArrivalSource,
} from "../src/watches.js";

/** A scope is opaque to core: a watch carries keys, a row carries keys, and they must intersect. */
const setup = () => {
  const rows: ArrivalRow[] = [];
  const source: ArrivalSource<ArrivalRow> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => rows.filter((r) => r.cursor > after).slice(0, limit),
  };
  const onUpdate = vi.fn();
  let n = 0;
  const registry = new WatchRegistry({
    surface: "mail",
    source,
    onUpdate,
    mintId: () => `w_${++n}`,
  });
  const push = (sender: string, scope?: string[]) => {
    const cursor = rows.length + 1;
    rows.push({ cursor, key: `k${cursor}`, sender, ...(scope ? { scope } : {}) });
  };
  return { registry, push, onUpdate };
};

describe("normalizeFilter scope", () => {
  it("trims and de-duplicates scope, and omits it when empty", () => {
    expect(normalizeFilter({ from: ["a@x.com"], scope: [" 1 ", "1", "2"] }).scope).toEqual([
      "1",
      "2",
    ]);
    expect("scope" in normalizeFilter({ from: ["a@x.com"], scope: [] })).toBe(false);
    expect("scope" in normalizeFilter({ from: ["a@x.com"] })).toBe(false);
  });

  it("does not count scope against the sender cap, and caps it at 50 itself", () => {
    const scope = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const from = Array.from({ length: 50 }, (_, i) => `a${i}@x.com`);
    expect(() => normalizeFilter({ from, scope })).not.toThrow();
    expect(() => normalizeFilter({ from: ["a@x.com"], scope: [...scope, "more"] })).toThrow(
      PreconditionError,
    );
  });

  it("still needs a sender, whatever the scope", () => {
    expect(() => normalizeFilter({ scope: ["1"] })).toThrow(/from.*domains/);
  });
});

describe("scoped matching", () => {
  it("ticks only for rows whose scope intersects the watch's", () => {
    const { registry, push, onUpdate } = setup();
    const w = registry.add(normalizeFilter({ from: ["a@x.com"], scope: ["2"] }));
    push("a@x.com", ["1"]);
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
    push("a@x.com", ["1", "2"]);
    registry.tick();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(w.uri);
  });

  it("treats a watch with no scope as matching every row, scoped or not", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(normalizeFilter({ from: ["a@x.com"] }));
    push("a@x.com", ["9"]);
    registry.tick();
    push("a@x.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not match a scoped watch against a row with no scope", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(normalizeFilter({ from: ["a@x.com"], scope: ["1"] }));
    push("a@x.com");
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("lets a scoped watch ignore a row while an unscoped one fires on the same tick", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(normalizeFilter({ from: ["a@x.com"], scope: ["1"] }));
    const wide = registry.add(normalizeFilter({ from: ["a@x.com"] }));
    push("a@x.com", ["2"]);
    registry.tick();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(wide.uri);
  });

  it("applies the same rule in read, and echoes scope in the filter", () => {
    const { registry, push } = setup();
    const w = registry.add(normalizeFilter({ from: ["a@x.com"], scope: ["2"] }));
    const all = registry.add(normalizeFilter({ from: ["a@x.com"] }));
    push("a@x.com", ["1"]);
    push("a@x.com", ["2"]);
    const scoped = registry.read(w.id);
    expect(scoped?.messages.map((m) => m.cursor)).toEqual([2]);
    expect(scoped?.cursor).toBe(2);
    expect(scoped?.filter.scope).toEqual(["2"]);
    expect(registry.read(all.id)?.messages.map((m) => m.cursor)).toEqual([1, 2]);
    expect(registry.read(all.id)?.filter.scope).toBeUndefined();
  });
});
