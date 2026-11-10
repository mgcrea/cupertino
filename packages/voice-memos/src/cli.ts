#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { VOICE_MEMOS_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-voice-memos-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: VOICE_MEMOS_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server, client } = createServer({ config, logger });
    const status = client.status();
    return {
      server,
      // Counts, because "store=open" alone cannot tell a working server from an empty store.
      banner:
        `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
        `store=${status.store.opened ? (status.store.mode ?? "open") : "UNREADABLE"}, ` +
        `recordings=${status.counts?.recordings ?? 0}, ` +
        `schema=${status.schema.verified ? "verified" : "unverified"}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
