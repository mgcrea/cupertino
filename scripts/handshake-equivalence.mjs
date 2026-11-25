#!/usr/bin/env node
// Prove a cached handshake answer does not depend on what its key leaves out.
//
// Usage: node scripts/handshake-equivalence.mjs
//        HANDSHAKE_SERVERS_DIR=apps/apple/.build/staged/servers node scripts/handshake-equivalence.mjs
//
// Cupertino.app answers a session's handshake and list calls from
// `HandshakeCache` (apps/apple/Cupertino/HandshakeCache.swift) instead of
// starting a node server. A key holds the surface, the app build, the node and
// script paths, the whole spawn environment, the session's handshake (method
// plus params, keys sorted, `_meta.progressToken` dropped), the method and the
// request's params (canonicalised the same way). The value is node's whole
// response frame, with only the id swapped in.
//
// The design's one way to be wrong is under-keying: an answer that depends on
// something the key leaves out. Comparing two identical servers proves
// nothing, so each run here is a variant that differs from the others ONLY in
// what the key leaves out:
//
// - the request ids: small numbers, strings, large numbers;
// - the order of the list calls, with `tools/list` sent twice in some;
// - the `_meta.progressToken` values;
// - the order of keys inside every params object.
//
// Everything the key does hold is the same across variants: the same script,
// the same node, the same environment, the same handshake. For every
// answerable method, the response frames must be byte-identical across
// variants once the id is normalised. The id is normalised the way
// `CachedReply` cuts it: the frame must end in `"id":<id as sent>}`, and a
// frame that does not is a failure, because the cache would refuse it.
//
// One case must DIFFER: `mail` `tools/list` with writes on against writes off.
// It proves the comparison can see a difference at all.
//
// The environment is exactly what `ServerLocator.environment` gives by
// default: PATH and the real HOME, plus `<envPrefix>ALLOW_WRITES=1` with writes
// on. No AX socket variables. The servers boot as they would under the app;
// the agent shell has no Full Disk Access, so a store a server opens at boot
// is refused rather than read, and no request here reaches a tool handler.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_DIR = process.env.HANDSHAKE_SERVERS_DIR
  ? resolve(process.env.HANDSHAKE_SERVERS_DIR)
  : join(ROOT, "packages");
const HOME = process.env.HOME;
const DEADLINE_MS = 10_000;

const { surfaces } = JSON.parse(readFileSync(join(ROOT, "surfaces.json"), "utf8"));
const NODE_SURFACES = surfaces.filter((s) => s.runtime === "node");

// From packages/core/test/event-handlers.test.ts.
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const LISTS = ["tools/list", "prompts/list", "resources/list", "resources/templates/list"];

// Reverse the key order of every object, recursively. The key sorts its
// params, so a server must not answer differently to the same params written
// in another order.
const reverseKeys = (v) => {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .toReversed()
        .map((k) => [k, reverseKeys(v[k])]),
    );
  }
  return v;
};

const VARIANTS = [
  {
    name: "numeric ids",
    id: (n) => n,
    order: LISTS,
    discoverAt: 0,
    token: 1,
    keys: (v) => v,
  },
  {
    name: "string ids, reordered, tools/list twice",
    id: (n) => `req-${n}`,
    order: [
      "resources/templates/list",
      "tools/list",
      "resources/list",
      "prompts/list",
      "tools/list",
    ],
    discoverAt: 2,
    token: "tok-b",
    keys: reverseKeys,
  },
  {
    name: "large ids, reversed, tools/list twice",
    id: (n) => 9_000_000 + n * 7,
    order: ["tools/list", ...LISTS.toReversed()],
    discoverAt: 5,
    token: "progress-c-0123456789",
    keys: reverseKeys,
  },
];

// The steps one variant sends in one era. A step is a request, or a
// notification (no id, no answer).
const stepsFor = (variant, era) => {
  if (era === "legacy") {
    return [
      {
        method: "initialize",
        params: {
          _meta: { progressToken: variant.token },
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "handshake-check", version: "0" },
        },
      },
      { notification: "notifications/initialized" },
      ...variant.order.map((method) => ({
        method,
        params: { _meta: { progressToken: variant.token } },
      })),
    ];
  }
  const methods = [...variant.order];
  methods.splice(Math.min(variant.discoverAt, methods.length), 0, "server/discover");
  return methods.map((method) => ({
    method,
    params: { _meta: { ...ENVELOPE, progressToken: variant.token } },
  }));
};

class CheckFailure extends Error {}

// The one error answer expected: voice-memos registers no prompts, so it does
// not advertise the prompts capability and `prompts/list` there is an
// unadvertised method. Every other error answer fails the check.
const isExpectedError = (surface, method, error) =>
  surface === "voice-memos" && method === "prompts/list" && error?.code === -32601;

const label = (surface, writes, era, method) =>
  `${surface} ${writes ? "writes-on" : "writes-off"} ${era}${method ? ` ${method}` : ""}`;

// Run one variant against a fresh server. Returns [{method, frame}] in the
// order sent, each frame with its id normalised.
const runVariant = async (surface, script, env, writes, era, variant) => {
  const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  // A write to a server that already died raises EPIPE here; the exit handler
  // below is what reports it, naming the method.
  child.stdin.on("error", () => {});
  let exited = null;
  const waiting = new Map();
  const fail = (method, why) =>
    new CheckFailure(
      `FAIL ${label(surface, writes, era, method)} (${variant.name}): ${why}` +
        (stderr.trim()
          ? `\n  stderr: ${stderr.trim().split("\n").slice(-5).join("\n          ")}`
          : ""),
    );
  child.on("error", (err) => {
    exited = `spawn failed: ${err.message}`;
    for (const w of waiting.values()) w.reject(exited);
  });
  child.on("exit", (code, signal) => {
    exited = `server exited (${signal ?? code})`;
    for (const w of waiting.values()) w.reject(exited);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || "method" in msg) return;
    const key = JSON.stringify(msg.id);
    const w = waiting.get(key);
    if (!w) return;
    waiting.delete(key);
    w.resolve(line);
  });

  const out = [];
  try {
    let n = 0;
    for (const step of stepsFor(variant, era)) {
      if (step.notification) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: step.notification })}\n`);
        continue;
      }
      n += 1;
      const id = variant.id(n);
      const idText = JSON.stringify(id);
      const answered = new Promise((ok, no) => {
        if (exited) no(exited);
        waiting.set(idText, { resolve: ok, reject: no });
      });
      const timer = setTimeout(
        () => waiting.get(idText)?.reject(`no answer in ${DEADLINE_MS / 1000} s`),
        DEADLINE_MS,
      );
      const request = {
        jsonrpc: "2.0",
        id,
        method: step.method,
        params: step.params,
      };
      child.stdin.write(`${JSON.stringify(variant.keys(request))}\n`);
      let line;
      try {
        line = await answered;
      } catch (why) {
        throw fail(step.method, why);
      } finally {
        clearTimeout(timer);
      }
      const suffix = `"id":${idText}}`;
      const msg = JSON.parse(line);
      // An error answer passes only where it is expected, so a server that
      // refuses the envelope, fails to start its tools, or loses a method
      // cannot pass by answering every variant with the same error.
      if ("error" in msg && !isExpectedError(surface, step.method, msg.error)) {
        throw fail(step.method, `unexpected error answer:\n  ${line.slice(0, 300)}`);
      }
      if (line.endsWith(suffix)) {
        out.push({
          method: step.method,
          frame: `${line.slice(0, -suffix.length)}"id":<ID>}`,
          cacheable: true,
        });
        continue;
      }
      // The SDK writes an error as {"jsonrpc","id","error"}: the id is not last,
      // so `CachedReply` refuses it and the session starts a server instead.
      // Nothing is served from the cache, so nothing can be under-keyed; it is
      // still compared, and reported, because it costs a spawn. Any other shape
      // is a failure.
      const head = `{"jsonrpc":"2.0","id":${idText},"error":`;
      if (!("error" in msg) || "result" in msg || !line.startsWith(head)) {
        throw fail(
          step.method,
          `frame does not end in ${suffix}, so the cache would refuse it:\n  ${line.slice(0, 300)}`,
        );
      }
      out.push({
        method: step.method,
        frame: `{"jsonrpc":"2.0","id":<ID>,"error":${line.slice(head.length)}`,
        cacheable: false,
        error: msg.error,
      });
    }
  } finally {
    child.stdin.end();
    child.kill();
  }
  return out;
};

const firstDifference = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 80);
  return { at: i, a: a.slice(from, i + 120), b: b.slice(from, i + 120) };
};

const diffFailure = (what, left, right) => {
  const d = firstDifference(left.frame, right.frame);
  return new CheckFailure(
    `FAIL ${what}: frames differ at byte ${d.at}\n` +
      `  ${left.variant}:\n    …${d.a}…\n` +
      `  ${right.variant}:\n    …${d.b}…`,
  );
};

// Run every variant of one combination and assert each method's frames agree.
// Returns the first variant's frames by method, for the sensitivity case.
const checkCombination = async (surface, script, writes, era) => {
  const env = { PATH: "/usr/bin:/bin", HOME };
  if (writes) env[`${surface.envPrefix}ALLOW_WRITES`] = "1";
  const runs = await Promise.all(
    VARIANTS.map((variant) => runVariant(surface.id, script, env, writes, era, variant)),
  );
  const byMethod = new Map();
  runs.forEach((frames, i) => {
    for (const reply of frames) {
      if (!byMethod.has(reply.method)) byMethod.set(reply.method, []);
      byMethod.get(reply.method).push({ variant: VARIANTS[i].name, ...reply });
    }
  });
  const first = new Map();
  for (const [method, frames] of byMethod) {
    const [reference, ...rest] = frames;
    const other = rest.find((f) => f.frame !== reference.frame);
    if (other) throw diffFailure(label(surface.id, writes, era, method), reference, other);
    if (reference.cacheable) {
      console.log(`ok ${label(surface.id, writes, era, method)}`);
    } else {
      // Not a failure: the cache refuses this frame, so a session asking for
      // it starts a server, as it did before the cache existed.
      console.log(
        `uncacheable ${label(surface.id, writes, era, method)} (error ${reference.error.code} ${reference.error.message}; same across variants, a session asking starts a server)`,
      );
    }
    first.set(method, reference);
  }
  return first;
};

const main = async () => {
  if (!HOME) throw new CheckFailure("FAIL HOME is not set");
  let count = 0;
  let uncacheable = 0;
  const mailToolsList = {};
  for (const surface of NODE_SURFACES) {
    const script = join(SERVERS_DIR, surface.id, "dist", "cli.js");
    if (!existsSync(script)) {
      throw new CheckFailure(
        `FAIL ${surface.id}: no server at ${script} (run pnpm -r build first)`,
      );
    }
    for (const era of ["legacy", "modern"]) {
      for (const writes of [false, true]) {
        const frames = await checkCombination(surface, script, writes, era);
        for (const reply of frames.values()) {
          if (reply.cacheable) count += 1;
          else uncacheable += 1;
        }
        if (surface.id === "mail") {
          mailToolsList[`${era} ${writes}`] = frames.get("tools/list")?.frame;
        }
      }
    }
  }
  for (const era of ["legacy", "modern"]) {
    const off = mailToolsList[`${era} false`];
    const on = mailToolsList[`${era} true`];
    if (off === undefined || on === undefined || off === on) {
      throw new CheckFailure(
        `FAIL sensitivity mail ${era} tools/list: writes on and off answered the same, so the check cannot see a difference`,
      );
    }
    console.log(`differs (expected) mail ${era} tools/list writes-on vs writes-off`);
  }
  console.log(
    `handshake-check: ${count} ok, ${uncacheable} uncacheable, across ${NODE_SURFACES.length} surfaces`,
  );
};

try {
  await main();
} catch (err) {
  console.error(err instanceof CheckFailure ? err.message : err);
  process.exit(1);
}
