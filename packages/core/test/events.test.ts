import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PreconditionError } from "../src/errors.js";
import {
  decodeCursor,
  encodeCursor,
  isoMs,
  occurrenceTimestamp,
  parseSenderArgs,
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

  it("never drops an undated row for maxAge: it has no time to compare", () => {
    const rows = [row(1, { at: 1000 }), row(2), row(3, { at: 3000 })];
    const floored = scanEvents(adapterOf(rows), filter, 0, { ...opts, floorMs: 2500 });
    expect(floored.rows.map((r) => r.cursor)).toEqual([2, 3]);
    expect(floored.truncated).toBe(true);
  });
});

describe("parseSenderArgs", () => {
  const Args = z.object({
    from: z.array(z.string().min(1)).optional(),
    domains: z.array(z.string().min(1)).optional(),
    where: z.array(z.string()).optional(),
  });
  type A = z.infer<typeof Args>;

  const steps = (over: { open?: (a: A) => Promise<void>; resolve?: (a: A) => unknown } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      open: async (a: A) => {
        calls.push("open");
        await over.open?.(a);
      },
      resolve: async (a: A) => {
        calls.push("resolve");
        return (over.resolve?.(a) ?? {
          ...(a.from ? { from: a.from } : {}),
          ...(a.domains ? { domains: a.domains } : {}),
          ...(a.where ? { scope: a.where } : {}),
        }) as { from?: string[]; domains?: string[]; scope?: string[] };
      },
    };
  };

  it("returns the normalised filter, after opening and resolving", async () => {
    const s = steps();
    await expect(
      parseSenderArgs("x.y", Args, { from: [" Jo@Acme.com "], where: ["1"] }, s),
    ).resolves.toEqual({ from: ["jo@acme.com"], domains: [], scope: ["1"] });
    expect(s.calls).toEqual(["open", "resolve"]);
  });

  it("refuses a malformed argument or an empty sender with -32602, before opening", async () => {
    const s = steps();
    await expect(parseSenderArgs("x.y", Args, { from: "jo" }, s)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Invalid arguments for x.y:"),
    });
    for (const args of [undefined, {}, { from: [] }, { where: ["1"] }]) {
      await expect(parseSenderArgs("x.y", Args, args, s)).rejects.toMatchObject({
        code: -32602,
        message: "A subscription needs a sender: give at least one entry in `from` or `domains`.",
      });
    }
    expect(s.calls).toEqual([]);
  });

  it("passes a failure to open through untouched: it is not the client's mistake", async () => {
    const closed = new PreconditionError("The store cannot be read.");
    const s = steps({
      open: async () => {
        throw closed;
      },
    });
    await expect(parseSenderArgs("x.y", Args, { from: ["jo@acme.com"] }, s)).rejects.toBe(closed);
    expect(s.calls).toEqual(["open"]);
  });

  it("makes a refusal while resolving the client's mistake: -32602", async () => {
    const unknown = steps({
      resolve: () => {
        throw new PreconditionError('No mailbox named "Nowhere".');
      },
    });
    await expect(
      parseSenderArgs("x.y", Args, { from: ["jo@acme.com"] }, unknown),
    ).rejects.toMatchObject({ code: -32602, message: 'No mailbox named "Nowhere".' });
    const tooMany = steps({
      resolve: () => ({ from: ["jo@acme.com"], scope: [...Array(51).keys()].map(String) }),
    });
    await expect(
      parseSenderArgs("x.y", Args, { from: ["jo@acme.com"] }, tooMany),
    ).rejects.toMatchObject({
      code: -32602,
      message: "A subscription takes at most 50 scope keys.",
    });
  });
});

describe("occurrence times", () => {
  it("isoMs reads an ISO date, and is null for none or garbage", () => {
    expect(isoMs("2026-10-27T10:00:00.000Z")).toBe(Date.parse("2026-10-27T10:00:00.000Z"));
    expect(isoMs(null)).toBeNull();
    expect(isoMs("not a date")).toBeNull();
  });

  it("occurrenceTimestamp is the row's date, or the scan time for an undated row, never empty", () => {
    expect(occurrenceTimestamp("2026-10-27T10:00:00.000Z")).toBe("2026-10-27T10:00:00.000Z");
    const at = Date.parse("2026-10-27T11:22:33.000Z");
    expect(occurrenceTimestamp(null, () => at)).toBe("2026-10-27T11:22:33.000Z");
    const before = Date.now();
    const scanned = Date.parse(occurrenceTimestamp(null));
    expect(scanned).toBeGreaterThanOrEqual(before);
    expect(scanned).toBeLessThanOrEqual(Date.now());
  });
});
