import {
  SUBSCRIPTION_ID_META_KEY,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";

/**
 * Which resource URIs the open `subscriptions/listen` requests on a 2026-era
 * connection name, as the SDK's router honoured them.
 *
 * ## Why this exists
 *
 * On a 2026-era connection `serveStdio`'s router forwards a
 * `notifications/resources/updated` only to an open listen that names its URI,
 * and drops it otherwise without a word. Its table is private: the router is a
 * local inside `serveStdio`, with no accessor and no callback (SDK 2.4.0). The
 * bridge sees only what reaches the wire, so the Activity log showed a pushed
 * update and nothing at all for a dropped one, and "never sent" read the same
 * as "sent, nobody listening". This ledger lets the watch module tell the two
 * apart and say so on stderr, which the app relays into the Activity log.
 *
 * ## Why it reads the router's answers, not the client's requests
 *
 * A listen request is not what the router keeps. It narrows the filter to what
 * the server declared, and refuses one with a bad envelope. What it kept is in
 * the `notifications/subscriptions/acknowledged` it writes back: the honoured
 * filter, stamped with the subscription id. So the ledger adds an entry on that
 * ack and drops it the two ways the router does: an inbound
 * `notifications/cancelled` naming the id, and the graceful-close result the
 * router writes for each open listen when the connection ends. In SDK 2.4.0
 * those are the only three places the router's table changes (`serve`,
 * `cancel`, `teardownAll` in `listenRouter`).
 *
 * ## Why this is not the second subscription table watch-resources.ts refuses
 *
 * It decides nothing. The watch module still sends every update and the router
 * still decides who gets it. A ledger that disagreed with the router would cost
 * one wrong line in the log, never a push.
 */
export class ListenLedger {
  /** Open listens, keyed by the listen's JSON-RPC id as sent: `1` and `"1"` stay distinct. */
  readonly #open = new Map<RequestId, readonly string[]>();

  /** Whether an open listen names `uri` exactly, which is the router's own test. */
  covers(uri: string): boolean {
    for (const uris of this.#open.values()) if (uris.includes(uri)) return true;
    return false;
  }

  /** How many listens are open. */
  get size(): number {
    return this.#open.size;
  }

  /** Observe a message the server writes to the wire. */
  outbound(message: JSONRPCMessage): void {
    if ("method" in message) {
      if (message.method !== "notifications/subscriptions/acknowledged") return;
      const params = message.params as
        | { notifications?: { resourceSubscriptions?: unknown } }
        | undefined;
      const id = subscriptionIdOf(message.params);
      if (id === undefined) return;
      const uris = params?.notifications?.resourceSubscriptions;
      this.#open.set(
        id,
        Array.isArray(uris) ? uris.filter((u): u is string => typeof u === "string") : [],
      );
      return;
    }
    // A listen is answered once, when it ends. Any response carrying an open
    // listen's id is that end.
    if ("id" in message && message.id !== undefined) this.#open.delete(message.id);
  }

  /** Observe a message the client writes to the server. */
  inbound(message: JSONRPCMessage): void {
    if (!("method" in message) || "id" in message) return;
    if (message.method !== "notifications/cancelled") return;
    const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      this.#open.delete(requestId);
    }
  }
}

/** The subscription id the router stamps into a notification's `_meta`. */
const subscriptionIdOf = (params: unknown): RequestId | undefined => {
  if (params === null || typeof params !== "object") return undefined;
  const { _meta: meta } = params as { _meta?: Record<string, unknown> };
  const id = meta?.[SUBSCRIPTION_ID_META_KEY];
  return typeof id === "string" || typeof id === "number" ? id : undefined;
};

/**
 * Wrap a transport so `ledger` sees every message in both directions.
 *
 * Mutates and returns the transport, as `withTrimmedListing` does. Outbound is
 * `send`. Inbound is `onmessage`, which `serveStdio` assigns after it is handed
 * the transport, so the property becomes an accessor that wraps whatever is
 * assigned to it rather than a wrapper around what is there now.
 */
export const withListenLedger = <T extends Transport>(transport: T, ledger: ListenLedger): T => {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    ledger.outbound(message);
    return send(message, options);
  };
  type OnMessage = NonNullable<Transport["onmessage"]>;
  let handler: Transport["onmessage"];
  const wrap = (next: Transport["onmessage"]): Transport["onmessage"] =>
    next === undefined
      ? undefined
      : (((message: JSONRPCMessage, extra?: Parameters<OnMessage>[1]) => {
          ledger.inbound(message);
          next(message, extra);
        }) as OnMessage);
  handler = wrap(transport.onmessage);
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (next: Transport["onmessage"]) => {
      handler = wrap(next);
    },
  });
  return transport;
};
