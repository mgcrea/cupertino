// Serves Mail's `mail.received` events over Streamable HTTP, for grading with the
// SEP-3415 conformance suite. Test-only: not shipped in any package.
//
// The suite (modelcontextprotocol/conformance#521, pinned at
// panyam/mcpconformance@23c7c2d) reaches a server only by URL, while Cupertino
// serves stdio. This puts Mail's own server factory behind the SDK's
// `createMcpHandler` on `http://127.0.0.1:<EVENTS_PORT>/mcp` (default 3917), so
// the suite grades the events code itself; only the HTTP layer is this file's.
//
// Nothing real is touched. The index is a temp `Envelope Index` built by
// lib/mail-fixture.mjs, `osascript` is its stub, the Mail root and `HOME` point
// nowhere, and writes are off. One matching message (`jo@acme.com`, received
// now) is inserted every 2 s, so the suite's occurrence checks, which wait about
// 6 s, always have an event to see. Run it with the suite told how to filter:
//
//   pnpm -C packages/core build && pnpm -C packages/mail build
//   node scripts/events-conformance.mjs
//   EVENTS_ARGUMENTS='{"mail.received":{"domains":["acme.com"]}}' \
//     npm start -- server --url http://127.0.0.1:3917/mcp --scenario events-poll
//
// `events-push` needs `--timeout 60000` or more. `EVENTS_GATE=0` serves the server
// with the events gate off, for the `-32601` fallback row of `events-discovery`.
// The results and their attribution are in
// docs/superpowers/reports/2026-10-27-mcp-events-field-report.md.
//
// Every HTTP request gets a fresh server instance (that is how `createMcpHandler`
// serves the 2026-07-28 era), so the 10-streams-per-connection cap, which counts
// per instance, is never reached here; it is graded by packages/core's tests.

import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { mailFixture } from "./lib/mail-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOWHERE = join(tmpdir(), "events-conformance-nonexistent");

/**
 * The ESM entry of a package as packages/mail resolves it. `require.resolve`
 * gives the CommonJS build, and Mail's dist imports the ESM one; a server built
 * from one and served by the other's handler would be two copies of the SDK.
 */
const fromMail = createRequire(join(root, "packages", "mail", "package.json"));
const esm = (name) => {
  let dir = dirname(fromMail.resolve(name));
  while (!dir.endsWith(join("node_modules", name))) dir = dirname(dir);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return import(pathToFileURL(join(dir, pkg.exports["."].import.default)).href);
};

const { createMcpHandler } = await esm("@modelcontextprotocol/server");
const mail = await import(pathToFileURL(join(root, "packages", "mail", "dist", "index.js")).href);

const fx = mailFixture("events-conformance-");
const config = mail.loadConfig({
  HOME: join(NOWHERE, "home"),
  APPLE_MAIL_ALLOW_WRITES: "0",
  APPLE_MAIL_ALLOW_EVENTS: process.env.EVENTS_GATE ?? "1",
  APPLE_MAIL_ROOT: join(NOWHERE, "mail"),
  APPLE_MAIL_ENVELOPE_INDEX: fx.index,
  APPLE_MAIL_OSASCRIPT_PATH: fx.osascript,
});

// The factory serves whichever era the request is in: a modern request gets the
// events extension, a 2025-era one gets none, as over stdio.
const handler = createMcpHandler((ctx) => mail.createServer({ config, era: ctx.era }).server, {
  // The SDK's own SSE keepalive is a `: keepalive` comment, which the SEP rules
  // out for an events stream; the stream's 25 s `heartbeat` data frame keeps it
  // alive instead, as it does over stdio.
  keepAliveMs: 0,
  onerror: (err) => console.error(`[events-conformance] ${err.message}`),
});

/** Hand a `node:http` request to the web-standard handler and stream its answer back. */
const serve = async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  // A client that hangs up (the suite closing a stream) aborts the exchange.
  const aborted = new AbortController();
  res.on("close", () => aborted.abort());
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers,
    signal: aborted.signal,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
  });
  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (res.destroyed) break;
    res.write(chunk);
  }
  res.end();
};

const port = Number(process.env.EVENTS_PORT ?? 3917);
const http = createHttpServer((req, res) => {
  serve(req, res).catch((err) => {
    console.error(`[events-conformance] ${err.stack ?? err}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
http.listen(port, "127.0.0.1", () => {
  console.error(`[events-conformance] http://127.0.0.1:${port}/mcp, index ${fx.index}`);
});

// Row 101 is the fixture's own; arrivals carry on from 102, received now.
let rowid = 101;
const inserter = setInterval(() => fx.arrive(++rowid, Math.floor(Date.now() / 1000)), 2_000);

const stop = () => {
  clearInterval(inserter);
  http.closeAllConnections();
  http.close();
  void handler.close().finally(() => {
    fx.close();
    process.exit(0);
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
