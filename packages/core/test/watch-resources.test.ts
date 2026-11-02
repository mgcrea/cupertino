import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  SUBSCRIPTION_ID_META_KEY,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ListenLedger, withListenLedger } from "../src/listens.js";
import { registerSurfaceResources } from "../src/resources.js";
import { createWatches, type WatchesOptions } from "../src/watch-resources.js";
import {
  normalizeFilter,
  type ArrivalRow,
  type ArrivalSource,
  type WatchRegistry,
} from "../src/watches.js";

/** `at` stands in for a surface's public fields: everything else on a row is the registry's. */
type Row = ArrivalRow & { at: number };

/** A store whose rows the test appends to; `since` can be made to fail. */
const fakeSource = (initial: Row[] = []) => {
  const rows = [...initial];
  let failing = false;
  const source: ArrivalSource<Row> = {
    head: () => rows.at(-1)?.cursor ?? 0,
    since: (after, limit) => {
      if (failing) throw new Error("database is locked");
      return rows.filter((r) => r.cursor > after).slice(0, limit);
    },
  };
  return {
    source,
    arrive: (cursor: number, sender: string, extra: Partial<Row> = {}) =>
      rows.push({ cursor, key: `g${cursor}`, sender, at: cursor, ...extra }),
    fail: (on: boolean) => {
      failing = on;
    },
  };
};

const acme = normalizeFilter({ domains: ["acme.com"] });

const setup = async (opts: Partial<WatchesOptions<Row>> & { initial?: Row[] } = {}) => {
  const { initial, ...rest } = opts;
  const store = fakeSource(initial);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const watches = createWatches(server, {
    surface: "widget",
    displayName: "Widget",
    era: "legacy",
    source: store.source,
    ...rest,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const updated: string[] = [];
  client.setNotificationHandler("notifications/resources/updated", (n) => {
    updated.push(n.params.uri);
  });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, watches, store, updated };
};

/** Notifications cross an in-memory transport on a microtask or two. */
const settle = () => new Promise((r) => setTimeout(r, 20));

const readJson = async (client: Client, uri: string) => {
  const res = await client.readResource({ uri });
  return JSON.parse(String((res.contents[0] as { text?: string }).text));
};

describe("createWatches: what is listed and declared", () => {
  it("keeps watch URIs out of resources/list and offers the template", async () => {
    const { client, watches } = await setup();
    watches.add(acme);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([]);
    expect(
      (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate),
    ).toContain("cupertino://widget/watch/{id}{?after}");
  });

  it("declares resources.subscribe", async () => {
    const { client } = await setup();
    expect(client.getServerCapabilities()?.resources?.subscribe).toBe(true);
  });

  it.each([true, false])(
    "does not clobber what registerSurfaceResources declares (surface resources first: %s)",
    async (surfaceFirst) => {
      const store = fakeSource();
      const server = new McpServer({ name: "test", version: "0.0.0" });
      const surface = () =>
        registerSurfaceResources(server, {
          surface: "widget",
          displayName: "Widget",
          guide: "# Widget",
          diagnostics: async () => ({ ok: true }),
        });
      if (surfaceFirst) surface();
      createWatches(server, {
        surface: "widget",
        displayName: "Widget",
        era: "legacy",
        source: store.source,
      });
      if (!surfaceFirst) surface();
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(st), client.connect(ct)]);
      expect(client.getServerCapabilities()?.resources).toMatchObject({
        subscribe: true,
        listChanged: true,
      });
    },
  );
});

describe("createWatches: reading a handle", () => {
  it("answers an unknown id with -32602", async () => {
    const { client } = await setup();
    await expect(
      client.readResource({ uri: "cupertino://widget/watch/w_nope" }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("refuses a bad `after` with -32602, saying what `after` must be", async () => {
    const { client, watches } = await setup();
    const w = watches.add(acme);
    for (const bad of ["abc", "-1", "1.5", ""]) {
      await expect(client.readResource({ uri: `${w.uri}?after=${bad}` })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining(
          `"after" must be a non-negative integer cursor, got "${bad}"`,
        ),
      });
    }
  });

  it("refuses an unknown or malformed query with -32602 bad query, not not-found", async () => {
    const { client, watches } = await setup();
    const w = watches.add(acme);
    for (const query of ["foo=1", "after=5&x=1", "x=1&after=5", "after=1&after=2", ""]) {
      await expect(client.readResource({ uri: `${w.uri}?${query}` })).rejects.toMatchObject({
        code: -32602,
        message: expect.stringMatching(/bad query/),
      });
    }
  });

  it("returns only rows past `after`", async () => {
    const { client, watches, store } = await setup();
    const w = watches.add(acme);
    for (const c of [3, 4, 5, 6, 7]) store.arrive(c, "jo@acme.com");
    const all = await readJson(client, w.uri);
    expect(all.messages.map((m: Row) => m.at)).toEqual([3, 4, 5, 6, 7]);
    const rest = await readJson(client, `${w.uri}?after=5`);
    expect(rest.messages.map((m: Row) => m.at)).toEqual([6, 7]);
    expect(rest.cursor).toBe(7);
  });

  it("names the watch by id and returns only each row's public fields", async () => {
    const { client, watches, store } = await setup();
    const w = watches.add(acme);
    store.arrive(1, "jo@acme.com", { scope: ["1"] });
    const body = await readJson(client, w.uri);
    expect(body.watch).toBe(w.id);
    expect(body.messages).toEqual([{ at: 1 }]);
  });

  it("never pages before the watch began", async () => {
    const { client, watches, store } = await setup({
      initial: [{ cursor: 1, key: "g1", sender: "jo@acme.com", at: 1 }],
    });
    const w = watches.add(acme);
    store.arrive(2, "jo@acme.com");
    const body = await readJson(client, `${w.uri}?after=0`);
    expect(body.messages.map((m: Row) => m.at)).toEqual([2]);
  });

  it("turns a failing store into degraded data, not a protocol error", async () => {
    const { client, watches, store } = await setup();
    const w = watches.add(acme);
    store.fail(true);
    const body = await readJson(client, w.uri);
    expect(body).toMatchObject({ degraded: true, error: "database is locked" });
    expect(body.hint).toContain("cupertino://widget/diagnostics");
  });
});

describe("createWatches: notifications by era", () => {
  it("legacy: notifies a subscribed URI once per tick", async () => {
    const { client, watches, store, updated } = await setup();
    const w = watches.add(acme);
    await client.subscribeResource({ uri: w.uri });
    store.arrive(1, "jo@acme.com");
    watches.tick();
    await settle();
    expect(updated).toEqual([w.uri]);
  });

  it("legacy: stays quiet when not subscribed, and after unsubscribe", async () => {
    const { client, watches, store, updated } = await setup();
    const w = watches.add(acme);
    store.arrive(1, "jo@acme.com");
    watches.tick();
    await settle();
    expect(updated).toEqual([]);

    await client.subscribeResource({ uri: w.uri });
    await client.unsubscribeResource({ uri: w.uri });
    store.arrive(2, "jo@acme.com");
    watches.tick();
    await settle();
    expect(updated).toEqual([]);
  });

  it("modern: sends every update, leaving the filtering to the SDK's router", async () => {
    const { server, watches, store } = await setup({ era: "modern" });
    const spy = vi.spyOn(server.server, "sendResourceUpdated").mockResolvedValue(undefined);
    const w = watches.add(acme);
    store.arrive(1, "jo@acme.com");
    watches.tick();
    store.arrive(2, "jo@acme.com");
    watches.tick();
    expect(spy.mock.calls).toEqual([[{ uri: w.uri }], [{ uri: w.uri }]]);
  });

  it("modern: registers no subscribe handlers of its own", async () => {
    const { client, watches } = await setup({ era: "modern" });
    const w = watches.add(acme);
    // The router answers modern subscriptions; a legacy handler here would be
    // a second, competing subscription table.
    await expect(client.subscribeResource({ uri: w.uri })).rejects.toMatchObject({ code: -32601 });
  });
});

/** A logger that keeps what `warn` was given, one string per line. */
const warnings = () => {
  const lines: string[] = [];
  return { lines, logger: { warn: (...args: unknown[]) => lines.push(args.join(" ")) } };
};

describe("createWatches: a dropped push is said", () => {
  it("legacy: says so for a URI nobody subscribed to, and not once it is", async () => {
    const { lines, logger } = warnings();
    const { client, watches, store } = await setup({ logger });
    const w = watches.add(acme);
    store.arrive(1, "jo@acme.com");
    watches.tick();
    expect(lines).toEqual([
      `push dropped (no listener): ${w.uri}, not subscribed with resources/subscribe`,
    ]);
    await client.subscribeResource({ uri: w.uri });
    store.arrive(2, "jo@acme.com");
    watches.tick();
    expect(lines).toHaveLength(1);
  });

  it("modern: says so when no listen covers the URI, and sends it anyway", async () => {
    const { lines, logger } = warnings();
    const covered = new Set<string>();
    const { server, watches, store } = await setup({
      era: "modern",
      logger,
      listens: { covers: (uri) => covered.has(uri) },
    });
    const spy = vi.spyOn(server.server, "sendResourceUpdated").mockResolvedValue(undefined);
    const w = watches.add(acme);
    store.arrive(1, "jo@acme.com");
    watches.tick();
    expect(lines).toEqual([
      `push dropped (no listener): ${w.uri}, no open subscriptions/listen names it`,
    ]);
    covered.add(w.uri);
    store.arrive(2, "jo@acme.com");
    watches.tick();
    expect(lines).toHaveLength(1);
    // The router, not the ledger, decides: both updates were handed to it.
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("modern: says nothing without a ledger, since a drop there cannot be seen", async () => {
    const { lines, logger } = warnings();
    const { server, watches, store } = await setup({ era: "modern", logger });
    vi.spyOn(server.server, "sendResourceUpdated").mockResolvedValue(undefined);
    watches.add(acme);
    store.arrive(1, "jo@acme.com");
    watches.tick();
    expect(lines).toEqual([]);
  });
});

/**
 * The ledger against the SDK's real router: `serveStdio` over a transport the
 * test writes JSON-RPC into, as event-handlers.test.ts does for streams. What is
 * asserted is that the log line and the wire agree, in each state a listen can
 * be in: a drop is logged exactly when the router sent nothing.
 */
describe("createWatches: the drop line agrees with serveStdio's router", () => {
  const ENVELOPE = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  let teardown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await teardown?.();
    teardown = undefined;
  });

  const wired = () => {
    const sent: JSONRPCMessage[] = [];
    const { lines, logger } = warnings();
    const store = fakeSource();
    const listens = new ListenLedger();
    let registry: WatchRegistry<Row> | undefined;
    const transport: Transport = {
      start: async () => {},
      send: async (message) => {
        sent.push(message);
      },
      close: async () => {
        transport.onclose?.();
      },
    };
    const handle = serveStdio(
      ({ era }) => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        registry = createWatches(server, {
          surface: "widget",
          displayName: "Widget",
          era,
          source: store.source,
          logger,
          listens,
        });
        return server;
      },
      { transport: withListenLedger(transport, listens) },
    );
    teardown = () => handle.close();
    const write = (msg: Record<string, unknown>) =>
      transport.onmessage?.({ jsonrpc: "2.0", ...msg } as JSONRPCMessage);
    const acked = (id: number) =>
      sent.some((m) => {
        if (!("method" in m) || m.method !== "notifications/subscriptions/acknowledged")
          return false;
        const { _meta: meta } = (m.params ?? {}) as { _meta?: Record<string, unknown> };
        return meta?.[SUBSCRIPTION_ID_META_KEY] === id;
      });
    const listen = async (id: number, notifications: Record<string, unknown>) => {
      write({ id, method: "subscriptions/listen", params: { notifications, _meta: ENVELOPE } });
      for (let i = 0; i < 100 && !acked(id); i++) await settle();
      expect(acked(id)).toBe(true);
    };
    const cancel = async (id: number) => {
      write({
        method: "notifications/cancelled",
        params: { requestId: id, reason: "test done", _meta: ENVELOPE },
      });
      await settle();
    };
    const pushes = () =>
      sent.filter((m) => "method" in m && m.method === "notifications/resources/updated");
    const watches = () => {
      if (!registry) throw new Error("no instance yet: open a listen first");
      return registry;
    };
    return { sent, lines, store, listens, listen, cancel, pushes, watches };
  };

  it("logs while only a list-changed listen is open, and the router sends nothing", async () => {
    const { lines, store, listen, pushes, watches } = wired();
    // What Claude Code opens at connect, and the only listen it opens.
    await listen(1, { toolsListChanged: true, resourcesListChanged: true });
    const w = watches().add(acme);
    store.arrive(1, "jo@acme.com");
    watches().tick();
    await settle();
    expect(pushes()).toEqual([]);
    expect(lines).toEqual([
      `push dropped (no listener): ${w.uri}, no open subscriptions/listen names it`,
    ]);
  });

  it("stays quiet while a listen names the URI, and logs again once it is cancelled", async () => {
    const { lines, store, listens, listen, cancel, pushes, watches } = wired();
    await listen(1, { resourcesListChanged: true });
    const w = watches().add(acme);
    await listen(2, { resourceSubscriptions: [w.uri] });
    expect(listens.covers(w.uri)).toBe(true);

    store.arrive(1, "jo@acme.com");
    watches().tick();
    await settle();
    expect(pushes()).toHaveLength(1);
    expect(lines).toEqual([]);

    await cancel(2);
    expect(listens.covers(w.uri)).toBe(false);
    store.arrive(2, "jo@acme.com");
    watches().tick();
    await settle();
    expect(pushes()).toHaveLength(1);
    expect(lines).toEqual([
      `push dropped (no listener): ${w.uri}, no open subscriptions/listen names it`,
    ]);
  });

  it("forgets every listen the router closes when the connection ends", async () => {
    const { listens, listen, watches } = wired();
    await listen(1, { resourcesListChanged: true });
    const w = watches().add(acme);
    await listen(2, { resourceSubscriptions: [w.uri] });
    expect(listens.size).toBe(2);
    await teardown?.();
    teardown = undefined;
    expect(listens.size).toBe(0);
  });
});

describe("createWatches: a discarded probe starts nothing", () => {
  /*
   * serveStdio builds a server for the discover probe and may throw it away
   * when the host then falls back to `initialize`. Nothing may run until the
   * first `add`, or every probe would leave a trigger polling a database.
   */
  it("never calls startTrigger until a watch is added", async () => {
    const startTrigger = vi.fn(() => ({ stop: vi.fn() }));
    const { watches } = await setup({ startTrigger });
    watches.tick();
    expect(startTrigger).not.toHaveBeenCalled();
    watches.add(acme);
    expect(startTrigger).toHaveBeenCalledTimes(1);
  });
});
