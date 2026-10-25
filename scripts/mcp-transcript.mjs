#!/usr/bin/env node
// Record one surface's MCP conversation as normalised JSONL, for diffing.
//
// Usage: node scripts/mcp-transcript.mjs <surface> [--writes] [--root <dir>] > out.jsonl
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
// ## Normalisation
//
// Keys are sorted and `serverInfo.version` is dropped, so a version bump does
// not drown the diff. Responses are emitted in request order, one per line.
//
// `--root` points at another checkout (a throwaway worktree holding the
// migrated build) so both eras can be recorded from one script.

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const writes = args.includes("--writes");
const rootIdx = args.indexOf("--root");
const root =
  rootIdx >= 0
    ? resolve(args[rootIdx + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const surface = args.find((a, i) => !a.startsWith("--") && (rootIdx < 0 || i !== rootIdx + 1));
if (!surface) {
  console.error("usage: mcp-transcript.mjs <surface> [--writes] [--root <dir>]");
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

const prefix = `APPLE_${surface.toUpperCase()}`;
const env = { ...process.env, [`${prefix}_ALLOW_WRITES`]: writes ? "1" : "0" };
delete env[`${prefix}_DEBUG`];

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

const child = spawn("node", [join(root, "packages", surface, "dist", "cli.js")], {
  env,
  stdio: ["pipe", "pipe", "ignore"],
});
child.on("error", (err) => {
  console.error(`spawn failed: ${err.message}`);
  process.exit(1);
});

const waiting = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    msg = { unparseable: line };
  }
  waiting.get(msg.id)?.(msg);
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
  const reply = new Promise((ok) => waiting.set(mine, ok));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, ...req })}\n`);
  const msg = await reply;
  if (req.method === "initialize" && msg.result?.serverInfo) delete msg.result.serverInfo.version;
  process.stdout.write(`${JSON.stringify(sortKeys({ request: req.method, response: msg }))}\n`);
}

clearTimeout(timeout);
child.kill();
process.exit(0);
