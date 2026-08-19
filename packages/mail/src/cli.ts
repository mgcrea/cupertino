#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BUILD_INFO } from "./build-info.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// Everything goes to stderr: stdout is the JSON-RPC channel under stdio, and a
// stray console.log there corrupts the protocol.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.APPLE_MAIL_DEBUG) console.error("[apple-mail-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[apple-mail-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[apple-mail-mcp]", ...args),
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );

  if (process.platform !== "darwin") {
    stderrLogger.error(
      `fatal: this server drives the macOS Mail app and cannot run on ${process.platform}.`,
    );
    process.exit(1);
  }

  const config = loadConfig();
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  stderrLogger.warn(
    `apple-mail-mcp connected (writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
      `accounts=${config.accounts.length ? config.accounts.join("/") : "all"}, ` +
      `index=${config.indexMode})`,
  );

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error("[apple-mail-mcp] fatal:", err);
  process.exit(1);
});
