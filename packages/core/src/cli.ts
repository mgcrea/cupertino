import type { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import type { BuildInfo } from "./build-info.js";
import { parseBool } from "./config.js";
import type { SurfaceContext } from "./errors.js";
import { withTrimmedListing } from "./listing.js";
import type { Logger } from "./osascript.js";

/**
 * Which MCP revision a server instance speaks: `legacy` is the 2025 handshake
 * (`initialize`), `modern` is 2026-07-28 (per-request `_meta`, `server/discover`).
 */
export type Era = "legacy" | "modern";

export type StdioServerOptions = {
  build: BuildInfo;
  surface: SurfaceContext;
  /** Prefix on every stderr line, e.g. "apple-mail-mcp". */
  logPrefix: string;
  /**
   * Build and return the server, plus a one-line summary of the settings it
   * came up with. Called only after the platform guard passes.
   *
   * Called once per instance the SDK asks for, not once per process: a client
   * that opens with `server/discover` gets a probe instance that is thrown
   * away if it then falls back to `initialize`. So `start` must be safe to run
   * more than once, and `ctx.era` says which protocol the instance will serve.
   */
  start: (logger: Logger, ctx: { era: Era }) => Promise<{ server: McpServer; banner: string }>;
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
  // `parseBool`, like every other switch: `Boolean(env)` read `APPLE_X_DEBUG=0`
  // as on, because any non-empty string is truthy.
  const debugEnabled = parseBool(process.env[`${surface.envPrefix}_DEBUG`]) ?? false;
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

  // The SDK owns the era decision and calls this per instance. `legacy` stays
  // at its default, `serve`: `reject` would turn away every 2025-era host.
  serveStdio(
    async ({ era }) => {
      let started;
      try {
        started = await opts.start(logger, { era });
      } catch (err) {
        // The SDK would answer -32603 and keep serving, re-running `start` on
        // every request. A server that cannot start should die saying why, as
        // it did when `start` ran before the connection.
        logger.error("fatal:", err);
        process.exit(1);
      }
      logger.warn(`${logPrefix} connected, ${era} era (${started.banner})`);
      return started.server;
    },
    {
      transport: withTrimmedListing(new StdioServerTransport()),
      onerror: (err) => logger.error(err),
    },
  );

  const shutdown = (signal: string): void => {
    logger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};
