import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Trimming the SDK's own boilerplate out of `tools/list`.
 *
 * ## What this drops
 *
 * The SDK builds each tool's `inputSchema` from its zod shape at listing time,
 * and the generator stamps every one with
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. Measured across the
 * eight servers with writes on, that one constant is 4,836 B of a 106,157 B
 * listing — 4.6%, paid by every client on every connect, to name a JSON Schema
 * draft the client already has to assume in order to read the rest of the
 * document. Nothing in the protocol reads it and no client needs it, so it is
 * the rare cut that is free rather than a trade.
 *
 * ## What this deliberately does NOT drop
 *
 * `"execution": {"taskSupport": "forbidden"}` is another 3,720 B (3.5%) of
 * identical constant — `registerTool` hardcodes it on every tool — and it looks
 * like the same kind of waste. It is not, and the difference is worth the
 * paragraph so nobody "finishes the job" later.
 *
 * Server-side the two spellings are the same: the SDK's `tools/call` path
 * branches only on `'required'` and `'optional'`, so an absent `execution` and
 * an explicit `'forbidden'` both fall through to the normal handler. Client-side
 * they are not. `taskSupport` is declared `.optional()` with no default, so
 * absence means "unspecified" rather than "forbidden", and a task-capable client
 * reading a listing with no `execution` is entitled to try task augmentation on
 * a tool that was registered without a task handler. `'forbidden'` is the value
 * that tells it not to. Dropping it would trade 930 tokens for a behavioural
 * change on a path nothing here tests.
 *
 * ## Why it is done to the outgoing frame
 *
 * The alternative seams are worse. The schema is generated inside the SDK, so
 * there is no option to pass; overriding the `tools/list` request handler means
 * reaching into `Server._requestHandlers`, a private field, and re-implementing
 * the listing it already builds. Wrapping `Transport.send` is public API, is
 * indifferent to how the listing was produced, and costs nothing on the frames
 * it does not match — every non-listing message is returned by identity below.
 */

/** The one key removed, spelled once. */
const GENERATED_SCHEMA_KEY = "$schema";

/**
 * A schema object without its `$schema` stamp, or the value unchanged.
 *
 * Returns the ORIGINAL reference when there is nothing to do, which is what
 * lets `trimToolListing` decide by identity whether it needs to rebuild
 * anything at all.
 */
const withoutSchemaKey = (schema: unknown): unknown => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  if (!(GENERATED_SCHEMA_KEY in schema)) return schema;
  const rest = { ...(schema as Record<string, unknown>) };
  delete rest[GENERATED_SCHEMA_KEY];
  return rest;
};

/**
 * Strip generated boilerplate from a `tools/list` reply, passing every other
 * message through untouched.
 *
 * Copies rather than mutates. The SDK hands out the registered tool's own
 * schema object, and deleting a key from it would edit the server's state from
 * a function whose job is to shape one reply.
 */
export const trimToolListing = (message: JSONRPCMessage): JSONRPCMessage => {
  if (!("result" in message)) return message;
  const result = message.result as { tools?: unknown } | undefined;
  const tools = result?.tools;
  if (!Array.isArray(tools)) return message;

  let changed = false;
  const trimmed = tools.map((tool) => {
    if (tool === null || typeof tool !== "object") return tool;
    const entry = tool as Record<string, unknown>;
    const inputSchema = withoutSchemaKey(entry["inputSchema"]);
    const outputSchema = withoutSchemaKey(entry["outputSchema"]);
    if (inputSchema === entry["inputSchema"] && outputSchema === entry["outputSchema"]) return tool;
    changed = true;
    return {
      ...entry,
      ...(entry["inputSchema"] === undefined ? {} : { inputSchema }),
      ...(entry["outputSchema"] === undefined ? {} : { outputSchema }),
    };
  });

  if (!changed) return message;
  return { ...message, result: { ...result, tools: trimmed } } as JSONRPCMessage;
};

/**
 * Wrap a transport so every listing it sends is trimmed on the way out.
 *
 * Mutates and returns the transport it was given rather than proxying it: the
 * SDK's `connect` reaches for `onmessage`, `onclose` and `onerror` on the very
 * object it was handed, and a Proxy or a subclass would have to keep those in
 * sync for no gain.
 */
export const withTrimmedListing = <T extends Transport>(transport: T): T => {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(trimToolListing(message), options);
  return transport;
};
