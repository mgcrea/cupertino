import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import { registerSurfaceResources } from "../src/resources.js";
import { createWatches, type WatchesOptions } from "../src/watch-resources.js";
import { normalizeFilter, type ArrivalRow, type ArrivalSource } from "../src/watches.js";

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
        message: expect.stringContaining(`"after" must be a non-negative integer cursor, got "${bad}"`),
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
