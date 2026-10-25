import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";

/**
 * Trimming the SDK's own boilerplate out of `tools/list`.
 *
 * ## What this drops
 *
 * The SDK builds each tool's `inputSchema` from its zod schema at listing time,
 * and the generator stamps every one that has properties with
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"`. A tool with no
 * arguments comes out without it. Measured on the notes server with writes on,
 * the stamp is 570 B (ten tools at 57 B each) of an 8,224 B listing, 6.9%,
 * paid by every client on every connect to name a JSON Schema dialect the
 * client already has to assume in order to read the rest of the document.
 * Nothing in the protocol reads it and no client needs it, so it is the rare
 * cut that is free rather than a trade.
 *
 * ## What there is no longer to drop
 *
 * Version 1 of the SDK also stamped `"execution": {"taskSupport": "forbidden"}`
 * on every tool, which this file used to leave alone because an absent
 * `execution` read as "unspecified" to a task-capable client. Version 2 removed
 * experimental tasks and emits no `execution` at all, so the listing a client
 * sees has no task claim to keep or to trim. Absent means no task support,
 * which is what `"forbidden"` said.
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
