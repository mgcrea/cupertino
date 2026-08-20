#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { REMINDERS_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-reminders-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: REMINDERS_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server } = createServer({ config, logger });
    return {
      server,
      banner:
        `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
        `lists=${config.lists.length ? config.lists.join("/") : "all"}, ` +
        `completed=${config.includeCompleted ? "included" : "hidden"}, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
