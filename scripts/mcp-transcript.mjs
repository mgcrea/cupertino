#!/usr/bin/env node
// Record one surface's MCP conversation as normalised JSONL, for diffing.
//
// Usage: node scripts/mcp-transcript.mjs <surface> [--writes] [--root <dir>]
//          [--env KEY=VALUE]... > out.jsonl
//
// The SDK migration changes what a server says on the wire only if we let it,
// and "we did not let it" needs evidence. Run this against the old build and
// the new one and diff the files: an empty diff is the proof a legacy-era
// client sees no difference.
//
// ## What is sent, and what is not
//
// `initialize`, `tools/list`, `resources/list`, the static guide, an unknown
// URI, and one `tools/call` that fails argument validation (`{}` against a
// tool with a required argument, so it is rejected before any handler runs).
// Nothing here may reach an Apple app or the user's data: no Apple Events, no
// store reads, nothing that raises a macOS permission prompt. That rules out
// any call that gets as far as a handler, and is why the one call is built to
// fail.
//
// This covers the requests, not the server's own startup. Some surfaces open
// their store while booting (their `cli.ts` calls `client.status()` before
// connecting), which no request choice can avoid. Check a surface's startup
// before recording it, or pass `--env APPLE_<SURFACE>_INDEX_MODE=off`.
//
// ## Environment
//
// The child gets the caller's environment minus every `APPLE_*` and
// `CUPERTINO_*` variable, so a shell's `APPLE_NOTES_ACCOUNTS`, `*_STORE`,
// `*_OSASCRIPT_PATH` or a `CUPERTINO_AX_SOCKET` pointing at the running app
// cannot change the transcript or reach real data. Then only
// `APPLE_<SURFACE>_ALLOW_WRITES` is set, plus each `--env KEY=VALUE` given.
//
// ## Normalisation
//
// Keys are sorted and `serverInfo.version` is dropped, so a version bump does
// not drown the diff. Every line the server writes to stdout is recorded in
// arrival order: a response is `{request, response}`; anything else, whether
// a notification, a server-initiated request, a response to nothing we sent
// or a line that is not JSON at all, is `{unsolicited}`. A build that leaked a
// banner or sent an extra notification therefore shows up in the diff.
//
// `--root` points at another checkout (a throwaway worktree holding the
// migrated build) so both eras can be recorded from one script.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const usage = "usage: mcp-transcript.mjs <surface> [--writes] [--root <dir>] [--env KEY=VALUE]...";

let writes = false;
let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extraEnv = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--writes") {
    writes = true;
  } else if (a === "--root") {
    i += 1;
    if (argv[i] === undefined) {
      console.error(usage);
      process.exit(2);
    }
    root = resolve(argv[i]);
  } else if (a === "--env") {
    i += 1;
    const eq = argv[i]?.indexOf("=") ?? -1;
    if (eq < 1) {
      console.error(usage);
      process.exit(2);
    }
    extraEnv[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
  } else if (a.startsWith("--")) {
    console.error(usage);
    process.exit(2);
  } else {
    positional.push(a);
  }
}
const surface = positional[0];
if (!surface || positional.length > 1) {
  console.error(usage);
  process.exit(2);
}

// A tool with a required argument, per surface. The call is `{}`, so it fails
// validation whichever it is.
const TOOL = {
  notes: "apple_notes_get_note",
  messages: "apple_messages_get_message",
  safari: "apple_safari_get_page",
  mail: "apple_mail_get_message",
  maps: "apple_maps_get_place",
  contacts: "apple_contacts_get_contact",
  reminders: "apple_reminders_get_reminder",
  calendar: "apple_calendar_get_event",
};
const tool = TOOL[surface] ?? `apple_${surface}_get_item`;

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("APPLE_") && !k.startsWith("CUPERTINO_")) env[k] = v;
}
env[`APPLE_${surface.toUpperCase()}_ALLOW_WRITES`] = writes ? "1" : "0";
Object.assign(env, extraEnv);

const requests = [
  {
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "transcript", version: "0" },
    },
  },
  { notification: "notifications/initialized" },
  { method: "tools/list" },
  { method: "resources/list" },
  { method: "resources/read", params: { uri: `cupertino://${surface}/guide` } },
  { method: "resources/read", params: { uri: `cupertino://${surface}/nope` } },
  { method: "tools/call", params: { name: tool, arguments: {} } },
];

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .toSorted()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
};

const emit = (record) => process.stdout.write(`${JSON.stringify(sortKeys(record))}\n`);

const child = spawn("node", [join(root, "packages", surface, "dist", "cli.js")], {
  env,
  stdio: ["pipe", "pipe", "ignore"],
});
child.on("error", (err) => {
  console.error(`spawn failed: ${err.message}`);
  process.exit(1);
});

// id -> {method, resolve} for the requests we sent and have not seen answered.
const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emit({ unsolicited: { unparseable: line } });
    return;
  }
  const ours = msg && typeof msg === "object" && !msg.method ? waiting.get(msg.id) : undefined;
  if (!ours) {
    emit({ unsolicited: msg });
    return;
  }
  waiting.delete(msg.id);
  if (ours.method === "initialize" && msg.result?.serverInfo) delete msg.result.serverInfo.version;
  emit({ request: ours.method, response: msg });
  ours.resolve();
});

const timeout = setTimeout(() => {
  console.error("timed out waiting for the server");
  child.kill();
  process.exit(1);
}, 30_000);

let id = 0;
for (const req of requests) {
  if (req.notification) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: req.notification })}\n`);
    continue;
  }
  const mine = ++id;
  const answered = new Promise((ok) => waiting.set(mine, { method: req.method, resolve: ok }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, ...req })}\n`);
  await answered;
}

// Let anything the server sends after its last response land before we hang up.
await sleep(300);
clearTimeout(timeout);
child.kill();
process.exit(0);
