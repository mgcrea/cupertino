#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { MAPS_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-maps-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: MAPS_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server, client } = createServer({ config, logger });
    const status = client.status();
    const caps = status.capabilities as { entities?: Record<string, { rows?: number }> } | null;
    const rows = (k: string): number => caps?.entities?.[k]?.rows ?? 0;
    return {
      server,
      // No writes= line: this surface has no mutating tool, and printing a flag
      // that gates nothing would imply one exists. The counts are named because
      // "store=open" alone cannot distinguish a working server from one pointed
      // at an empty replica — which is exactly what the device-local cache is.
      banner:
        `read-only, ` +
        `store=${status.store.opened ? (status.store.mode ?? "open") : "UNREADABLE"}, ` +
        `favorites=${rows("favorites")}, ` +
        `collections=${rows("collections")}, ` +
        `recents=${rows("history")}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
