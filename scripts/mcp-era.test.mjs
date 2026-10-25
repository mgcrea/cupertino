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
// sent to Notes, and neither reaches a handler. The watch tests at the end
// spawn Mail instead, against a temp index; see there.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
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

// ── Incoming watches, end to end ─────────────────────────────────────────────
//
// The one push a server makes, over real stdio in both eras: Mail's built
// `dist/cli.js` with watches on, a watch set by tool call, a subscription by
// the era's own method, and a row inserted into the index underneath it.
//
// Nothing real is touched. The index is a temp file built from the captured
// DDL, as packages/mail's tests build theirs. `osascript` is a stub that answers
// the one script a watch sends (the account listing) with a canned account, so
// the mailbox map loads whether or not Mail is running here; the watch names no
// `mailboxes`, so it never asks Mail to resolve one. `HOME` and the mail root
// point nowhere, as above. Arrival is detected by the server's own file trigger.

const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";
const ACCOUNT = {
  id: UUID,
  name: "iCloud",
  enabled: true,
  accountType: "iCloud",
  emailAddresses: ["me@icloud.com"],
  fullName: "Me",
  directory: null,
  messageCaching: null,
  mailboxes: ["INBOX"],
};

/** A temp dir holding a seeded `Envelope Index` and a stub `osascript`. */
const mailFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-era-watch-"));
  const index = join(dir, "Envelope Index");
  const db = new DatabaseSync(index);
  db.exec(
    readFileSync(join(root, "packages", "mail", "test", "fixtures", "envelope-index.sql"), "utf8"),
  );
  db.exec(`
    INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (1, 'imap://${UUID}/INBOX', 0, 0);
    INSERT INTO subjects (ROWID, subject) VALUES (1, 'Quote');
    INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'jo@acme.com', 'Jo');
  `);
  const arrive = (rowid) =>
    db.exec(`
      INSERT INTO messages
        (ROWID, message_id, global_message_id, sender, subject_prefix, subject, date_sent, date_received,
         mailbox, flags, read, flagged, deleted, size, conversation_id)
      VALUES (${rowid}, 0, ${rowid + 7000}, 1, NULL, 1, 1790000000, 1790000005, 1, 0, 0, 0, 0, 100, 900);
    `);
  arrive(101);
  // Reads the script on stdin like osascript, and answers the account listing
  // with the canned account; any other script gets an empty list. The shebang
  // names this node by path: the runner does not pass the caller's PATH on.
  const osascript = join(dir, "osascript");
  writeFileSync(
    osascript,
    `#!${process.execPath}
let script = "";
process.stdin.on("data", (c) => (script += c));
process.stdin.on("end", () => {
  const data = script.includes("a.emailAddresses()") ? ${JSON.stringify([ACCOUNT])} : [];
  process.stdout.write(JSON.stringify({ ok: true, data }));
});
`,
  );
  chmodSync(osascript, 0o755);
  return {
    index,
    osascript,
    arrive,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const mailEnv = (fx) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("APPLE_") && !k.startsWith("CUPERTINO_")) env[k] = v;
  }
  env.HOME = join(NOWHERE, "home");
  env.APPLE_MAIL_ALLOW_WRITES = "0";
  env.APPLE_MAIL_ALLOW_WATCHES = "1";
  env.APPLE_MAIL_ROOT = join(NOWHERE, "mail");
  env.APPLE_MAIL_ENVELOPE_INDEX = fx.index;
  env.APPLE_MAIL_OSASCRIPT_PATH = fx.osascript;
  return env;
};

/**
 * A spawned server and every line it writes: `request` resolves with the
 * response to its id, `next` with the first message a predicate accepts, seen
 * already or still to come.
 */
const session = (env, era) => {
  const child = spawn("node", [join(root, "packages", "mail", "dist", "cli.js")], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const seen = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    seen.push(msg);
    for (const w of waiters.filter((x) => x.match(msg))) {
      waiters.splice(waiters.indexOf(w), 1);
      w.ok(msg);
    }
  });
  const meta =
    era === "modern"
      ? {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "era-test", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        }
      : undefined;
  const write = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  const next = (match, what, ms = 10_000) =>
    new Promise((ok, fail) => {
      const hit = seen.find(match);
      if (hit) return ok(hit);
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), ms);
      waiters.push({
        match,
        ok: (msg) => {
          clearTimeout(timer);
          ok(msg);
        },
      });
    });
  let id = 0;
  const request = (method, params = {}) => {
    const rid = `r${++id}`;
    write({ id: rid, method, params: meta ? { ...params, _meta: meta } : params });
    return next((m) => m.id === rid && ("result" in m || "error" in m), `a response to ${method}`);
  };
  return { child, seen, write, next, request, meta };
};

const callJson = async (s, name, args) => {
  const res = await s.request("tools/call", { name, arguments: args });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
  return JSON.parse(res.result.content[0].text);
};

const updatedFor = (uri) => (m) =>
  m.method === "notifications/resources/updated" && m.params?.uri === uri;

test("modern: subscriptions/listen on a watch is pushed an update when matching mail arrives", async () => {
  const fx = mailFixture();
  const s = session(mailEnv(fx), "modern");
  try {
    const made = await callJson(s, "apple_mail_watch", { domains: ["acme.com"] });
    assert.match(made.uri, /^cupertino:\/\/mail\/watch\/w_/);
    s.write({
      id: "listen-1",
      method: "subscriptions/listen",
      params: { notifications: { resourceSubscriptions: [made.uri] }, _meta: s.meta },
    });
    await s.next(
      (m) => m.method === "notifications/subscriptions/acknowledged",
      "the subscription to be acknowledged",
    );
    fx.arrive(102);
    const pushed = await s.next(updatedFor(made.uri), "notifications/resources/updated");
    const { _meta: tags } = pushed.params;
    assert.ok(
      tags?.["io.modelcontextprotocol/subscriptionId"] !== undefined,
      `tagged with its subscription: ${JSON.stringify(pushed)}`,
    );
    const read = await s.request("resources/read", { uri: made.uri });
    const body = JSON.parse(read.result.contents[0].text);
    assert.equal(body.watch, made.watch);
    assert.deepEqual(
      body.messages.map((m) => [m.senderAddress, m.subject]),
      [["jo@acme.com", "Quote"]],
    );
  } finally {
    s.child.kill();
    fx.close();
  }
});

test("legacy: resources/subscribe on a watch is sent an update when matching mail arrives", async () => {
  const fx = mailFixture();
  const s = session(mailEnv(fx), "legacy");
  try {
    const init = await s.request("initialize", initialize[2]);
    assert.equal(init.error, undefined);
    s.write({ method: "notifications/initialized" });
    const made = await callJson(s, "apple_mail_watch", { from: ["jo@acme.com"] });
    const sub = await s.request("resources/subscribe", { uri: made.uri });
    assert.equal(sub.error, undefined, JSON.stringify(sub.error));
    fx.arrive(102);
    const pushed = await s.next(updatedFor(made.uri), "notifications/resources/updated");
    assert.equal(pushed.params.uri, made.uri);
  } finally {
    s.child.kill();
    fx.close();
  }
});
