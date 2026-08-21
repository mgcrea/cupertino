#!/usr/bin/env node
import { runStdioServer } from "@mgcrea/mcp-apple-core";

import { BUILD_INFO } from "./build-info.js";
import { CALENDAR_SURFACE } from "./client/errors.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const LOG_PREFIX = "apple-calendar-mcp";

runStdioServer({
  build: BUILD_INFO,
  surface: CALENDAR_SURFACE,
  logPrefix: LOG_PREFIX,
  start: async (logger) => {
    const config = loadConfig();
    const { server } = createServer({ config, logger });
    return {
      server,
      banner:
        `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
        `calendars=${config.calendars.length ? config.calendars.join("/") : "all"}, ` +
        `range=${config.defaultRangeDays}d, ` +
        `index=${config.indexMode}`,
    };
  },
}).catch((err: unknown) => {
  console.error(`[${LOG_PREFIX}] fatal:`, err);
  process.exit(1);
});
