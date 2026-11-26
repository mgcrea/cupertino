// A stand-in MCP server for `make host-check`: just enough to tell when the
// host starts a server, what it writes to it, and whether its replies reach
// the client.
//
// Answers `initialize`, the four lists, `ping` and `tools/call` with fixed
// results, written the way node's servers write them: `{"result":…,
// "jsonrpc":"2.0","id":…}`, the id last, which is the shape the host's cache
// holds. Any other request gets a JSON-RPC error. Notifications are read and
// not answered.
//
// STUB_LOG   a file to which `<pid> started` is appended once, as the stub
//            boots, and `<pid> <line>` for every line read after that.
// STUB_SKEW  a method answered with a different result, to make a replay
//            disagree with what the host recorded.
//
// A `tools/call` whose arguments carry `delayMs` is answered that many
// milliseconds late, so a check can hold a request open.
//
// Exits on stdin EOF, as a real server does.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.STUB_LOG;
const skew = process.env.STUB_SKEW;

// Before anything is read, so a server that was started and never written to
// still shows.
if (log) appendFileSync(log, `${process.pid} started\n`);

const results = {
  initialize: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {}, prompts: {}, resources: {} },
    serverInfo: { name: "stub", version: "0.0.0" },
  },
  "tools/list": {
    tools: [{ name: "stub_echo", inputSchema: { type: "object" } }],
  },
  "prompts/list": { prompts: [] },
  "resources/list": { resources: [] },
  "resources/templates/list": { resourceTemplates: [] },
  ping: {},
  "tools/call": { content: [{ type: "text", text: "called" }] },
};

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (log) appendFileSync(log, `${process.pid} ${line}\n`);
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message === null || typeof message !== "object") return;
  if (message.id === undefined || typeof message.method !== "string") return;
  const result = results[message.method];
  if (result === undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `unknown method '${message.method}'` },
    });
    return;
  }
  const answer = message.method === skew ? { ...result, skewed: true } : result;
  const delay = message.method === "tools/call" ? message.params?.arguments?.delayMs : undefined;
  const reply = () => send({ result: answer, jsonrpc: "2.0", id: message.id });
  if (typeof delay === "number") setTimeout(reply, delay);
  else reply();
});

lines.on("close", () => process.exit(0));
