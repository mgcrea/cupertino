import {
  createMcpHandler,
  McpServer,
  ProtocolError as SdkProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Era } from "../src/cli.js";
import { registerEvents } from "../src/event-handlers.js";
import { encodeCursor, EVENTS_EXTENSION_ID, type EventTypeAdapter } from "../src/events.js";
import { normalizeFilter, type ArrivalRow, type ArrivalSource } from "../src/watches.js";

type Row = ArrivalRow & { at: number };

const id = { dev: 1, ino: 2 };

/** A store whose rows the test appends to, as `watch-resources.test.ts` does. */
const fakeSource = () => {
  const rows: Row[] = [];
  const source: ArrivalSource<Row> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => rows.filter((r) => r.cursor > after).slice(0, limit),
  };
  return {
    source,
    arrive: (cursor: number, sender = "jo@acme.com") =>
      rows.push({ cursor, key: `g${cursor}`, sender, at: 1_700_000_000_000 + cursor * 1000 }),
  };
};

const adapterOf = (store: ReturnType<typeof fakeSource>, calls: string[]) => {
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
const setup = () => {
  const store = fakeSource();
  const calls: string[] = [];
  const eras: Era[] = [];
  const handler = createMcpHandler(({ era }) => {
    eras.push(era);
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerEvents(server, { era, adapters: [adapterOf(store, calls)] });
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
