import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleMailClient } from "../client/mail.js";
import { registerAccountTools } from "./accounts.js";
import { registerActionTools } from "./actions.js";
import { registerComposeTools } from "./compose.js";
import { registerDiagnosticsTools } from "./diagnostics.js";
import { registerMessageTools } from "./messages.js";
import { registerQueryTools } from "./query.js";
import { registerSearchTools } from "./search.js";

export type ToolContext = {
  /**
   * Register the mutating tools too. Off by default — with the flag off they are
   * not merely refused, they are invisible and cannot be called at all.
   */
  allowWrites: boolean;
};

/**
 * Register the Apple Mail tools.
 *
 * The registered set is a pure function of `allowWrites` and nothing else. In
 * particular it does NOT vary with whether Full Disk Access is granted: that is
 * a runtime condition which can change while the process lives, and MCP clients
 * cache the tool list, so a tool that appears and disappears would leave clients
 * calling names the server no longer has. Tools that need the index instead
 * return a structured `degraded` result naming the missing capability.
 */
export const registerTools = (
  server: McpServer,
  client: AppleMailClient,
  ctx: ToolContext,
): void => {
  registerDiagnosticsTools(server, client, ctx);
  registerAccountTools(server, client);
  registerSearchTools(server, client);
  registerMessageTools(server, client, ctx.allowWrites);

  if (!ctx.allowWrites) {
    /*
     * Read-only servers only, for now. Not because the tool is unsafe with
     * writes on — it reaches nothing but the index — but because every tool
     * costs listing tokens on every connect, and this one has to prove it saves
     * more than it costs before it goes on the surface most clients see.
     */
    registerQueryTools(server, client);
    return;
  }

  registerActionTools(server, client);
  registerComposeTools(server, client);
};
