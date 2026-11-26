#!/usr/bin/env node
// Spike: how does each MCP client fall back from the 2026-07-28 protocol to
// the 2025 handshake over Streamable HTTP? Throwaway; the results go in the
// "One protocol era over HTTP" section of
// docs/superpowers/specs/2026-11-25-http-endpoint-design.md.
//
// Usage: node scripts/spikes/http-fallback.mjs
//
//   PORT=8839            listen on 127.0.0.1:$PORT, at POST/GET/DELETE /s/spike
//   DISCOVER_STATUS=404  HTTP status for `server/discover` without a session
//   EXPIRE_AFTER=<n>     forget every session after n session requests (off by default)
//   LOG=<path>           append the JSON log lines there (default: stdout)
//
// Wire each client with:
//
//   {"type":"http","url":"http://127.0.0.1:8839/s/spike","headers":{"Authorization":"Bearer spike"}}
//
// One JSON line is logged per request: method, path, headers (the
// authorization value replaced by "<present>"), body, and the status answered.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8839);
const DISCOVER_STATUS = Number(process.env.DISCOVER_STATUS ?? 404);
const EXPIRE_AFTER = process.env.EXPIRE_AFTER ? Number(process.env.EXPIRE_AFTER) : 0;
const LOG = process.env.LOG;
const PATH = "/s/spike";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

/** @type {Map<string, Set<import("node:http").ServerResponse>>} session id to its open GET streams */
const sessions = new Map();
let sessionRequests = 0;

const log = (entry) => {
  const line = `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`;
  if (LOG) appendFileSync(LOG, line);
  else process.stdout.write(line);
};

const forget = (id) => {
  for (const stream of sessions.get(id) ?? []) stream.end();
  sessions.delete(id);
};

const redact = (headers) => {
  const copy = { ...headers };
  if ("authorization" in copy) copy.authorization = "<present>";
  return copy;
};

const rpcError = (id, code, message) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});
const METHOD_NOT_FOUND = (id) => rpcError(id, -32601, "Method not found");

const ECHO_TOOL = {
  name: "spike_echo",
  description: "Echoes its arguments back.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    additionalProperties: true,
  },
};

const answer = (message) => {
  const { id, method, params } = message;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "http-fallback-spike", version: "0.0.0" },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [ECHO_TOOL] } };
    case "tools/call": {
      if (params?.name !== ECHO_TOOL.name)
        return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments ?? {};
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(args) }],
          structuredContent: args,
        },
      };
    }
    default:
      return METHOD_NOT_FOUND(id);
  }
};

const isRequest = (message) =>
  message && typeof message === "object" && "method" in message && "id" in message;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const send = (res, status, body, headers = {}) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  });
  res.end(payload);
  return status;
};

// Counts a request that carried a live session; at EXPIRE_AFTER, forgets them all.
const countSessionRequest = () => {
  if (!EXPIRE_AFTER) return;
  sessionRequests += 1;
  if (sessionRequests >= EXPIRE_AFTER) {
    const ids = [...sessions.keys()];
    for (const id of ids) forget(id);
    sessionRequests = 0;
    log({ event: "expired", sessions: ids });
  }
};

const handlePost = (req, res, raw, sessionId) => {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: send(res, 400, rpcError(null, -32700, "Parse error")), body: raw };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const requests = messages.filter(isRequest);

  if (!sessionId) {
    const discover = requests.find((m) => m.method === "server/discover");
    if (discover)
      return { status: send(res, DISCOVER_STATUS, METHOD_NOT_FOUND(discover.id)), body: parsed };
    const init = requests.find((m) => m.method === "initialize");
    if (!init) {
      return {
        status: send(res, 400, rpcError(null, -32600, "Bad Request: no session")),
        body: parsed,
      };
    }
    const id = randomBytes(16).toString("hex");
    sessions.set(id, new Set());
    return { status: send(res, 200, answer(init), { "mcp-session-id": id }), body: parsed };
  }

  if (!sessions.has(sessionId)) {
    return { status: send(res, 404, rpcError(null, -32001, "Session not found")), body: parsed };
  }
  countSessionRequest();
  if (requests.length === 0) return { status: send(res, 202), body: parsed };
  const replies = requests.map(answer);
  return { status: send(res, 200, Array.isArray(parsed) ? replies : replies[0]), body: parsed };
};

const handleGet = (req, res, sessionId) => {
  if (!sessionId) return send(res, 400, rpcError(null, -32600, "Bad Request: no session"));
  if (!sessions.has(sessionId)) return send(res, 404, rpcError(null, -32001, "Session not found"));
  countSessionRequest();
  // The count may just have expired this very session.
  if (!sessions.has(sessionId)) return send(res, 404, rpcError(null, -32001, "Session not found"));
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "mcp-session-id": sessionId,
  });
  res.flushHeaders();
  const streams = sessions.get(sessionId);
  streams.add(res);
  const timer = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(timer);
    streams.delete(res);
    log({ event: "stream-closed", session: sessionId });
  });
  return 200;
};

const handleDelete = (res, sessionId) => {
  if (!sessionId) return send(res, 400, rpcError(null, -32600, "Bad Request: no session"));
  if (!sessions.has(sessionId)) return send(res, 404, rpcError(null, -32001, "Session not found"));
  forget(sessionId);
  return send(res, 200);
};

const server = createServer(async (req, res) => {
  const raw = await readBody(req);
  const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const sessionId = req.headers["mcp-session-id"];
  let status;
  let body = raw === "" ? undefined : raw;

  if (path !== PATH) {
    status = send(res, 404, { error: "not found" });
  } else if (req.method === "POST") {
    ({ status, body } = handlePost(req, res, raw, sessionId));
  } else if (req.method === "GET") {
    status = handleGet(req, res, sessionId);
  } else if (req.method === "DELETE") {
    status = handleDelete(res, sessionId);
  } else {
    status = send(res, 405, undefined, { allow: "GET, POST, DELETE" });
  }

  log({ method: req.method, path: req.url, headers: redact(req.headers), body, status });
});

server.listen(PORT, "127.0.0.1", () => {
  log({
    event: "listening",
    url: `http://127.0.0.1:${PORT}${PATH}`,
    discoverStatus: DISCOVER_STATUS,
    expireAfter: EXPIRE_AFTER || null,
  });
});
