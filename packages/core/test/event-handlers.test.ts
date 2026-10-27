import {
  createMcpHandler,
  McpServer,
  ProtocolError as SdkProtocolError,
  ProtocolErrorCode,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Era } from "../src/cli.js";
import { readFailure, registerEvents, type EventsOptions } from "../src/event-handlers.js";
import { encodeCursor, EVENTS_EXTENSION_ID, type EventTypeAdapter } from "../src/events.js";
import { normalizeFilter, type ArrivalRow, type ArrivalSource } from "../src/watches.js";

type Row = ArrivalRow & { at: number };

const id = { dev: 1, ino: 2 };

/** A store whose rows the test appends to, as `watch-resources.test.ts` does. */
const fakeSource = () => {
  const rows: Row[] = [];
  let failure: Error | null = null;
  const source: ArrivalSource<Row> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => {
      if (failure !== null) throw failure;
      return rows.filter((r) => r.cursor > after).slice(0, limit);
    },
  };
  return {
    source,
    arrive: (cursor: number, sender = "jo@acme.com") =>
      rows.push({ cursor, key: `g${cursor}`, sender, at: BASE + cursor * 1000 }),
    fail: (err: Error | null) => {
      failure = err;
    },
  };
};

const BASE = 1_700_000_000_000;

const adapterOf = (
  store: ReturnType<typeof fakeSource>,
  calls: string[],
  overrides: Partial<EventTypeAdapter<Row>> = {},
) => {
  const adapter: EventTypeAdapter<Row> = {
    descriptor: {
      name: "test.received",
      description: "A test event.",
      delivery: ["poll", "push"],
      inputSchema: { type: "object", anyOf: [{ required: ["from"] }, { required: ["domains"] }] },
      payloadSchema: { type: "object" },
    },
    parseArguments: async (args) => {
      const parsed = z.object({ domains: z.array(z.string()).min(1) }).safeParse(args);
      if (!parsed.success) {
        throw new SdkProtocolError(ProtocolErrorCode.InvalidParams, "domains is required");
      }
      return normalizeFilter({ domains: parsed.data.domains });
    },
    occurrence: (row) => ({
      eventId: row.key,
      timestamp: new Date(row.at).toISOString(),
      data: { sender: row.sender },
    }),
    timestampMs: (row) => row.at,
    source: store.source,
    ensure: async () => {
      calls.push("ensure");
    },
    identity: () => {
      calls.push("identity");
      return id;
    },
    startTrigger: () => ({ stop: () => {} }),
    ...overrides,
  };
  return adapter;
};

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

type Reply = { result?: Record<string, unknown>; error?: { code: number; data?: unknown } };

/**
 * Each request is served by a fresh instance from the factory, as
 * `createMcpHandler` does, with the era its envelope selects: a request carrying
 * the 2026-07-28 `_meta` envelope is modern, one without it is legacy. The
 * store is shared, so rows appended between requests are seen by the next one.
 */
const setup = (
  overrides: Partial<EventTypeAdapter<Row>> = {},
  extra: Partial<EventsOptions> = {},
) => {
  const store = fakeSource();
  const calls: string[] = [];
  const eras: Era[] = [];
  const handler = createMcpHandler(({ era }) => {
    eras.push(era);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerEvents(server, { era, adapters: [adapterOf(store, calls, overrides)], ...extra });
    return server;
  });
  let n = 0;
  const send = async (
    method: string,
    params: Record<string, unknown>,
    modern: boolean,
  ): Promise<Reply> => {
    const body = {
      jsonrpc: "2.0",
      id: ++n,
      method,
      params: modern ? { ...params, _meta: ENVELOPE } : params,
    };
    const res = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(modern ? { "mcp-protocol-version": "2026-07-28", "mcp-method": method } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    // The legacy leg answers as a one-message SSE stream, the modern one as JSON.
    const text = await res.text();
    const data = text.startsWith("event:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
      : text;
    return JSON.parse(data ?? "null") as Reply;
  };
  /** The result of a modern request, or a rejection carrying the JSON-RPC error. */
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await send(method, params, true);
    if (res.error !== undefined) throw Object.assign(new Error("rpc error"), res.error);
    return res.result ?? {};
  };
  return { store, calls, eras, call, send };
};

const acme = { name: "test.received", arguments: { domains: ["acme.com"] } };

describe("registerEvents", () => {
  it("declares the extension on modern", async () => {
    const { call } = setup();
    const discovered = await call("server/discover");
    const caps = discovered.capabilities as { extensions?: Record<string, unknown> };
    expect(caps.extensions?.[EVENTS_EXTENSION_ID]).toEqual({});
  });

  it("legacy era: nothing declared, events/list is -32601", async () => {
    const { send, eras } = setup();
    const res = await send("events/list", {}, false);
    expect(eras).toEqual(["legacy"]);
    expect(res.error?.code).toBe(-32601);
  });

  it("events/list returns the descriptor", async () => {
    const { call } = setup();
    const res = await call("events/list");
    const events = res.events as { name: string; delivery: string[] }[];
    expect(events[0]?.name).toBe("test.received");
    expect(events[0]?.delivery).toEqual(["poll", "push"]);
    expect(res.resultType).toBe("complete");
    expect(res).not.toHaveProperty("nextCursor");
  });

  it("poll with null cursor bootstraps", async () => {
    const { call, store, calls } = setup();
    store.arrive(7);
    const res = await call("events/poll", { ...acme, cursor: null });
    expect(res).toMatchObject({
      events: [],
      cursor: encodeCursor(id, 7),
      truncated: false,
      hasMore: false,
      nextPollMs: 10000,
      resultType: "complete",
    });
    expect(calls[0]).toBe("ensure");
  });

  it("poll resumes and maps occurrences", async () => {
    const { call, store } = setup();
    store.arrive(7);
    const boot = await call("events/poll", { ...acme, cursor: null });
    store.arrive(8);
    store.arrive(9);
    const res = await call("events/poll", { ...acme, cursor: boot.cursor });
    const events = res.events as Record<string, unknown>[];
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      eventId: "g8",
      name: "test.received",
      timestamp: new Date(1_700_000_008_000).toISOString(),
      data: { sender: "jo@acme.com" },
    });
    expect(res.cursor).toBe(encodeCursor(id, 9));
  });

  it("poll unknown name is -32023 with data.kind event", async () => {
    const { call } = setup();
    await expect(
      call("events/poll", { name: "nope.received", arguments: {} }),
    ).rejects.toMatchObject({ code: -32023, data: { kind: "event" } });
  });

  it("poll invalid arguments is -32602", async () => {
    const { call } = setup();
    await expect(
      call("events/poll", { name: "test.received", arguments: {} }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("poll caps maxEvents at 50", async () => {
    const { call, store } = setup();
    const boot = await call("events/poll", { ...acme, cursor: null });
    for (let i = 1; i <= 60; i++) store.arrive(i);
    const res = await call("events/poll", { ...acme, cursor: boot.cursor, maxEvents: 100 });
    expect(res.events).toHaveLength(50);
    expect(res.hasMore).toBe(true);
  });

  it("poll clamps maxEvents of 0 up to 1", async () => {
    const { call, store } = setup();
    const boot = await call("events/poll", { ...acme, cursor: null });
    store.arrive(1);
    store.arrive(2);
    const res = await call("events/poll", { ...acme, cursor: boot.cursor, maxEvents: 0 });
    expect(res.events).toHaveLength(1);
    expect(res.hasMore).toBe(true);
  });
});

describe("events/poll: cursors that cannot be resumed", () => {
  it("a cursor from another store resets to head with truncated, not an error", async () => {
    const { call, store } = setup();
    for (let i = 1; i <= 5; i++) store.arrive(i);
    const res = await call("events/poll", { ...acme, cursor: encodeCursor({ dev: 9, ino: 9 }, 3) });
    expect(res).toMatchObject({ events: [], cursor: encodeCursor(id, 5), truncated: true });
  });

  it("a cursor above head resets to head with truncated", async () => {
    const { call, store } = setup();
    for (let i = 1; i <= 5; i++) store.arrive(i);
    const res = await call("events/poll", { ...acme, cursor: encodeCursor(id, 99) });
    expect(res).toMatchObject({ events: [], cursor: encodeCursor(id, 5), truncated: true });
  });

  it("a malformed cursor is -32602", async () => {
    const { call } = setup();
    await expect(call("events/poll", { ...acme, cursor: "garbage" })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("an unreadable store (identity null) resets with truncated and keeps the client's cursor", async () => {
    const { call, store } = setup({ identity: () => null });
    store.arrive(1);
    const cursor = encodeCursor(id, 1);
    const res = await call("events/poll", { ...acme, cursor });
    expect(res).toMatchObject({ events: [], cursor, truncated: true });
    const boot = await call("events/poll", { ...acme, cursor: null });
    expect(boot).toMatchObject({ events: [], cursor: null, truncated: false });
  });
});

describe("events/poll: failures", () => {
  it("a ProtocolError from parseArguments or ensure passes through unchanged", async () => {
    const boom = new SdkProtocolError(-32602, "bad thing", { x: 1 });
    const { call: viaEnsure } = setup({
      ensure: async () => {
        throw boom;
      },
    });
    await expect(viaEnsure("events/poll", acme)).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("bad thing"),
      data: { x: 1 },
    });
    const { call: viaArgs } = setup();
    await expect(viaArgs("events/poll", { name: acme.name, arguments: {} })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("domains is required"),
    });
  });

  it("a plain Error from the source becomes -32603 naming the event", async () => {
    const { call, store } = setup();
    store.arrive(1);
    const boot = await call("events/poll", { ...acme, cursor: null });
    store.fail(new Error("database is locked"));
    await expect(call("events/poll", { ...acme, cursor: boot.cursor })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("Could not read test.received events: database is locked"),
    });
  });

  it("a plain Error from ensure becomes -32603 too", async () => {
    const { call } = setup({
      ensure: async () => {
        throw new Error("index not loaded");
      },
    });
    await expect(call("events/poll", acme)).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("Could not read test.received events: index not loaded"),
    });
  });

  it("readFailure keeps a ProtocolError and wraps anything else", () => {
    const own = new SdkProtocolError(-32602, "mine");
    expect(readFailure("x.y", own)).toBe(own);
    expect(readFailure("x.y", "oops").message).toContain("Could not read x.y events: oops");
  });
});

describe("events/poll: maxAgeMs", () => {
  const NOW = BASE + 4500;

  it("with a cursor, skips matches older than now - maxAgeMs and says truncated", async () => {
    const { call, store } = setup({}, { now: () => NOW });
    for (let i = 1; i <= 4; i++) store.arrive(i);
    const res = await call("events/poll", {
      ...acme,
      cursor: encodeCursor(id, 0),
      maxAgeMs: 2000,
    });
    expect((res.events as { eventId: string }[]).map((e) => e.eventId)).toEqual(["g3", "g4"]);
    expect(res.truncated).toBe(true);
  });

  it("keeps an undated row however small maxAgeMs is", async () => {
    const { call, store } = setup(
      { timestampMs: (row) => (row.cursor === 2 ? null : row.at) },
      { now: () => NOW },
    );
    for (let i = 1; i <= 4; i++) store.arrive(i);
    const res = await call("events/poll", { ...acme, cursor: encodeCursor(id, 0), maxAgeMs: 0 });
    expect((res.events as { eventId: string }[]).map((e) => e.eventId)).toEqual(["g2"]);
    expect(res.truncated).toBe(true);
  });

  it("with a null cursor, ignores maxAgeMs", async () => {
    const { call, store } = setup({}, { now: () => NOW });
    for (let i = 1; i <= 4; i++) store.arrive(i);
    const res = await call("events/poll", { ...acme, cursor: null, maxAgeMs: 0 });
    expect(res).toMatchObject({ events: [], cursor: encodeCursor(id, 4), truncated: false });
  });

  it("refuses a negative or fractional maxAgeMs with -32602", async () => {
    const { call } = setup();
    for (const maxAgeMs of [-1, 1.5]) {
      await expect(call("events/poll", { ...acme, maxAgeMs })).rejects.toMatchObject({
        code: -32602,
      });
    }
  });
});

describe("registerEvents: registration", () => {
  it("throws when two adapters share a name", () => {
    const store = fakeSource();
    const server = new McpServer({ name: "test", version: "0.0.0" });
    expect(() =>
      registerEvents(server, {
        era: "modern",
        adapters: [adapterOf(store, []), adapterOf(store, [])],
      }),
    ).toThrow(/test\.received/);
  });
});

// --------------------------------------------------------------- stream ---

const SUB = "io.modelcontextprotocol/subscriptionId";

type Frame = {
  method: string;
  params: Record<string, unknown> & { _meta?: Record<string, unknown> };
};

/** Let queued I/O and every microtask behind it run, a few turns of the loop over. */
const settle = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((done) => setImmediate(done));
};

/**
 * `events/stream` is served over `serveStdio` with an in-memory transport, not
 * through `createMcpHandler` as the poll tests are. A stream belongs to a
 * connection: its cap of 10, its shared trigger and its cancel by
 * `notifications/cancelled` exist only when one server instance is pinned for
 * the connection, which is what `serveStdio` does. `createMcpHandler` builds a
 * fresh instance per HTTP request, so ten streams there would never meet, and
 * its cancel is an aborted request rather than a notification. The transport
 * here is the stdio wire without the bytes: the test writes JSON-RPC messages
 * in and reads back what the server sent.
 */
const streamSetup = (
  overrides: Partial<EventTypeAdapter<Row>> = {},
  extra: Partial<EventsOptions> = {},
) => {
  const store = fakeSource();
  const calls: string[] = [];
  const sent: JSONRPCMessage[] = [];
  const triggers = {
    started: 0,
    stopped: 0,
    onChange: undefined as (() => void) | undefined,
  };
  const closers: { close(): void }[] = [];
  const transport: Transport = {
    start: async () => {},
    send: async (message) => {
      sent.push(message);
    },
    close: async () => {
      transport.onclose?.();
    },
  };
  const adapter = adapterOf(store, calls, {
    startTrigger: (onChange) => {
      triggers.started += 1;
      triggers.onChange = onChange;
      return {
        stop: () => {
          triggers.stopped += 1;
        },
      };
    },
    ...overrides,
  });
  const handle = serveStdio(
    ({ era }) => {
      const server = new McpServer({ name: "test", version: "0.0.0" });
      closers.push(registerEvents(server, { era, adapters: [adapter], ...extra }));
      return server;
    },
    { transport },
  );
  const write = (msg: Record<string, unknown>) =>
    transport.onmessage?.({ jsonrpc: "2.0", ...msg } as JSONRPCMessage);
  const open = (reqId: string | number, params: Record<string, unknown> = acme) =>
    write({ id: reqId, method: "events/stream", params: { ...params, _meta: ENVELOPE } });
  const cancel = (reqId: string | number) =>
    write({
      method: "notifications/cancelled",
      params: { requestId: reqId, reason: "test done", _meta: ENVELOPE },
    });
  const framesFor = (reqId: string | number): Frame[] =>
    sent
      .filter((m) => "method" in m && !("id" in m))
      .map((m) => m as unknown as Frame)
      .filter((m) => {
        // Destructured: the repo's lint rejects `._meta` member access.
        const { _meta: tags } = m.params;
        return m.method.startsWith("notifications/events/") && tags?.[SUB] === reqId;
      });
  const responseFor = (reqId: string | number) =>
    sent.find((m) => "id" in m && m.id === reqId && ("result" in m || "error" in m)) as
      | { result?: Record<string, unknown>; error?: { code: number; data?: unknown } }
      | undefined;
  /** Waits, on real turns of the event loop, until `pred` holds. */
  const until = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await settle(1);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const opened = async (reqId: string | number, params?: Record<string, unknown>) => {
    open(reqId, params);
    await until(
      () => framesFor(reqId).some((f) => f.method === "notifications/events/active"),
      `active on ${String(reqId)}`,
    );
  };
  const fire = async () => {
    triggers.onChange?.();
    await settle();
  };
  const shutdown = async () => {
    for (const c of closers) c.close();
    await handle.close();
  };
  return {
    store,
    calls,
    sent,
    triggers,
    open,
    opened,
    cancel,
    framesFor,
    responseFor,
    until,
    fire,
    closers,
    shutdown,
  };
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("events/stream", () => {
  let teardown: (() => Promise<void>) | undefined;
  const stream = (...args: Parameters<typeof streamSetup>) => {
    const s = streamSetup(...args);
    teardown = s.shutdown;
    return s;
  };
  afterEach(async () => {
    vi.useRealTimers();
    await teardown?.();
    teardown = undefined;
  });

  it("stream sends active first", async () => {
    const { store, opened, framesFor, responseFor, calls } = stream();
    store.arrive(7);
    await opened(1);
    const [first] = framesFor(1);
    expect(first).toEqual({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { cursor: encodeCursor(id, 7), truncated: false, _meta: { [SUB]: 1 } },
    });
    expect(responseFor(1)).toBeUndefined();
    expect(calls[0]).toBe("ensure");
  });

  it("stream delivers on trigger", async () => {
    const { store, opened, framesFor, fire } = stream();
    store.arrive(7);
    await opened(1);
    store.arrive(8);
    store.arrive(9, "eve@elsewhere.org");
    await fire();
    const events = framesFor(1).filter((f) => f.method === "notifications/events/event");
    expect(events).toHaveLength(1);
    expect(events[0]?.params).toEqual({
      eventId: "g8",
      name: "test.received",
      timestamp: new Date(BASE + 8000).toISOString(),
      data: { sender: "jo@acme.com" },
      cursor: encodeCursor(id, 8),
      _meta: { [SUB]: 1 },
    });
  });

  it("stream delivers the backlog after a resumed cursor, after active", async () => {
    const { store, opened, framesFor } = stream();
    for (let i = 1; i <= 3; i++) store.arrive(i);
    await opened("s", { ...acme, cursor: encodeCursor(id, 1) });
    await settle();
    const frames = framesFor("s");
    expect(frames.map((f) => f.method)).toEqual([
      "notifications/events/active",
      "notifications/events/event",
      "notifications/events/event",
    ]);
    expect(frames[0]?.params).toMatchObject({ cursor: encodeCursor(id, 1), truncated: false });
    expect(frames.slice(1).map((f) => f.params.eventId)).toEqual(["g2", "g3"]);
  });

  it("stream applies maxAgeMs to a resumed cursor and says truncated on active", async () => {
    const { store, opened, framesFor } = stream({}, { now: () => BASE + 4500 });
    for (let i = 1; i <= 4; i++) store.arrive(i);
    await opened(1, { ...acme, cursor: encodeCursor(id, 0), maxAgeMs: 2000 });
    await settle();
    const frames = framesFor(1);
    expect(frames[0]?.params).toMatchObject({ truncated: true });
    expect(frames.slice(1).map((f) => f.params.eventId)).toEqual(["g3", "g4"]);
  });

  it("stream heartbeats with the scanned cursor", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { store, opened, framesFor, fire } = stream();
    store.arrive(7);
    await opened(1);
    store.arrive(8, "eve@elsewhere.org");
    await fire();
    vi.advanceTimersByTime(25_000);
    await settle();
    const beats = framesFor(1).filter((f) => f.method === "notifications/events/heartbeat");
    expect(beats).toHaveLength(1);
    expect(beats[0]?.params).toEqual({ cursor: encodeCursor(id, 8), _meta: { [SUB]: 1 } });
  });

  it("stream rebuild resets with truncated", async () => {
    let identity = id;
    const { store, opened, framesFor, fire, responseFor } = stream({ identity: () => identity });
    store.arrive(7);
    await opened(1);
    identity = { dev: 1, ino: 3 };
    store.arrive(8);
    await fire();
    const frames = framesFor(1);
    expect(frames.map((f) => f.method)).toEqual([
      "notifications/events/active",
      "notifications/events/active",
    ]);
    expect(frames[1]?.params).toMatchObject({
      cursor: encodeCursor({ dev: 1, ino: 3 }, 8),
      truncated: true,
    });
    // Still open: the next arrival is delivered under the new store's cursor.
    store.arrive(9);
    await fire();
    const last = framesFor(1).at(-1);
    expect(last?.method).toBe("notifications/events/event");
    expect(last?.params.cursor).toBe(encodeCursor({ dev: 1, ino: 3 }, 9));
    expect(responseFor(1)).toBeUndefined();
  });

  it("stream read failure is a recoverable error", async () => {
    const { store, opened, framesFor, fire } = stream();
    store.arrive(7);
    await opened(1);
    store.arrive(8);
    store.fail(new Error("database is locked"));
    await fire();
    const errors = framesFor(1).filter((f) => f.method === "notifications/events/error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.params).toMatchObject({
      error: {
        code: -32603,
        message: expect.stringContaining("Could not read test.received events: database is locked"),
      },
      _meta: { [SUB]: 1 },
    });
    store.fail(null);
    await fire();
    const events = framesFor(1).filter((f) => f.method === "notifications/events/event");
    expect(events.map((f) => f.params.eventId)).toEqual(["g8"]);
  });

  it("cancel stops delivery", async () => {
    const { store, opened, framesFor, fire, cancel, responseFor } = stream();
    await opened(1);
    const before = framesFor(1).length;
    cancel(1);
    await settle();
    store.arrive(1);
    await fire();
    expect(framesFor(1)).toHaveLength(before);
    // The SDK writes no response for a cancelled request.
    expect(responseFor(1)).toBeUndefined();
  });

  it("cancel matches a string id and leaves other streams alone", async () => {
    const { store, opened, framesFor, fire, cancel } = stream();
    await opened("a");
    await opened(2);
    cancel("a");
    await settle();
    store.arrive(1);
    await fire();
    expect(framesFor("a").map((f) => f.method)).toEqual(["notifications/events/active"]);
    expect(framesFor(2).at(-1)?.method).toBe("notifications/events/event");
  });

  it("cancel mid-scan writes nothing after", async () => {
    let cancelInScan: (() => void) | undefined;
    const rows = fakeSource();
    const s = stream({
      source: {
        head: rows.source.head,
        since: (after, limit) => {
          cancelInScan?.();
          return rows.source.since(after, limit);
        },
      },
    });
    rows.arrive(7);
    await s.opened(1);
    cancelInScan = () => {
      cancelInScan = undefined;
      s.cancel(1);
    };
    rows.arrive(8);
    await s.fire();
    expect(s.framesFor(1).map((f) => f.method)).toEqual(["notifications/events/active"]);
  });

  it("eleventh stream is refused", async () => {
    const { opened, open, until, responseFor, framesFor, cancel } = stream();
    for (const i of ids(10)) await opened(i);
    open(11);
    await until(() => responseFor(11) !== undefined, "a reply to the 11th");
    expect(responseFor(11)?.error).toMatchObject({
      code: -32025,
      data: { limit: "streams", max: 10 },
    });
    expect(framesFor(11)).toEqual([]);
    // A cancelled stream frees its slot.
    cancel(3);
    await settle();
    await opened(12);
  });

  it("eleven opened at once: exactly one is refused", async () => {
    const { open, until, responseFor, framesFor } = stream();
    for (const i of ids(11)) open(i);
    await until(
      () => ids(11).every((i) => responseFor(i) !== undefined || framesFor(i).length > 0),
      "every stream to open or be refused",
    );
    const refused = ids(11).filter((i) => responseFor(i)?.error?.code === -32025);
    expect(refused).toHaveLength(1);
  });

  it("poll-only descriptor refuses stream", async () => {
    const pollOnly = adapterOf(fakeSource(), []).descriptor;
    const { open, until, responseFor } = stream({
      descriptor: { ...pollOnly, delivery: ["poll"] },
    });
    open(1);
    await until(() => responseFor(1) !== undefined, "a reply");
    expect(responseFor(1)?.error).toMatchObject({
      code: -32026,
      data: { feature: "deliveryMode", value: "push" },
    });
  });

  it("stream refuses an unknown name, bad arguments and a malformed cursor before opening", async () => {
    const { open, until, responseFor, framesFor, triggers } = stream();
    open(1, { name: "nope.received", arguments: {} });
    open(2, { name: "test.received", arguments: {} });
    open(3, { ...acme, cursor: "garbage" });
    await until(() => [1, 2, 3].every((i) => responseFor(i) !== undefined), "three replies");
    expect(responseFor(1)?.error).toMatchObject({ code: -32023, data: { kind: "event" } });
    expect(responseFor(2)?.error?.code).toBe(-32602);
    expect(responseFor(3)?.error?.code).toBe(-32602);
    expect([1, 2, 3].flatMap((i) => framesFor(i))).toEqual([]);
    expect(triggers.started).toBe(0);
  });

  it("one trigger per adapter: started with the first stream, stopped with the last", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { opened, cancel, triggers } = stream();
    await opened(1);
    await opened(2);
    expect(triggers.started).toBe(1);
    cancel(1);
    await settle();
    expect(triggers.stopped).toBe(0);
    cancel(2);
    await settle();
    expect(triggers.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await opened(3);
    expect(triggers.started).toBe(2);
  });

  it("close() ends every stream, its heartbeat and the trigger", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { opened, closers, triggers, store, fire, framesFor } = stream();
    await opened(1);
    await opened("two");
    expect(vi.getTimerCount()).toBe(2);
    for (const c of closers) c.close();
    expect(triggers.stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const before = framesFor(1).length + framesFor("two").length;
    store.arrive(1);
    await fire();
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(framesFor(1).length + framesFor("two").length).toBe(before);
  });
});
