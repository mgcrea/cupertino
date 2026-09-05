import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { BuildInfo } from "./build-info.js";
import type { SurfaceContext } from "./errors.js";
import { withTrimmedListing } from "./listing.js";
import type { Logger } from "./osascript.js";

export type StdioServerOptions = {
  build: BuildInfo;
  surface: SurfaceContext;
  /** Prefix on every stderr line, e.g. "apple-mail-mcp". */
  logPrefix: string;
  /**
   * Build and return the server, plus a one-line summary of the settings it
   * came up with. Called only after the platform guard passes.
   */
  start: (logger: Logger) => Promise<{ server: McpServer; banner: string }>;
};

/**
 * Boot a server on stdio.
 *
 * The load-bearing rule: **everything goes to stderr**. stdout is the JSON-RPC
 * channel under stdio, and a stray `console.log` there corrupts the protocol —
 * which surfaces as an unintelligible client-side parse error rather than as
 * anything pointing at the log line that caused it.
 */
export const runStdioServer = async (opts: StdioServerOptions): Promise<void> => {
  const { build, surface, logPrefix } = opts;
  const debugEnabled = Boolean(process.env[`${surface.envPrefix}_DEBUG`]);
  const logger: Required<Logger> = {
    debug: (...args: unknown[]) => {
      if (debugEnabled) console.error(`[${logPrefix}]`, ...args);
    },
    warn: (...args: unknown[]) => console.error(`[${logPrefix}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${logPrefix}]`, ...args),
  };

  logger.warn(
    `${build.name}@${build.version} (git ${build.gitCommit} ${build.gitCommitDate}, node ${process.version})`,
  );

  if (process.platform !== "darwin") {
    logger.error(
      `fatal: this server drives the macOS ${surface.appName} app and cannot run on ${process.platform}.`,
    );
    process.exit(1);
  }

  const { server, banner } = await opts.start(logger);
  await server.connect(withTrimmedListing(new StdioServerTransport()));
  logger.warn(`${logPrefix} connected (${banner})`);

  const shutdown = (signal: string): void => {
    logger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};
