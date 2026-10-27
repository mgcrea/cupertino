#!/usr/bin/env node
// Spike: does SDK v2 (@modelcontextprotocol/server 2.4.0) hold a long-lived
// custom request open over stdio? Throwaway; the answers live in
// docs/superpowers/reports/2026-10-27-mcp-events-field-report.md.
//
// Usage: node scripts/spike-events-stream.mjs
//
// The script plays both roles. With no argument it is the client: it spawns
// itself with `--server`, opens a modern-era (2026-07-28) connection the way
// `session()` in scripts/mcp-era.test.mjs does (per-request `_meta`, no
// `initialize`), and runs two probes.
//
//   1. One `events/stream`, held 5 s, then `notifications/cancelled`. Records
//      whether the request stays open, whether the handler's heartbeats reach
//      stdout, and whether the cancel aborts `ctx.mcpReq.signal`.
//   2. Eleven streams at once, held 3 s, then all cancelled. Records whether any
//      request timeout or cap ended one early. It confirms the SDK refuses
//      nothing: all eleven stay open.
//
// The server registers `events/stream` through the three-argument
// `setRequestHandler(method, { params, result }, handler)`. The handler sends
// `notifications/events/active`, then a `notifications/events/heartbeat` per
// second, every frame stamped with `_meta["io.modelcontextprotocol/subscriptionId"]`
// set to the request id, and resolves only when the request's signal aborts.
// The server reports what it saw on stderr as `SPIKE ...` lines, which the
// client reads and prints.
//
// ## Resolving the SDK
//
// Nothing is installed at the repo root, only per package, so a bare
// `import "@modelcontextprotocol/server"` from scripts/ would not resolve.
// `createRequire` anchored at packages/core/package.json finds it (and zod) the
// way packages/core does; the import then goes by file URL. Run `pnpm install`
// first. No build is needed: this uses the SDK, not Cupertino's dist.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const fromCore = createRequire(join(root, "packages", "core", "package.json"));
const load = (name) => import(pathToFileURL(fromCore.resolve(name)).href);

const MODERN = "2026-07-28";
// Probe 1 holds 5 s; SPIKE_HOLD_MS=70000 re-runs it past the SDK's 60 s default timeout.
const HOLD_MS = Number(process.env.SPIKE_HOLD_MS ?? 5000);
const SUB = "io.modelcontextprotocol/subscriptionId";

const say = (line) => process.stderr.write(`SPIKE ${line}\n`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const count = (list, method) => list.filter((m) => m.method === method).length;
// The subscription id a frame is stamped with, if any. Destructured because the
// repo's lint rejects `._meta` member access (see scripts/mcp-era.test.mjs).
const subscriptionOf = (msg) => {
  const { _meta: tags } = msg.params ?? {};
  return tags?.[SUB];
};

// ---------------------------------------------------------------- server ---

const serve = async () => {
  const { McpServer } = await load("@modelcontextprotocol/server");
  const { serveStdio } = await load("@modelcontextprotocol/server/stdio");
  const { z } = await load("zod");

  serveStdio(
    () => {
      const server = new McpServer({ name: "spike-events", version: "0" }, { capabilities: {} });
      server.server.setRequestHandler(
        "events/stream",
        { params: z.looseObject({}), result: z.looseObject({}) },
        async (_params, ctx) => {
          const id = ctx.mcpReq.id;
          const signal = ctx.mcpReq.signal;
          const frame = (method, extra = {}) =>
            ctx.mcpReq.notify({ method, params: { ...extra, _meta: { [SUB]: id } } });
          say(`open id=${id}`);
          await frame("notifications/events/active", { cursor: "v1.0-0.0" });
          let beats = 0;
          const timer = setInterval(() => {
            beats += 1;
            frame("notifications/events/heartbeat").catch((e) => say(`heartbeat failed id=${id} ${e}`));
          }, 1000);
          await new Promise((done) => {
            if (signal.aborted) return done();
            signal.addEventListener("abort", done, { once: true });
          });
          clearInterval(timer);
          say(`aborted id=${id} after ${beats} heartbeats`);
          return {};
        },
      );
      return server;
    },
    { onerror: (e) => say(`onerror ${e?.message ?? e}`) },
  );
};

// ---------------------------------------------------------------- client ---

const client = async () => {
  const child = spawn("node", [fileURLToPath(import.meta.url), "--server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = []; // every stdout line, parsed, with its arrival time
  const serverLog = [];
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(1);
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      frames.push({ t: Date.now(), msg: JSON.parse(line) });
    } catch {
      console.error(`[spike] non-JSON line on server stdout: ${line}`);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => {
    if (line.startsWith("SPIKE ")) serverLog.push(line.slice(6));
    else if (process.env.SPIKE_VERBOSE) console.error(`[server] ${line}`);
  });
  const exited = new Promise((ok) => child.once("exit", (code) => ok(code)));

  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "spike", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const write = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const open = (id) => write({ id, method: "events/stream", params: { _meta: meta } });
  const cancel = (id) =>
    write({ method: "notifications/cancelled", params: { requestId: id, reason: "spike done", _meta: meta } });
  const forId = (id) => frames.filter((f) => subscriptionOf(f.msg) === id).map((f) => f.msg);
  const response = (id) => frames.find((f) => f.msg.id === id && ("result" in f.msg || "error" in f.msg))?.msg;

  // Warm-up: the first request pins the era. `tools/list` answers -32601 (no tools
  // registered), which is fine: the era is pinned either way.
  write({ id: "warm", method: "tools/list", params: { _meta: meta } });
  for (let i = 0; i < 50 && !response("warm"); i++) await sleep(100);
  console.log(`[${at()}s] warm-up tools/list ->`, JSON.stringify(response("warm") ?? "NO RESPONSE").slice(0, 160));

  // Probe 1: one stream, 5 s, then cancel.
  console.log(`\n== Probe 1: one stream held ${HOLD_MS / 1000} s, then cancelled`);
  open("s1");
  await sleep(HOLD_MS);
  const mid = forId("s1");
  console.log(`[${at()}s] after hold: response=${JSON.stringify(response("s1") ?? null)} ` +
    `active=${count(mid, "notifications/events/active")} heartbeats=${count(mid, "notifications/events/heartbeat")}`);
  console.log(`            sample frame: ${JSON.stringify(mid[1] ?? mid[0] ?? null)}`);
  const beforeCancel = frames.length;
  cancel("s1");
  await sleep(1000);
  const after = frames.slice(beforeCancel).filter((f) => subscriptionOf(f.msg) === "s1");
  console.log(`[${at()}s] after cancel: response=${JSON.stringify(response("s1") ?? null)} ` +
    `frames for s1 still arriving=${after.length}`);

  // Probe 2: eleven streams.
  console.log(`\n== Probe 2: eleven concurrent streams held 3 s, then cancelled`);
  const ids = Array.from({ length: 11 }, (_, i) => `c${i + 1}`);
  for (const id of ids) open(id);
  await sleep(3000);
  for (const id of ids) {
    const list = forId(id);
    const r = response(id);
    console.log(`[${at()}s] ${id}: active=${count(list, "notifications/events/active")} ` +
      `heartbeats=${count(list, "notifications/events/heartbeat")} response=${JSON.stringify(r ?? null)}`);
  }
  for (const id of ids) cancel(id);
  await sleep(1000);
  console.log(`[${at()}s] responses after cancel: ` +
    ids.map((id) => `${id}=${JSON.stringify(response(id) ?? null)}`).join(" "));

  console.log(`\n== Server log (stderr SPIKE lines)`);
  for (const l of serverLog) console.log(`  ${l}`);

  child.stdin.end();
  const killer = setTimeout(() => child.kill(), 2000);
  await exited;
  clearTimeout(killer);
};

if (process.argv.includes("--server")) await serve();
else await client();
