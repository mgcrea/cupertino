import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The surface resources.
 *
 * ## Why a resource when a tool already returns this
 *
 * `apple_mail_diagnostics` and `apple_mail_list_accounts` answer these same
 * questions, and they stay. What they cannot do is be *addressed*. A tool result
 * exists only after the model decided to spend a call on it, which means the
 * account list is re-derived every session and the diagnostics report is read
 * after the failure rather than before it. A resource is a URI: a host can
 * attach it, cache it, or let a user paste it in, and none of that costs a tool
 * call or depends on the model guessing that it should look.
 *
 * ## The scheme is `cupertino://`, not `apple://`
 *
 * The tools are named `apple_mail_*` because they say what they drive. A URI
 * scheme is a different kind of claim — it is a namespace, and taking Apple's
 * would read as affiliation this project spends a README line disclaiming. So
 * the authority is the surface id and the scheme is the project's own name, the
 * one already in the bundle identifier.
 *
 * ## Three per surface, and only one of them can fail
 *
 * - `guide` is static text. It needs no permission, touches no store and spawns
 *   no process, so it is readable when every other lane is denied — which is
 *   exactly the moment its contents are worth reading.
 * - `diagnostics` is the live capability report.
 * - `inventory` is the set of containers you address by name: accounts, and
 *   whatever the surface calls its folders. Surfaces with no such containers
 *   (Messages, Safari) register two resources rather than inventing a third.
 */

export const RESOURCE_SCHEME = "cupertino";

/** `cupertino://mail/guide`. The one place this string is built. */
export const surfaceUri = (surface: string, leaf: string): string =>
  `${RESOURCE_SCHEME}://${surface}/${leaf}`;

export type ResourceReader = () => Promise<unknown>;

export type SurfaceResourceOptions = {
  /** Surface id as it appears in surfaces.json, e.g. "mail". */
  surface: string;
  /** Display name, e.g. "Mail". Used only in resource titles. */
  displayName: string;
  /** The operating manual. Static markdown — see `guide.ts` in each surface. */
  guide: string;
  /** The live capability report, normally the diagnostics tool's own payload. */
  diagnostics: ResourceReader;
  /** The addressable containers. Omitted by surfaces that have none. */
  inventory?: {
    /** What this surface calls them, e.g. "accounts and mailboxes". */
    describes: string;
    read: ResourceReader;
  };
};

const jsonContents = (uri: string, data: unknown) => ({
  contents: [
    {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data),
    },
  ],
});

/**
 * Read a resource without ever throwing.
 *
 * A tool that fails returns `isError` and keeps its text; a resource read that
 * throws becomes a JSON-RPC error and keeps nothing. That asymmetry is worst
 * precisely on `diagnostics`, the resource whose whole job is to explain a
 * broken machine: letting a TCC denial replace the report with "resource read
 * failed" would delete the answer at the only moment anyone wants it.
 *
 * So a failed read is *data*, shaped like the `degraded` results the tools
 * already return, and the caller can tell an unreadable store from an empty one.
 */
const guardedRead = async (surface: string, uri: string, read: ResourceReader) => {
  try {
    return jsonContents(uri, await read());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = (err as Error & { details?: unknown })?.details;
    return jsonContents(uri, {
      degraded: true,
      error: message,
      ...(err instanceof Error ? { kind: err.name } : {}),
      ...(details ? { details } : {}),
      hint: `Read ${surfaceUri(surface, "diagnostics")} for what this server can currently reach.`,
    });
  }
};

/** Register a surface's guide, diagnostics and (where it has one) inventory. */
export const registerSurfaceResources = (server: McpServer, opts: SurfaceResourceOptions): void => {
  const { surface, displayName, guide, diagnostics, inventory } = opts;

  const guideUri = surfaceUri(surface, "guide");
  server.registerResource(
    `${surface}-guide`,
    guideUri,
    {
      title: `${displayName}: how to drive this server`,
      description:
        `How to use the ${displayName} tools well: what each ref means, which tool to reach for ` +
        "under which constraint, what a degraded result does and does not say, and what the " +
        "write gate is currently hiding. Static text — readable even with every permission denied.",
      mimeType: "text/markdown",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }] }),
  );

  const diagnosticsUri = surfaceUri(surface, "diagnostics");
  server.registerResource(
    `${surface}-diagnostics`,
    diagnosticsUri,
    {
      title: `${displayName}: capabilities and permissions`,
      description:
        `What this ${displayName} server can currently do and why — the same report as the ` +
        "diagnostics tool, addressable without spending a tool call. Read it before trusting an " +
        "empty result.",
      mimeType: "application/json",
    },
    () => guardedRead(surface, diagnosticsUri, diagnostics),
  );

  if (!inventory) return;

  const inventoryUri = surfaceUri(surface, "inventory");
  server.registerResource(
    `${surface}-inventory`,
    inventoryUri,
    {
      title: `${displayName}: ${inventory.describes}`,
      description:
        `The ${inventory.describes} this server can see, spelled exactly as ${displayName} ` +
        "spells them. These are the names every other tool takes, so reading this first is the " +
        "difference between a filter that matches and one that silently matches nothing.",
      mimeType: "application/json",
    },
    () => guardedRead(surface, inventoryUri, inventory.read),
  );
};
