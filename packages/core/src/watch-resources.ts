import {
  McpServer,
  ProtocolError as SdkProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  UriTemplate,
} from "@modelcontextprotocol/server";

import type { Era } from "./cli.js";
import { guardedRead, surfaceUri } from "./resources.js";
import {
  WatchRegistry,
  type ArrivalRow,
  type ArrivalSource,
  type WatchRegistryOptions,
} from "./watches.js";

/**
 * Serving watches to a client, in both protocol eras.
 *
 * ## Why a watch is a resource, when prompts-and-resources.md says otherwise
 *
 * That document says a resource that is never the same twice is a tool call
 * wearing a URI, and for the guide, diagnostics and inventory it is right: those
 * are things a model could just as well ask a tool for. A watch is the named
 * exception, for a reason no tool can meet. The only way a server can push to a
 * client in the 2026-07-28 revision is `notifications/resources/updated`, and
 * that notification carries a URI and nothing else; `subscriptions/listen` names
 * URIs, never tools. So the thing a host subscribes to has to be a resource, and
 * the *only* part of a watch that is one is its handle. Everything that varies
 * (who it follows, what arrived) stays behind a tool call and a cursor.
 *
 * ## Why the template is not listed
 *
 * `resources/list` must not vary per connection or as a side effect of other
 * requests, and a watch is created by a tool call. So the template is
 * registered with `list: undefined`: the handle is readable and subscribable by
 * anyone who was given its URI, and never enumerable.
 *
 * ## Why the two eras differ here, and only here
 *
 * On a 2026-era connection `serveStdio`'s router matches each outbound
 * `notifications/resources/updated` against the open `subscriptions/listen`
 * requests by exact URI, so the server sends one per update and the router drops
 * the ones nobody asked for. On a 2025-era connection the router passes the
 * notification through unsolicited, so a server that sent it regardless would
 * wake hosts that never subscribed. The server therefore keeps the subscribed
 * URIs itself, but only in that era: a second subscription table beside the
 * router's would be a place for the two to disagree.
 *
 * The handlers are registered by method name because v2's `McpServer` answers
 * -32601 to `resources/subscribe` until one exists, and the request schemas are
 * not part of the public surface.
 */

export type WatchesOptions<R extends ArrivalRow> = {
  /** Surface id as it appears in surfaces.json, e.g. "mail". */
  surface: string;
  displayName: string;
  /** From `start`'s context: which era this server instance was built for. */
  era: Era;
  source: ArrivalSource<R>;
  startTrigger?: WatchRegistryOptions<R>["startTrigger"];
};

/**
 * A non-negative integer, or undefined when absent.
 *
 * Strict on purpose: `Number("")` is 0 and `Number("1.5")` is a cursor that no
 * row has, and either would quietly turn a client's bug into a re-read from the
 * start of the watch.
 */
const parseAfter = (raw: string | string[] | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (text === undefined || !/^\d+$/.test(text)) {
    throw new SdkProtocolError(
      ProtocolErrorCode.InvalidParams,
      `"after" must be a non-negative integer cursor, got "${text ?? ""}".`,
    );
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n)) {
    throw new SdkProtocolError(ProtocolErrorCode.InvalidParams, `"after" is out of range.`);
  }
  return n;
};

/**
 * `…/watch/{id}{?after}`, which also matches the bare handle.
 *
 * The SDK's matcher treats a `{?after}` expression as required: it matches
 * `…/watch/w_1?after=5` and returns null for `…/watch/w_1`, so the URI a tool
 * hands out, and the one a host subscribes to, would answer "not found". The
 * template is still advertised in its RFC 6570 form; only the match is widened,
 * by falling back to the same path without the query.
 */
class WatchUriTemplate extends UriTemplate {
  readonly #bare: UriTemplate;

  constructor(surface: string) {
    super(surfaceUri(surface, "watch/{id}{?after}"));
    this.#bare = new UriTemplate(surfaceUri(surface, "watch/{id}"));
  }

  override match(uri: string): ReturnType<UriTemplate["match"]> {
    return super.match(uri) ?? this.#bare.match(uri);
  }
}

/**
 * Register the watch template on `server` and return the registry behind it.
 *
 * Nothing runs here. The registry starts its trigger on the first `add`, so a
 * server built for a discover probe and then discarded (see `serveStdio`) leaves
 * no watcher behind.
 */
export const createWatches = <R extends ArrivalRow>(
  server: McpServer,
  opts: WatchesOptions<R>,
): WatchRegistry<R> => {
  const { surface, displayName, era } = opts;

  /** URIs a 2025-era client subscribed to. Unused in the modern era. */
  const subscribed = new Set<string>();

  const registry = new WatchRegistry<R>({
    surface,
    source: opts.source,
    ...(opts.startTrigger ? { startTrigger: opts.startTrigger } : {}),
    onUpdate: (uri) => {
      if (era === "legacy" && !subscribed.has(uri)) return;
      // The registry's `onUpdate` is synchronous and a send is not. A transport
      // that is closing rejects, and an unhandled rejection would take the
      // process down over a notification nobody is left to read.
      server.server.sendResourceUpdated({ uri }).catch(() => {});
    },
  });

  // `registerCapabilities` merges into what `registerResource` already declared
  // (`listChanged`), so this adds the flag without replacing it, in either order.
  server.server.registerCapabilities({ resources: { subscribe: true } });

  if (era === "legacy") {
    server.server.setRequestHandler("resources/subscribe", (req) => {
      subscribed.add(req.params.uri);
      return {};
    });
    server.server.setRequestHandler("resources/unsubscribe", (req) => {
      subscribed.delete(req.params.uri);
      return {};
    });
  }

  server.registerResource(
    `${surface}-watch`,
    new ResourceTemplate(new WatchUriTemplate(surface), { list: undefined }),
    {
      title: `${displayName}: a watch on incoming messages`,
      description:
        `What has arrived for one watch since it was created, or since \`after\`. Get the URI ` +
        "from the watch tool; subscribe to it to be told when to read again. Envelope metadata " +
        "only, oldest first. `cursor` is the last row scanned: pass it back as `after` to resume.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
      const after = parseAfter(variables.after);
      // An unknown id is an error, not `degraded` data: after a reconnect the
      // handle really is gone, and not-found is what tells the client to call
      // the watch tool again. It is raised outside `guardedRead`, which would
      // turn it into data.
      let missing = false;
      const res = await guardedRead(surface, uri.href, async () => {
        const read = id === undefined ? null : registry.read(id, after);
        if (read === null) {
          missing = true;
          return null;
        }
        return read;
      });
      if (missing) throw new ResourceNotFoundError(uri.href);
      return res;
    },
  );

  return registry;
};
