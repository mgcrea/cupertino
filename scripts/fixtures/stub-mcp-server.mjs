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
// STUB_LOG   a file to which `<pid> <line>` is appended for every line read.
// STUB_SKEW  a method answered with a different result, to make a replay
//            disagree with what the host recorded.
//
// Exits on stdin EOF, as a real server does.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.STUB_LOG;
const skew = process.env.STUB_SKEW;

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
  send({ result: answer, jsonrpc: "2.0", id: message.id });
});

lines.on("close", () => process.exit(0));
