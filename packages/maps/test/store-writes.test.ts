import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { MapsLane } from "../src/client/lane.js";
import { AppleMapsClient } from "../src/client/maps.js";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/tools/index.js";
import { STORE_WRITE_TOOLS } from "../src/tools/store-writes.js";

/**
 * The five Maps writes on the store lane, with the lane stubbed as Voice Memos'
 * tests stub it: a fake `cupertino.sock` speaking the handshake and JSON-RPC.
 *
 * The store is a synthetic one built from the real schema, because the tools
 * still read it (de-duplication, seeding, a ref's identifier) before they ask
 * the lane to write. Every place here is synthetic.
 */

type Request = { id: number; method: string; params: Record<string, unknown> };
type Reply = { result: unknown } | { error: Record<string, unknown> };

const sockets = new Set<Server>();
const scratch = new Set<string>();
afterEach(() => {
  for (const server of sockets) server.close();
  sockets.clear();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.clear();
});

/**
 * A stand-in for the app's store verb on `cupertino.sock`. `reply` answers each
 * JSON-RPC line; `seen` holds every line the server under test wrote,
 * handshake first.
 */
const hostStub = async (
  reply: (message: Request) => Reply,
): Promise<{ env: NodeJS.ProcessEnv; seen: string[]; connections: () => number }> => {
  const dir = mkdtempSync(join(tmpdir(), "maps-lane-"));
  scratch.add(dir);
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  let connections = 0;
  const server = createServer((socket: Socket) => {
    connections += 1;
    let buffer = "";
    let greeted = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        seen.push(line);
        if (!greeted) {
          greeted = true;
          socket.write("ok\n");
          continue;
        }
        const message = JSON.parse(line) as Request;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply(message) })}\n`);
      }
    });
  });
  sockets.add(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    env: { CUPERTINO_AX_SOCKET: path, CUPERTINO_AX_FOR: "maps" },
    seen,
    connections: () => connections,
  };
};

/** The lane methods and params the server sent, handshake dropped. */
const sent = (seen: string[]) =>
  seen.slice(1).map((line) => {
    const { method, params } = JSON.parse(line) as Request;
    return { method, params };
  });

// ── a synthetic store ────────────────────────────────────────────────────────

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maps-store.sql"),
  "utf8",
);

const ENT = {
  collectionItem: 7,
  collectionPlaceItem: 8,
  favoriteItem: 13,
  historyItem: 14,
  historyPlaceItem: 16,
  mixinMapItem: 25,
} as const;

const FAV_ID = "11111111-2222-4333-8444-555555555555";
const SAVED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RECENT_ID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const SEEDED_ID = "12345678-9abc-4def-8123-456789abcdef";
/** What the stubbed lane answers for a new item. */
const NEW_ID = "C0FFEE00-1111-4222-8333-444455556666";

const blob = (uuid: string): string => `X'${uuid.replaceAll("-", "")}'`;

const exec = (path: string, sql: string): void => {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
};

const mapItem = (pk: number, lat: number, lon: number): string => `
  INSERT INTO ZMIXINMAPITEM (Z_PK, Z_ENT, Z_OPT, ZLATITUDE, ZLONGITUDE, ZMAPITEMSTORAGE)
    VALUES (${pk}, ${ENT.mixinMapItem}, 1, ${lat}, ${lon}, X'0a0b53796e746865746963');
`;

const favorite = (pk: number, lat: number, lon: number, name: string, id: string | null) => `
  ${mapItem(100 + pk, lat, lon)}
  INSERT INTO ZFAVORITEITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZIDENTIFIER)
    VALUES (${pk}, ${ENT.favoriteItem}, 1, ${100 + pk}, ${lat}, ${lon}, '${name}', ${id ? blob(id) : "NULL"});
`;

const savedPlace = (pk: number, lat: number, lon: number, name: string, id: string | null) => `
  ${mapItem(200 + pk, lat, lon)}
  INSERT INTO ZCOLLECTIONITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE, ZLONGITUDE, ZMAPITEMNAME, ZIDENTIFIER)
    VALUES (${pk}, ${ENT.collectionPlaceItem}, 1, ${200 + pk}, ${lat}, ${lon}, '${name}', ${id ? blob(id) : "NULL"});
`;

const recent = (pk: number, mapPk: number, lat: number, lon: number, id: string) => `
  ${mapItem(mapPk, lat, lon)}
  INSERT INTO ZHISTORYITEM (Z_PK, Z_ENT, Z_OPT, ZMAPITEM, ZLATITUDE1, ZLONGITUDE1, ZIDENTIFIER)
    VALUES (${pk}, ${ENT.historyPlaceItem}, 1, ${mapPk}, ${lat}, ${lon}, ${blob(id)});
`;

/** An empty store with the real schema, in WAL like the real one. */
const emptyStore = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "maps-store-writes-"));
  scratch.add(dir);
  const path = join(dir, "MapsSync_0.0.1");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(FIXTURE);
  db.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (${ENT.collectionItem}, 'CollectionItem', 0, 0),
      (${ENT.collectionPlaceItem}, 'CollectionPlaceItem', ${ENT.collectionItem}, 0),
      (${ENT.favoriteItem}, 'FavoriteItem', 0, 0),
      (${ENT.historyItem}, 'HistoryItem', 0, 0),
      (${ENT.historyPlaceItem}, 'HistoryPlaceItem', ${ENT.historyItem}, 0),
      (${ENT.mixinMapItem}, 'MixinMapItem', 0, 0);
  `);
  db.close();
  return path;
};

/** Stands in for Maps: resolves any query to a recent at (lat, lon), as the app does. */
const seedsAt = (path: string, lat: number, lon: number, opened: string[]) => (url: string) => {
  opened.push(url);
  exec(path, recent(900, 900, lat, lon, SEEDED_ID));
};

const failIfCalled = () => {
  throw new Error("Maps must not be asked to resolve a place already in the store");
};

// ── the lane's answers ───────────────────────────────────────────────────────

const STATUS = {
  compatible: true,
  modelVersion: "CaxhFkDDBEvVUHzx/wKUv4k+QehKTgcfEuPWR91+uhk=",
  syncMeasured: true,
  refusal: null,
};

const written = (over: Record<string, unknown> = {}): Reply => ({
  result: {
    id: NEW_ID,
    changed: ["favorite"],
    created: true,
    modelVersion: STATUS.modelVersion,
    syncMeasured: true,
    ...over,
  },
});

/** A measured save that created one item; filed for fileInGuide. */
const saves = (m: Request): Reply => {
  if (m.method === "maps.status") return { result: STATUS };
  if (m.method === "maps.fileInGuide") return written({ id: SAVED_ID, filed: true });
  if (m.method.startsWith("maps.remove")) {
    return written({ id: String(m.params.id), created: false });
  }
  return written();
};

/**
 * As `saves`, and the write lands in the synthetic store first, as the app's
 * save would, so the tool's read-back has a row to describe.
 */
const savesInto =
  (path: string, sql: string) =>
  (m: Request): Reply => {
    if (m.method !== "maps.status") exec(path, sql);
    return saves(m);
  };

// ── the server ───────────────────────────────────────────────────────────────

const connect = async (opts: {
  writes: boolean;
  lane: NodeJS.ProcessEnv | null;
  storePath?: string;
  openUrl?: (url: string) => void;
}) => {
  const config = loadConfig({
    APPLE_MAPS_INDEX_MODE: "off",
    APPLE_MAPS_STORE: opts.storePath ?? emptyStore(),
    APPLE_MAPS_SEED_TIMEOUT_MS: "2000",
    ...(opts.writes ? { APPLE_MAPS_ALLOW_WRITES: "1" } : {}),
  });
  const maps = new AppleMapsClient({
    config,
    home: "/nonexistent-home",
    lane: opts.lane ? MapsLane.open(opts.lane) : null,
    openUrl: opts.openUrl ?? failIfCalled,
  });
  const server = new McpServer({ name: "test", version: "0" });
  registerTools(server, maps, { allowWrites: config.allowWrites });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
};

type Result = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => {
  const res = (await c.callTool({ name, arguments: args })) as Result;
  return {
    isError: res.isError === true,
    body: JSON.parse(res.content.map((x) => x.text).join("")) as Record<string, unknown>,
  };
};

/** A call whose answer may not be JSON (an input the schema rejects), or may throw. */
const rawCall = async (c: Client, name: string, args: Record<string, unknown>) => {
  try {
    const res = (await c.callTool({ name, arguments: args })) as Result;
    return { isError: res.isError === true };
  } catch {
    return { isError: true };
  }
};

const MEASURED =
  "Saved the way Maps saves it. It reaches your other devices through iCloud, even with Maps " +
  "closed.";

// ── registration ─────────────────────────────────────────────────────────────

describe("registration", () => {
  const WRITE_NAMES = [
    "apple_maps_add_favorite",
    "apple_maps_remove_favorite",
    "apple_maps_save_place",
    "apple_maps_remove_saved_place",
    "apple_maps_add_place_to_guide",
  ];

  it("names the five lane tools", () => {
    expect(STORE_WRITE_TOOLS).toEqual(WRITE_NAMES);
  });

  it("hosted with writes on: the five lane tools, and nothing connects", async () => {
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    const tools = (await c.listTools()).tools;
    for (const name of WRITE_NAMES) expect(tools.map((t) => t.name)).toContain(name);
    // remove_saved_place takes a ref from a listing, never a query.
    const removeSaved = tools.find((t) => t.name === "apple_maps_remove_saved_place");
    expect(Object.keys(removeSaved?.inputSchema.properties ?? {}).toSorted()).toEqual([
      "confirm",
      "ref",
    ]);
    for (const name of WRITE_NAMES) {
      expect(tools.find((t) => t.name === name)?.description, name).toMatch(
        /Maps' own data model inside Cupertino/,
      );
    }
    // Cupertino lists a server's tools by spawning it with the lane env: that must not connect.
    expect(connections()).toBe(0);
  });

  /*
   * Run from npm there is no store lane, and since 2026-11-11 no other route:
   * the SQL inserts were watched never to mirror, and Maps was seen converting
   * favourites that look like them into saved places. So writes on without the
   * host registers no write tool.
   */
  it("not hosted, writes on: no write tool at all", async () => {
    const tools = (await (await connect({ writes: true, lane: null })).listTools()).tools;
    for (const name of WRITE_NAMES) expect(tools.map((t) => t.name)).not.toContain(name);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it("has no SQL writer and no interface lane on the client", () => {
    const maps = new AppleMapsClient({
      config: loadConfig({ APPLE_MAPS_INDEX_MODE: "off", APPLE_MAPS_ALLOW_WRITES: "1" }),
      home: "/nonexistent-home",
      lane: null,
    });
    expect("writer" in maps).toBe(false);
    expect("axLane" in maps).toBe(false);
  });

  it("writes off: no write tool, hosted or not", async () => {
    const { env } = await hostStub(saves);
    const names = (await (await connect({ writes: false, lane: env })).listTools()).tools.map(
      (t) => t.name,
    );
    for (const name of WRITE_NAMES) expect(names).not.toContain(name);
  });

  it("does not depend on whether the lane is compatible", async () => {
    const { env, connections } = await hostStub(() => ({
      error: { code: -32000, message: "model mismatch", data: { reason: "incompatible" } },
    }));
    const names = (await (await connect({ writes: true, lane: env })).listTools()).tools.map(
      (t) => t.name,
    );
    for (const name of WRITE_NAMES) expect(names).toContain(name);
    expect(connections()).toBe(0);
  });

  it("no lane tool says it brings Maps forward or presses anything", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    for (const name of WRITE_NAMES) {
      const text = JSON.stringify(tools.find((t) => t.name === name));
      expect(text, name).not.toMatch(/forward|press/i);
    }
  });

  it("keeps the Recents sentence on the three tools that can seed", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    for (const name of WRITE_NAMES) {
      const seeds = !/remove_/.test(name);
      const description = tools.find((t) => t.name === name)?.description ?? "";
      expect(/also appears in the user's Recents/.test(description), name).toBe(seeds);
    }
  });

  it("words the removes as removals, and the adds as saves", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    for (const name of WRITE_NAMES) {
      const removes = /remove_/.test(name);
      const description = tools.find((t) => t.name === name)?.description ?? "";
      expect(/Removed through Maps' own data model inside Cupertino/.test(description), name).toBe(
        removes,
      );
      expect(/Saved through Maps' own data model inside Cupertino/.test(description), name).toBe(
        !removes,
      );
    }
  });

  it("annotates the removes destructive, and keeps their confirm", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    for (const name of WRITE_NAMES) {
      const tool = tools.find((t) => t.name === name);
      const removes = /remove_/.test(name);
      expect(tool?.annotations, name).toEqual({
        readOnlyHint: false,
        destructiveHint: removes,
        idempotentHint: true,
      });
      expect(Object.keys(tool?.inputSchema.properties ?? {}).includes("confirm"), name).toBe(
        removes,
      );
    }
  });
});

// ── add_favorite and save_place ──────────────────────────────────────────────

describe("add_favorite", () => {
  it("copies a record already in the store, sending maps.addFavorite", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    // The app writes the favourite at the record's coordinate, a metre from the caller's.
    const { env, seen } = await hostStub(
      savesInto(path, favorite(50, 48.100003, 2.200003, "Synthetic Café", NEW_ID)),
    );
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(seen[0]).toBe("cupertino/1 store for=maps");
    expect(sent(seen)).toEqual([
      {
        method: "maps.addFavorite",
        // No name was given: the query goes as the query, never as a label.
        params: {
          source: "recent",
          sourceId: RECENT_ID,
          query: "Synthetic Café",
          near: { latitude: 48.1, longitude: 2.2 },
        },
      },
    ]);
    expect(res).toEqual({
      isError: false,
      body: {
        favorite: {
          ref: `p1:f:${NEW_ID.replaceAll("-", "").toLowerCase()}`,
          name: "Synthetic Café",
          latitude: 48.100003,
          longitude: 2.200003,
        },
        created: true,
        changed: ["favorite"],
        modelVersion: STATUS.modelVersion,
        syncMeasured: true,
        sync: MEASURED,
      },
    });
  });

  it("sends an explicit name as the label, beside the query", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    for (const tool of ["apple_maps_add_favorite", "apple_maps_save_place"]) {
      await call(c, tool, {
        query: "Synthetic Café",
        name: "Synthetic label",
        latitude: 48.1,
        longitude: 2.2,
      });
    }
    expect(sent(seen).map((m) => m.params)).toEqual([
      {
        source: "recent",
        sourceId: RECENT_ID,
        query: "Synthetic Café",
        name: "Synthetic label",
        near: { latitude: 48.1, longitude: 2.2 },
      },
      {
        source: "recent",
        sourceId: RECENT_ID,
        query: "Synthetic Café",
        name: "Synthetic label",
        near: { latitude: 48.1, longitude: 2.2 },
      },
    ]);
  });

  it("returns an existing favourite without calling the lane, under its own name", async () => {
    const path = emptyStore();
    // A metre away and saved under another name: the coordinate alone makes it this place.
    exec(path, favorite(1, 48.100004, 2.200004, "Stored Name", FAV_ID));
    const { env, seen, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(connections()).toBe(0);
    expect(seen).toEqual([]);
    expect(res.body).toMatchObject({
      favorite: {
        ref: `p1:f:${FAV_ID.replaceAll("-", "")}`,
        name: "Stored Name",
        latitude: 48.100004,
        longitude: 2.200004,
      },
      created: false,
      changed: [],
      sync: "Nothing to change.",
    });
    expect(res.body.alreadyExisted).toMatch(/already existed/);
    expect(res.body.recentsNote).toBeUndefined();
  });

  it("matches an existing favourite by the label it is saved under", async () => {
    const path = emptyStore();
    // ~100 m from the caller's coordinate: only the name makes it the same place.
    exec(path, favorite(1, 48.101, 2.2, "Home-ish", FAV_ID));
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      name: "Home-ish",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(connections()).toBe(0);
    expect(res.body.created).toBe(false);
    // The favourite's own coordinate, ~100 m from the caller's, not the caller's.
    expect(res.body.favorite).toMatchObject({ name: "Home-ish", latitude: 48.101, longitude: 2.2 });
  });

  it("seeds when nothing is known, and says the place is now in Recents", async () => {
    const path = emptyStore();
    const opened: string[] = [];
    const { env, seen } = await hostStub(saves);
    const c = await connect({
      writes: true,
      lane: env,
      storePath: path,
      openUrl: seedsAt(path, 51.5007, -0.1246, opened),
    });
    const res = await call(c, "apple_maps_add_favorite", { query: "Synthetic Tower" });
    expect(opened).toEqual(["maps://?q=Synthetic%20Tower"]);
    expect(sent(seen)).toEqual([
      {
        method: "maps.addFavorite",
        params: { source: "recent", sourceId: SEEDED_ID, query: "Synthetic Tower" },
      },
    ]);
    expect(res.body.recentsNote).toMatch(/Recents/);
    // The stub app wrote nothing to the store, so there is nothing to describe: no guess.
    expect(res.body.favorite).toEqual({
      ref: `p1:f:${NEW_ID.replaceAll("-", "").toLowerCase()}`,
    });
  });

  it("reports the lane's own idempotence as already existing, as the item stands", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    // Not found by the caller's coordinate and name, but the app's check at the
    // resolved coordinate finds it: the answer is that favourite, under its own name.
    exec(path, favorite(2, 48.1012, 2.2012, "Stored Name", FAV_ID));
    const { env } = await hostStub(() => written({ id: FAV_ID, created: false, changed: [] }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(res.body).toMatchObject({
      favorite: {
        ref: `p1:f:${FAV_ID.replaceAll("-", "")}`,
        name: "Stored Name",
        latitude: 48.1012,
        longitude: 2.2012,
      },
      created: false,
      sync: "Nothing to change.",
    });
    expect(res.body.alreadyExisted).toMatch(/already existed/);
  });

  it("passes an incompatible lane through as the tool error's reason", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const { env } = await hostStub(() => ({
      error: {
        code: -32000,
        message: "Maps' model on this Mac is not one Cupertino can write.",
        data: { reason: "incompatible" },
      },
    }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(res.isError).toBe(true);
    expect(res.body.error).toBe("Maps: Maps' model on this Mac is not one Cupertino can write.");
    expect(res.body.details).toMatchObject({ reason: "incompatible" });
  });

  it("says sync is not yet measured when the lane says so", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const { env } = await hostStub(() => written({ syncMeasured: false, modelVersion: "M2" }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(res.body.sync).toBe(
      "Saved, but sync is not yet measured on this macOS (model M2): check the place on " +
        "another device.",
    );
  });

  it("refuses an unreadable reply as a protocol error", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const { env } = await hostStub(() => ({ result: { id: NEW_ID } }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_favorite", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(res.isError).toBe(true);
    expect(res.body.details).toMatchObject({ reason: "protocol" });
  });
});

describe("save_place", () => {
  it("sends maps.savePlace, donor first, and answers with a saved-place ref", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env, seen } = await hostStub(
      savesInto(path, savedPlace(50, 48.1, 2.2, "Synthetic Café", NEW_ID)),
    );
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_save_place", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(sent(seen)).toEqual([
      {
        method: "maps.savePlace",
        params: {
          source: "favorite",
          sourceId: FAV_ID,
          query: "Synthetic Café",
          near: { latitude: 48.1, longitude: 2.2 },
        },
      },
    ]);
    expect(res.body).toMatchObject({
      place: { ref: `p1:c:${NEW_ID.replaceAll("-", "").toLowerCase()}`, name: "Synthetic Café" },
      saved: true,
      alreadySaved: false,
      created: true,
      sync: MEASURED,
    });
  });

  it("returns an existing saved place without calling the lane", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_save_place", {
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(connections()).toBe(0);
    expect(res.body).toMatchObject({
      place: {
        ref: `p1:c:${SAVED_ID.replaceAll("-", "")}`,
        name: "Synthetic Café",
        latitude: 48.1,
        longitude: 2.2,
      },
      saved: true,
      alreadySaved: true,
      created: false,
      sync: "Nothing to change.",
    });
  });

  it("carries the Recents note when it seeded", async () => {
    const path = emptyStore();
    const { env } = await hostStub(saves);
    const c = await connect({
      writes: true,
      lane: env,
      storePath: path,
      openUrl: seedsAt(path, 48.1, 2.2, []),
    });
    const res = await call(c, "apple_maps_save_place", { query: "Synthetic Café" });
    expect(res.body.recentsNote).toMatch(/Recents/);
  });
});

// ── the removes ──────────────────────────────────────────────────────────────

describe("remove_favorite and remove_saved_place", () => {
  it("remove_favorite sends maps.removeFavorite with the row's identifier", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    // A row-id ref still works when the row has an identifier.
    const res = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(sent(seen)).toEqual([{ method: "maps.removeFavorite", params: { id: FAV_ID } }]);
    expect(res.body).toMatchObject({ removed: true, id: FAV_ID, sync: MEASURED });
  });

  /*
   * Watched 2026-11-11 (docs/maps.md, "What Maps changes"): Maps does not
   * delete an unpinned place, it moves it into the library as a saved place.
   * The lane does the same, so the tool must not read as a delete.
   */
  it("remove_favorite says unpinning keeps the place as a saved place", async () => {
    const { env } = await hostStub(saves);
    const tools = (await (await connect({ writes: true, lane: env })).listTools()).tools;
    const description = tools.find((t) => t.name === "apple_maps_remove_favorite")?.description;
    expect(description).toMatch(/keeps the place in the user's library as a saved place/);
    expect(description).toMatch(/apple_maps_remove_saved_place removes it entirely/);
    // True in both cases the lane answers `["favorite"]`.
    expect(description).toMatch(
      /no new one is made when one already stands at that spot, or the pin carries no place record/,
    );
    // MapsWriter refuses anything but a pin (`type 1`).
    expect(description).toMatch(/Only pins: the Home, Work and School slots are refused\./);
  });

  it("remove_favorite answers that a new saved place now holds the place", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env } = await hostStub(() =>
      written({ id: FAV_ID, created: true, changed: ["favorite", "savedPlace"] }),
    );
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(res.body).toMatchObject({ removed: true, changed: ["favorite", "savedPlace"] });
    expect(res.body.library).toMatch(/^Unpinned, and kept in your library as a saved place/);
    expect(res.body.library).toMatch(
      /apple_maps_remove_saved_place removes it entirely, by its ref from apple_maps_list_unfiled_places or apple_maps_list_collection_places\./,
    );
  });

  /*
   * `["favorite"]` alone has two causes in MapsWriter: a saved place already at
   * that spot, or a pin with no place record or coordinate to move. The lane
   * does not say which, so the sentence must be true of both.
   */
  it("remove_favorite answers that no new saved place was made, true of both causes", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env } = await hostStub(() =>
      written({ id: FAV_ID, created: false, changed: ["favorite"] }),
    );
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(res.body).toMatchObject({ removed: true, changed: ["favorite"] });
    expect(res.body.library).toMatch(
      /^Unpinned\. No new saved place was made: one already stood at this spot, or the pin carried no place record to keep\./,
    );
    expect(res.body.library).toMatch(
      /apple_maps_remove_saved_place removes a saved place entirely, by its ref from apple_maps_list_unfiled_places or apple_maps_list_collection_places\./,
    );
  });

  it("remove_saved_place sends maps.removeSavedPlace", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_remove_saved_place", {
      ref: `p1:c:${SAVED_ID.replaceAll("-", "")}`,
      confirm: true,
    });
    expect(sent(seen)).toEqual([{ method: "maps.removeSavedPlace", params: { id: SAVED_ID } }]);
    expect(res.body).toMatchObject({ removed: true, id: SAVED_ID, sync: MEASURED });
  });

  it("refuses a row with no identifier as notFound, without calling the lane", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", null));
    exec(path, savedPlace(2, 48.2, 2.3, "Synthetic Bar", null));
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const fav = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(fav.isError).toBe(true);
    expect(fav.body.error).toMatch(/no stable id, so it cannot be removed through Cupertino/);
    expect(fav.body.details).toMatchObject({ reason: "notFound" });
    const saved = await call(c, "apple_maps_remove_saved_place", {
      ref: "p1:c:2",
      confirm: true,
    });
    expect(saved.isError).toBe(true);
    expect(saved.body.details).toMatchObject({ reason: "notFound" });
    expect(connections()).toBe(0);
  });

  it("refuses a ref of the wrong kind as invalid", async () => {
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    const fav = await call(c, "apple_maps_remove_favorite", { ref: "p1:c:1", confirm: true });
    expect(fav.isError).toBe(true);
    expect(fav.body.details).toMatchObject({ reason: "invalid" });
    const saved = await call(c, "apple_maps_remove_saved_place", {
      ref: "p1:f:1",
      confirm: true,
    });
    expect(saved.isError).toBe(true);
    expect(saved.body.details).toMatchObject({ reason: "invalid" });
    expect(connections()).toBe(0);
  });

  it("refuses a uuid ref that matches no row as notFound, naming the miss", async () => {
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    const fav = await call(c, "apple_maps_remove_favorite", {
      ref: `p1:f:${FAV_ID.replaceAll("-", "")}`,
      confirm: true,
    });
    expect(fav.isError).toBe(true);
    expect(fav.body.error).toMatch(/^No favourite matched that ref/);
    expect(fav.body.details).toMatchObject({ reason: "notFound" });
    const saved = await call(c, "apple_maps_remove_saved_place", {
      ref: `p1:c:${SAVED_ID.replaceAll("-", "")}`,
      confirm: true,
    });
    expect(saved.body.error).toMatch(/^No saved place matched that ref/);
    expect(saved.body.details).toMatchObject({ reason: "notFound" });
    expect(connections()).toBe(0);
  });

  it("refuses a malformed ref as invalid", async () => {
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    for (const name of ["apple_maps_remove_favorite", "apple_maps_remove_saved_place"]) {
      const res = await call(c, name, { ref: "not-a-ref", confirm: true });
      expect(res.isError, name).toBe(true);
      expect(res.body.error, name).toMatch(/not a place ref/);
      expect(res.body.details, name).toMatchObject({ reason: "invalid" });
    }
    const guide = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "pc1:1",
    });
    expect(guide.body.details).toMatchObject({ reason: "invalid" });
    expect(connections()).toBe(0);
  });

  it("rejects a remove without confirm: true, before the lane", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    exec(path, savedPlace(2, 48.2, 2.3, "Synthetic Bar", SAVED_ID));
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    for (const [name, ref] of [
      ["apple_maps_remove_favorite", "p1:f:1"],
      ["apple_maps_remove_saved_place", "p1:c:2"],
    ] as const) {
      for (const args of [{ ref }, { ref, confirm: false }]) {
        const res = await rawCall(c, name, args);
        expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      }
    }
    expect(connections()).toBe(0);
  });

  it("reports removed false when the lane changed nothing", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env } = await hostStub(() => written({ id: FAV_ID, created: false, changed: [] }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(res.body).toMatchObject({ removed: false, changed: [], sync: "Nothing to change." });
    expect(res.body).not.toHaveProperty("library");
  });

  it("passes the lane's notFound through", async () => {
    const path = emptyStore();
    exec(path, favorite(1, 48.1, 2.2, "Synthetic Café", FAV_ID));
    const { env } = await hostStub(() => ({
      error: { code: -32000, message: "No favourite with that id.", data: { reason: "notFound" } },
    }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_remove_favorite", { ref: "p1:f:1", confirm: true });
    expect(res.isError).toBe(true);
    expect(res.body.details).toMatchObject({ reason: "notFound" });
  });
});

// ── add_place_to_guide ───────────────────────────────────────────────────────

describe("add_place_to_guide", () => {
  it("files a saved place by ref, and reports filed from the lane", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: `p1:c:${SAVED_ID.replaceAll("-", "")}`,
    });
    expect(sent(seen)).toEqual([
      { method: "maps.fileInGuide", params: { guide: "Synthetic guide", placeId: SAVED_ID } },
    ]);
    expect(res.body).toMatchObject({
      filed: true,
      guide: "Synthetic guide",
      place: {
        ref: `p1:c:${SAVED_ID.replaceAll("-", "")}`,
        name: "Synthetic Café",
        latitude: 48.1,
        longitude: 2.2,
      },
      sync: MEASURED,
    });
  });

  it("reports filed false when the lane's read-back says so", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env } = await hostStub(() => written({ id: SAVED_ID, filed: false, changed: [] }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "p1:c:1",
    });
    expect(res.body).toMatchObject({ filed: false, sync: "Nothing to change." });
  });

  it("files an already-saved place found by query, by its id", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(sent(seen)).toEqual([
      { method: "maps.fileInGuide", params: { guide: "Synthetic guide", placeId: SAVED_ID } },
    ]);
  });

  it("saves and files a new place in one call, from a donor", async () => {
    const path = emptyStore();
    exec(path, recent(1, 1, 48.1, 2.2, RECENT_ID));
    const { env, seen } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      query: "Synthetic Café",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(sent(seen)).toEqual([
      {
        method: "maps.fileInGuide",
        params: {
          guide: "Synthetic guide",
          source: "recent",
          sourceId: RECENT_ID,
          query: "Synthetic Café",
          near: { latitude: 48.1, longitude: 2.2 },
        },
      },
    ]);
    expect(res.body.filed).toBe(true);
    expect(res.body.recentsNote).toBeUndefined();
  });

  it("carries the Recents note when it seeded", async () => {
    const path = emptyStore();
    const { env } = await hostStub(saves);
    const c = await connect({
      writes: true,
      lane: env,
      storePath: path,
      openUrl: seedsAt(path, 48.1, 2.2, []),
    });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      query: "Synthetic Café",
    });
    expect(res.body.recentsNote).toMatch(/Recents/);
  });

  it("refuses both forms, or neither, as invalid without calling the lane", async () => {
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env });
    const both = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "p1:c:1",
      query: "Synthetic Café",
    });
    expect(both.isError).toBe(true);
    expect(both.body.details).toMatchObject({ reason: "invalid" });
    const neither = await call(c, "apple_maps_add_place_to_guide", { guide: "Synthetic guide" });
    expect(neither.isError).toBe(true);
    expect(neither.body.details).toMatchObject({ reason: "invalid" });
    const refWithCoords = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "p1:c:1",
      latitude: 48.1,
      longitude: 2.2,
    });
    expect(refWithCoords.isError).toBe(true);
    expect(refWithCoords.body.details).toMatchObject({ reason: "invalid" });
    expect(connections()).toBe(0);
  });

  it("refuses a query with half a coordinate as invalid, without asking Maps", async () => {
    const { env, connections } = await hostStub(saves);
    // failIfCalled is the openUrl: a seed would throw, not refuse.
    const c = await connect({ writes: true, lane: env });
    // The same rule on the other two tools that take a query, for one meaning of a coordinate.
    for (const [name, extra] of [
      ["apple_maps_add_place_to_guide", { guide: "Synthetic guide" }],
      ["apple_maps_add_favorite", {}],
      ["apple_maps_save_place", {}],
    ] as const) {
      for (const half of [{ latitude: 48.1 }, { longitude: 2.2 }]) {
        const res = await call(c, name, { ...extra, query: "Synthetic Café", ...half });
        expect(res.isError, `${name} ${JSON.stringify(half)}`).toBe(true);
        expect(res.body.error).toMatch(/both latitude and longitude, or neither/);
        expect(res.body.details).toMatchObject({ reason: "invalid" });
      }
    }
    expect(connections()).toBe(0);
  });

  it("refuses a pk-only ref with no identifier as notFound", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", null));
    const { env, connections } = await hostStub(saves);
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "p1:c:1",
    });
    expect(res.isError).toBe(true);
    expect(res.body.details).toMatchObject({ reason: "notFound" });
    expect(connections()).toBe(0);
  });

  it("refuses an answer to fileInGuide with no filed", async () => {
    const path = emptyStore();
    exec(path, savedPlace(1, 48.1, 2.2, "Synthetic Café", SAVED_ID));
    const { env } = await hostStub(() => written({ id: SAVED_ID }));
    const c = await connect({ writes: true, lane: env, storePath: path });
    const res = await call(c, "apple_maps_add_place_to_guide", {
      guide: "Synthetic guide",
      ref: "p1:c:1",
    });
    expect(res.isError).toBe(true);
    expect(res.body.details).toMatchObject({ reason: "protocol" });
  });
});

// ── diagnostics ──────────────────────────────────────────────────────────────

describe("diagnostics", () => {
  type Lanes = {
    writeLane: unknown;
    writes: { route: string; tools: string[] };
  } & Record<string, unknown>;
  const lanesOf = async (c: Client) =>
    (await call(c, "apple_maps_diagnostics", {})).body.lanes as Lanes;

  it("reports writeLane null, no route and no tools without the host", async () => {
    const lanes = await lanesOf(await connect({ writes: true, lane: null }));
    expect(lanes.writeLane).toBeNull();
    expect(lanes.writes.route).toBe("not hosted");
    expect(lanes.writes.tools).toEqual([]);
    expect(lanes.writeLaneNote).toMatch(/need the app/);
    // No retired route is described as if it ran.
    expect(JSON.stringify(lanes)).not.toMatch(/\bSQL\b|Accessibility|client\/write\.ts/);
  });

  it("reports the lane's status and the store route when hosted", async () => {
    const { env } = await hostStub(saves);
    const lanes = await lanesOf(await connect({ writes: true, lane: env }));
    expect(lanes.writeLane).toEqual(STATUS);
    expect(lanes.writes.route).toBe("store lane");
    expect(lanes.writes.tools).toEqual([...STORE_WRITE_TOOLS]);
    // The lane seeds by name alone, with no coordinate in the URL; the text must say so.
    const writes = lanes.writes as unknown as Record<string, string>;
    expect(writes.seeding).toContain("maps://?q=<query>");
    expect(writes.seeding).not.toContain("&ll=");
    expect(writes.blastRadius).toMatch(/Maps' own model/);
    expect(writes.blastRadius).not.toMatch(/client\/write\.ts/);
    // Measured 2026-11-11, and only for the model whose syncMeasured is true.
    expect(writes.blastRadius).toMatch(/syncMeasured is true/);
    expect(writes.blastRadius).toMatch(/a Mac and an iPhone on 2026-11-11, one with Maps quit/);
    expect(writes.blastRadius).not.toMatch(/every device/);
  });

  it("reports a lane that cannot answer as an error, not a failure", async () => {
    const { env } = await hostStub(() => ({
      error: {
        code: -32000,
        message: "writes are off in Cupertino",
        data: { reason: "writesOff" },
      },
    }));
    const res = await call(
      await connect({ writes: true, lane: env }),
      "apple_maps_diagnostics",
      {},
    );
    expect(res.isError).toBe(false);
    expect((res.body.lanes as Lanes).writeLane).toEqual({
      error: "Maps: writes are off in Cupertino",
    });
  });

  it("reports no tools with writes off, hosted or not", async () => {
    const { env } = await hostStub(saves);
    const lanes = await lanesOf(await connect({ writes: false, lane: env }));
    expect(lanes.writes.tools).toEqual([]);
    expect(lanes.writes.route).toBe("off");
    const npm = await lanesOf(await connect({ writes: false, lane: null }));
    expect(npm.writes.tools).toEqual([]);
    expect(npm.writes.route).toBe("off");
  });
});
