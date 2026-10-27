import { describe, expect, it } from "vitest";

import {
  decodeCursor,
  encodeCursor,
  resolveStart,
  scanEvents,
  type EventTypeAdapter,
} from "../src/events.js";
import type { ArrivalRow, ArrivalSource, WatchFilter } from "../src/watches.js";

type Row = ArrivalRow & { at?: number };

const id = { dev: 1, ino: 2 };
const filter: WatchFilter = { from: ["jo@acme.com"], domains: [] };

/** A fake store over an array, ordered by cursor, as `watches.test.ts` does. */
const adapterOf = (rows: Row[]): Pick<EventTypeAdapter<Row>, "source" | "timestampMs"> => {
  const source: ArrivalSource<Row> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => rows.filter((r) => r.cursor > after).slice(0, limit),
  };
  return { source, timestampMs: (r) => r.at ?? null };
};

const row = (cursor: number, extra: Partial<Row> = {}): Row => ({
  cursor,
  key: `k${cursor}`,
  sender: "jo@acme.com",
  ...extra,
});

const opts = { maxEvents: 50, scanLimit: 1000 };

describe("cursor codec", () => {
  it("encodeCursor then decodeCursor round-trips", () => {
    const cursor = encodeCursor({ dev: 1, ino: 2 }, 42);
    expect(cursor).toBe("v1.1-2.42");
    expect(decodeCursor(cursor)).toEqual({ store: { dev: 1, ino: 2 }, rowid: 42 });
  });

  it("decodeCursor refuses garbage", () => {
    for (const bad of ["x", "v2.1-2.3", "v1.1-2.-4", "v1.a-2.3"]) {
      expect(() => decodeCursor(bad), bad).toThrow(expect.objectContaining({ code: -32602 }));
    }
  });
});

describe("resolveStart", () => {
  it("null is now", () => {
    expect(resolveStart(null, id, 90)).toEqual({ from: 90, truncated: false });
  });

  it("a cursor from another store resets", () => {
    const cursor = encodeCursor({ dev: 9, ino: 9 }, 40);
    expect(resolveStart(cursor, id, 90)).toEqual({ from: 90, truncated: true });
  });

  it("a rowid above head resets", () => {
    expect(resolveStart(encodeCursor(id, 120), id, 90)).toEqual({ from: 90, truncated: true });
  });

  it("a valid cursor resumes", () => {
    expect(resolveStart(encodeCursor(id, 40), id, 90)).toEqual({ from: 40, truncated: false });
  });
});

describe("scanEvents", () => {
  it("skips excluded and unmatched rows, cursor is the last row examined", () => {
    const rows = [
      row(41),
      row(42, { excluded: true }),
      row(43, { sender: "x@other.com" }),
      row(44),
      row(45),
    ];
    const res = scanEvents(adapterOf(rows), filter, 40, opts);
    expect(res.rows.map((r) => r.cursor)).toEqual([41, 44, 45]);
    expect(res.cursor).toBe(45);
    expect(res.hasMore).toBe(false);
    expect(res.truncated).toBe(false);
  });

  it("stops at maxEvents with hasMore", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    const res = scanEvents(adapterOf(rows), filter, 0, { ...opts, maxEvents: 2 });
    expect(res.rows.map((r) => r.cursor)).toEqual([1, 2]);
    expect(res.cursor).toBe(2);
    expect(res.hasMore).toBe(true);
  });

  it("stops at scanLimit with hasMore", () => {
    const rows = [1, 2, 3].map((n) => row(n, { sender: "x@other.com" }));
    const res = scanEvents(adapterOf(rows), filter, 0, { ...opts, scanLimit: 2 });
    expect(res.rows).toEqual([]);
    expect(res.cursor).toBe(2);
    expect(res.hasMore).toBe(true);
  });

  it("floors by maxAge", () => {
    const rows = [row(1, { at: 1000 }), row(2, { at: 2000 }), row(3, { at: 3000 })];
    const floored = scanEvents(adapterOf(rows), filter, 0, { ...opts, floorMs: 2500 });
    expect(floored.rows.map((r) => r.cursor)).toEqual([3]);
    expect(floored.truncated).toBe(true);
    const all = scanEvents(adapterOf(rows), filter, 0, { ...opts, floorMs: 500 });
    expect(all.rows).toHaveLength(3);
    expect(all.truncated).toBe(false);
  });
});
