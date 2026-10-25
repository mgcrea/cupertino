// Tests that a built npm surface speaks both MCP eras over real stdio.
//
// `InMemoryTransport` only connects 2025-era instances, so the 2026-07-28 side
// can only be tested against a spawned `dist/cli.js`. Notes stands in for all
// eight: they share `runStdioServer`, which owns the era decision.
//
// Needs `pnpm build` first, like `mcp-transcript.mjs`. The child gets the same
// isolation that script uses: no `APPLE_*` or `CUPERTINO_*` from the caller, a
// store and `HOME` that do not exist, and an osascript that cannot spawn, so no
// real store or app is touched. Only `initialize` and `server/discover` are
// sent, and neither reaches a handler.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOWHERE = join(tmpdir(), "mcp-era-nonexistent");

const isolatedEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("APPLE_") && !k.startsWith("CUPERTINO_")) env[k] = v;
  }
  env.APPLE_NOTES_ALLOW_WRITES = "0";
  env.HOME = join(NOWHERE, "home");
  env.APPLE_NOTES_OSASCRIPT_PATH = join(NOWHERE, "osascript");
  env.APPLE_NOTES_STORE = join(NOWHERE, "notes", "NoteStore.sqlite");
  return env;
};

// Spawn the server, send each request in turn, and return the responses by id.
const converse = async (requests) => {
  const child = spawn("node", [join(root, "packages", "notes", "dist", "cli.js")], {
    env: isolatedEnv(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  const timeout = setTimeout(() => child.kill(), 20_000);
  try {
    const responses = {};
    for (const [id, method, params] of requests) {
      const answered = new Promise((ok) => {
        waiting.set(id, ok);
        child.once("exit", () => ok({ error: "server exited before answering" }));
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      responses[id] = await answered;
    }
    return responses;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
};

const MODERN = "2026-07-28";
const discover = [
  1,
  "server/discover",
  {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "era-test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
];
const initialize = [
  2,
  "initialize",
  {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "era-test", version: "0" },
  },
];

const assertDiscovered = (res) => {
  assert.equal(res.error, undefined);
  assert.ok(res.result.supportedVersions.includes(MODERN), "lists 2026-07-28");
  assert.ok(res.result.capabilities.tools, "advertises tools");
};

const assertInitialized = (res) => {
  assert.equal(res.error, undefined);
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.ok(res.result.serverInfo.name, "names itself");
};

test("server/discover answers with the 2026-07-28 revision", async () => {
  assertDiscovered((await converse([discover]))[1]);
});

test("a fresh process answers initialize as before", async () => {
  assertInitialized((await converse([initialize]))[2]);
});

test("initialize after server/discover still answers, the probe instance is discarded", async () => {
  const res = await converse([discover, initialize]);
  assertDiscovered(res[1]);
  assertInitialized(res[2]);
});

test("a server that cannot start exits non-zero and says why", async () => {
  const child = spawn("node", [join(root, "packages", "notes", "dist", "cli.js")], {
    env: { ...isolatedEnv(), APPLE_NOTES_MAX_RESULTS: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timeout = setTimeout(() => child.kill(), 20_000);
  const exited = new Promise((ok) => child.once("exit", (code) => ok(code)));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: initialize[1], params: initialize[2] })}\n`,
  );
  const code = await exited;
  clearTimeout(timeout);
  assert.equal(code, 1);
  assert.match(stderr, /Invalid configuration/);
});
