import { EventEmitter } from "node:events";
import type { watch as fsWatch } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PreconditionError } from "../src/errors.js";
import {
  fileTrigger,
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

const setup = () => {
  const store = makeSource();
  const onUpdate = vi.fn();
  const registry = new WatchRegistry({
    surface: "mail",
    source: store.source,
    onUpdate,
    mintId: ids(),
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
    const { registry, push, onUpdate } = setup();
    registry.add(jo);
    push("jo@acme.com", { excluded: true });
    registry.tick();
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
    push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("resets without notifying when the store was rebuilt with lower cursors", () => {
    const { registry, push, rows, onUpdate } = setup();
    for (let i = 0; i < 10; i++) push("noise@x.com");
    registry.add(jo);
    rows.length = 0;
    for (let i = 0; i < 3; i++) push("jo@acme.com");
    registry.tick();
    expect(onUpdate).not.toHaveBeenCalled();
    push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("fires once for a match in the second scan batch", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(jo);
    for (let i = 0; i < 1200; i++) push("noise@x.com");
    push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("scans at most 10 batches per tick, and the next ticks finish the backlog", () => {
    const store = makeSource();
    const onUpdate = vi.fn();
    const since = vi.spyOn(store.source, "since");
    const registry = new WatchRegistry({
      surface: "mail",
      source: store.source,
      onUpdate,
      scanLimit: 10,
      mintId: ids(),
    });
    const a = registry.add(jo);
    // 250 rows is 25 batches of 10, with a match in the first, second and third tick's share.
    for (let i = 1; i <= 250; i++) store.push([50, 150, 240].includes(i) ? "jo@acme.com" : "x@y.z");

    registry.tick();
    expect(since).toHaveBeenCalledTimes(10);
    expect(since.mock.calls.at(-1)?.[0]).toBe(90);
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(a.uri);

    since.mockClear();
    registry.tick();
    // It resumes where the first stopped, not from the start.
    expect(since.mock.calls[0]?.[0]).toBe(100);
    expect(since).toHaveBeenCalledTimes(10);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    since.mockClear();
    registry.tick();
    expect(since.mock.calls[0]?.[0]).toBe(200);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(3);
  });

  it("fires from an empty store", () => {
    const { registry, push, onUpdate } = setup();
    const watch = registry.add(jo);
    expect(watch.createdAt).toBe(0);
    push("jo@acme.com");
    registry.tick();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(registry.read(watch.id)?.messages).toHaveLength(1);
  });

  it("keeps notifying the other watches when a listener throws", () => {
    const { registry, push, onUpdate } = setup();
    registry.add(jo);
    const b = registry.add(jo);
    onUpdate.mockImplementationOnce(() => {
      throw new Error("listener");
    });
    push("jo@acme.com");
    expect(() => registry.tick()).not.toThrow();
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenLastCalledWith(b.uri);
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

  it("leaves excluded rows out", () => {
    const { registry, push } = setup();
    const watch = registry.add(jo);
    push("jo@acme.com", { excluded: true });
    push("jo@acme.com");
    const got = registry.read(watch.id);
    expect(got?.messages.map((m) => m.cursor)).toEqual([2]);
    expect(got?.cursor).toBe(2);
  });

  it("never pages before the watch began, whatever `after` says", () => {
    const { registry, push } = setup();
    for (let i = 0; i < 3; i++) push("jo@acme.com");
    const watch = registry.add(jo);
    expect(registry.read(watch.id, 0)?.messages).toEqual([]);
    expect(registry.read(watch.id, 0)?.cursor).toBe(3);
    push("jo@acme.com");
    push("jo@acme.com");
    for (const after of [0, 1, 3]) {
      expect(registry.read(watch.id, after)?.messages.map((m) => m.cursor)).toEqual([4, 5]);
    }
    expect(registry.read(watch.id, 4)?.messages.map((m) => m.cursor)).toEqual([5]);
  });

  it("names the watch by its id", () => {
    const { registry } = setup();
    const watch = registry.add(jo);
    expect(registry.read(watch.id)?.watch).toBe(watch.id);
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

  it("stops the trigger on close", () => {
    const stop = vi.fn();
    const store = makeSource();
    const registry = new WatchRegistry({
      surface: "mail",
      source: store.source,
      onUpdate: vi.fn(),
      startTrigger: () => ({ stop }),
    });
    registry.add(jo);
    registry.close();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
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

type FakeWatcher = EventEmitter & { path: string; close: ReturnType<typeof vi.fn> };

/** A `fs.watch` stand-in that serves directory and file watchers alike. */
const makeFakeWatch = (opts: { throws?: Error; missing?: Set<string> } = {}) => {
  const watchers: FakeWatcher[] = [];
  const watch = vi.fn((path: string, _options?: { persistent?: boolean }) => {
    if (opts.throws) throw opts.throws;
    if (opts.missing?.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const w = Object.assign(new EventEmitter(), { path, close: vi.fn() }) as FakeWatcher;
    watchers.push(w);
    return w;
  });
  return {
    watch: watch as unknown as typeof fsWatch,
    spy: watch,
    watchers,
    at: (path: string) => watchers.filter((w) => w.path === path).at(-1)!,
  };
};

describe("fileTrigger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const base = { dir: "/s", names: ["chat.db", "chat.db-wal"] };

  it("debounces a burst on the -wal file into one call 500 ms after the last event", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch })(onChange);
    const wal = fake.at("/s/chat.db-wal");
    for (let i = 0; i < 5; i++) {
      wal.emit("change", "change", "chat.db-wal");
      if (i < 4) vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(499);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("fires 3 s after the first event of a burst that never goes quiet", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch })(onChange);
    const wal = fake.at("/s/chat.db-wal");
    // A long sync: an event every 100 ms for 7 s, never 500 ms of quiet.
    const at: number[] = [];
    onChange.mockImplementation(() => at.push(Date.now() - start));
    const start = Date.now();
    for (let t = 0; t < 7000; t += 100) {
      wal.emit("change", "change", "chat.db-wal");
      vi.advanceTimersByTime(100);
    }
    expect(at).toEqual([3000, 6000]);
    // The burst ends: the debounce fires once more, 500 ms after the last event.
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("watches the directory and each named file, non-persistent", () => {
    const fake = makeFakeWatch();
    fileTrigger({ ...base, watch: fake.watch })(() => {});
    expect(fake.spy.mock.calls.map((c) => c[0])).toEqual(["/s", "/s/chat.db", "/s/chat.db-wal"]);
    for (const call of fake.spy.mock.calls) expect(call[1]).toEqual({ persistent: false });
  });

  it("ignores -shm and other names on the directory watcher", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    fileTrigger({ ...base, pollMs: 10_000_000, watch: fake.watch })(onChange);
    const before = fake.spy.mock.calls.length;
    fake.at("/s").emit("change", "rename", "chat.db-shm");
    fake.at("/s").emit("change", "change", "other.txt");
    vi.advanceTimersByTime(5000);
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.spy.mock.calls.length).toBe(before);
  });

  it("polls at 60 s and again at 120 s with no events", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch })(onChange);
    vi.advanceTimersByTime(59_999);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("logs a throwing watch once and still polls", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch({ throws: new Error("EACCES") });
    const warn = vi.fn();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch, logger: { warn } })(onChange);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stop closes every watcher, clears both timers, and nothing fires after", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    const t = fileTrigger({ ...base, watch: fake.watch })(onChange);
    fake.at("/s/chat.db-wal").emit("change", "change", "chat.db-wal");
    t.stop();
    for (const w of fake.watchers) expect(w.close).toHaveBeenCalled();
    vi.advanceTimersByTime(300_000);
    expect(onChange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms a file watcher when the directory reports its rename", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch })(onChange);
    const old = fake.at("/s/chat.db-wal");
    fake.at("/s").emit("change", "rename", "chat.db-wal");
    expect(old.close).toHaveBeenCalledTimes(1);
    const fresh = fake.at("/s/chat.db-wal");
    expect(fresh).not.toBe(old);
    fresh.emit("change", "change", "chat.db-wal");
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("survives onChange throwing, warns once until a call succeeds, and keeps polling", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    const warn = vi.fn();
    let fail = true;
    const onChange = vi.fn(() => {
      if (fail) throw new Error("SQLITE_BUSY");
    });
    fileTrigger({ ...base, watch: fake.watch, logger: { warn } })(onChange);
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    fake.at("/s/chat.db-wal").emit("change", "change", "chat.db-wal");
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    fail = false;
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(3);
    fail = true;
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("re-arms a file watcher that errored on the next poll", () => {
    vi.useFakeTimers();
    const fake = makeFakeWatch();
    fileTrigger({ ...base, watch: fake.watch })(() => {});
    const old = fake.at("/s/chat.db-wal");
    old.emit("error", new Error("boom"));
    expect(old.close).toHaveBeenCalled();
    expect(fake.at("/s/chat.db-wal")).toBe(old);
    vi.advanceTimersByTime(60_000);
    expect(fake.at("/s/chat.db-wal")).not.toBe(old);
  });

  it("closes on a removing rename, stays unarmed while missing, arms on the poll once back", () => {
    vi.useFakeTimers();
    const missing = new Set<string>();
    const fake = makeFakeWatch({ missing });
    fileTrigger({ ...base, watch: fake.watch })(() => {});
    const old = fake.at("/s/chat.db-wal");
    const created = fake.watchers.length;
    missing.add("/s/chat.db-wal");
    fake.at("/s").emit("change", "rename", "chat.db-wal");
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(fake.watchers.length).toBe(created);
    missing.clear();
    vi.advanceTimersByTime(60_000);
    expect(fake.watchers.length).toBe(created + 1);
    expect(fake.at("/s/chat.db-wal")).not.toBe(old);
    vi.advanceTimersByTime(60_000);
    expect(fake.watchers.length).toBe(created + 1);
  });

  it("arms a file missing at start once the directory reports it", () => {
    vi.useFakeTimers();
    const missing = new Set(["/s/chat.db-wal"]);
    const fake = makeFakeWatch({ missing });
    const warn = vi.fn();
    const onChange = vi.fn();
    fileTrigger({ ...base, watch: fake.watch, logger: { warn } })(onChange);
    expect(fake.watchers.some((w) => w.path === "/s/chat.db-wal")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    missing.clear();
    fake.at("/s").emit("change", "rename", "chat.db-wal");
    expect(fake.watchers.some((w) => w.path === "/s/chat.db-wal")).toBe(true);
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
