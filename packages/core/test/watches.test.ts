import { describe, expect, it, vi } from "vitest";

import { PreconditionError } from "../src/errors.js";
import {
  matchesSender,
  normalizeFilter,
  WatchRegistry,
  type ArrivalRow,
  type ArrivalSource,
} from "../src/watches.js";

/** An in-memory store the tests can push to and delete from, ordered by cursor. */
const makeSource = () => {
  const rows: ArrivalRow[] = [];
  const source: ArrivalSource<ArrivalRow> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => rows.filter((r) => r.cursor > after).slice(0, limit),
  };
  return {
    rows,
    source,
    push(sender: string | null, extra: Partial<ArrivalRow> = {}) {
      const cursor = (rows.at(-1)?.cursor ?? 0) + 1;
      const row = { cursor, key: `k${cursor}`, sender, ...extra };
      rows.push(row);
      return row;
    },
    deleteAt(cursor: number) {
      rows.splice(
        rows.findIndex((r) => r.cursor === cursor),
        1,
      );
    },
  };
};

const ids = () => {
  let n = 0;
  return () => `w_${String(++n).padStart(8, "0")}`;
};

const setup = (opts: { startTrigger?: never } = {}) => {
  const store = makeSource();
  const onUpdate = vi.fn();
  const registry = new WatchRegistry({
    surface: "mail",
    source: store.source,
    onUpdate,
    mintId: ids(),
    ...opts,
  });
  return { ...store, onUpdate, registry };
};

const jo = normalizeFilter({ from: ["jo@acme.com"] });
const zed = normalizeFilter({ from: ["zed@other.org"] });

describe("normalizeFilter", () => {
  it("trims, lowercases, strips a leading @ and de-duplicates", () => {
    expect(
      normalizeFilter({ from: [" Jo@Acme.com "], domains: ["@ACME.com", "acme.com"] }),
    ).toEqual({ from: ["jo@acme.com"], domains: ["acme.com"] });
  });

  it("refuses a filter that names nobody", () => {
    for (const input of [{}, { from: [], domains: [] }]) {
      expect(() => normalizeFilter(input)).toThrow(PreconditionError);
      expect(() => normalizeFilter(input)).toThrow(/from.*domains/);
    }
  });

  it("refuses more than 50 entries in total", () => {
    const from = Array.from({ length: 30 }, (_, i) => `a${i}@x.com`);
    const domains = Array.from({ length: 21 }, (_, i) => `d${i}.com`);
    expect(() => normalizeFilter({ from, domains })).toThrow(PreconditionError);
  });
});

describe("matchesSender", () => {
  const filter = normalizeFilter({ domains: ["acme.com"] });

  it("matches the domain and its subdomains", () => {
    expect(matchesSender(filter, "jo@acme.com")).toBe(true);
    expect(matchesSender(filter, "jo@eu.acme.com")).toBe(true);
  });

  it("does not match lookalikes", () => {
    expect(matchesSender(filter, "jo@notacme.com")).toBe(false);
    expect(matchesSender(filter, "acme.com@evil.io")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesSender(filter, "JO@ACME.COM")).toBe(true);
    expect(matchesSender(jo, "Jo@Acme.com")).toBe(true);
  });

  it("never matches null", () => {
    expect(matchesSender(filter, null)).toBe(false);
  });
});

describe("WatchRegistry.add", () => {
  it("mints a URI and records where the store was", () => {
    const { registry, push, source } = setup();
    for (let i = 0; i < 4; i++) push("a@x.com");
    const watch = registry.add(jo);
    expect(watch.uri).toBe("cupertino://mail/watch/w_00000001");
    expect(watch.createdAt).toBe(source.head());
  });

  it("refuses the 11th watch", () => {
    const { registry } = setup();
    for (let i = 0; i < 10; i++) registry.add(jo);
    expect(() => registry.add(jo)).toThrow(PreconditionError);
    expect(() => registry.add(jo)).toThrow("10 watches");
  });
});

describe("WatchRegistry.tick", () => {
  it("notifies only the watch that matched, once", () => {
    const { registry, push, onUpdate } = setup();
    const a = registry.add(jo);
    registry.add(zed);
    for (let i = 0; i < 37; i++) push("noise@x.com");
    for (let i = 0; i < 3; i++) push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(a.uri);
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("advances past excluded rows without matching them", () => {
    const { registry, push, onUpdate, source } = setup();
    registry.add(jo);
    push("jo@acme.com", { excluded: true });
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
    const since = vi.spyOn(source, "since");
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
    // The second tick restarts one row early, never at the beginning.
    expect(since.mock.calls[0]?.[0]).toBe(0);
    push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("sees a row that reused the head cursor", () => {
    const { registry, push, rows, deleteAt, onUpdate } = setup();
    for (let i = 0; i < 10; i++) push("noise@x.com");
    expect(rows.at(-1)?.key).toBe("k10");
    registry.add(jo);
    deleteAt(10);
    rows.push({ cursor: 10, key: "k10b", sender: "jo@acme.com" });
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("does not fire for rows that predate the watch", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(zed);
    push("jo@acme.com");
    registry.add(jo);
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe("WatchRegistry.read", () => {
  it("returns matches after creation, oldest first, capped at 50", () => {
    const { registry, push } = setup();
    push("jo@acme.com");
    const watch = registry.add(jo);
    for (let i = 0; i < 60; i++) push("jo@acme.com");
    const got = registry.read(watch.id);
    expect(got?.messages).toHaveLength(50);
    expect(got?.messages[0]?.cursor).toBe(2);
    expect(got?.more).toBe(true);
    expect(got?.cursor).toBe(got?.messages.at(-1)?.cursor);
    const rest = registry.read(watch.id, got?.cursor);
    expect(rest?.messages).toHaveLength(10);
    expect(rest?.more).toBe(false);
  });

  it("stops a scan at 1000 rows and resumes from the last one scanned", () => {
    const { registry, push } = setup();
    const watch = registry.add(jo);
    push("jo@acme.com");
    for (let i = 0; i < 1198; i++) push("noise@x.com");
    push("jo@acme.com");
    const got = registry.read(watch.id);
    expect(got?.messages).toHaveLength(1);
    expect(got?.more).toBe(true);
    expect(got?.cursor).toBe(1000);
    const rest = registry.read(watch.id, got?.cursor);
    expect(rest?.messages).toHaveLength(1);
    expect(rest?.more).toBe(false);
  });

  it("returns null for an unknown id", () => {
    const { registry } = setup();
    expect(registry.read("w_nope")).toBeNull();
  });
});

describe("WatchRegistry trigger", () => {
  it("starts on the first add and stops on the last remove", () => {
    const stop = vi.fn();
    const startTrigger = vi.fn(() => ({ stop }));
    const store = makeSource();
    const registry = new WatchRegistry({
      surface: "mail",
      source: store.source,
      onUpdate: vi.fn(),
      startTrigger,
      mintId: ids(),
    });
    expect(startTrigger).not.toHaveBeenCalled();
    const a = registry.add(jo);
    const b = registry.add(zed);
    expect(startTrigger).toHaveBeenCalledTimes(1);
    registry.remove(a.id);
    expect(stop).not.toHaveBeenCalled();
    expect(registry.remove(b.id)).toBe(true);
    expect(registry.size).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.remove(b.id)).toBe(false);
  });

  it("ticks when the trigger fires", () => {
    const store = makeSource();
    const onUpdate = vi.fn();
    let fire: (() => void) | undefined;
    const registry = new WatchRegistry({
      surface: "mail",
      source: store.source,
      onUpdate,
      startTrigger: (onChange) => {
        fire = onChange;
        return { stop() {} };
      },
    });
    registry.add(jo);
    store.push("jo@acme.com");
    fire?.();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
