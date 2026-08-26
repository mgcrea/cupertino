import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { promptArg, registerWorkflowPrompt, requiredPromptArg } from "../src/prompts.js";

const GUIDE = "# Widget\n\nThe operating manual.";
const CTX = { surface: "widget", guide: GUIDE };

/** The instruction message's text, which every prompt puts second. */
const textOf = (message: { content: unknown } | undefined): string =>
  String((message?.content as { text?: string } | undefined)?.text);

const connect = async (register: (s: McpServer) => void): Promise<Client> => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

describe("registerWorkflowPrompt", () => {
  it("embeds the surface guide ahead of the instruction", async () => {
    // The coupling between the two primitives: a host that expands the prompt
    // gets the reference material without the model having to know the guide
    // resource exists.
    const client = await connect((s) =>
      registerWorkflowPrompt(s, CTX, {
        name: "widget_do",
        title: "Do",
        description: "Do the thing.",
        build: () => "Do the thing carefully.",
      }),
    );

    const got = await client.getPrompt({ name: "widget_do" });
    expect(got.messages).toHaveLength(2);

    const [first, second] = got.messages;
    expect(first?.content).toMatchObject({
      type: "resource",
      resource: { uri: "cupertino://widget/guide", mimeType: "text/markdown", text: GUIDE },
    });
    expect(second?.content).toMatchObject({ type: "text", text: "Do the thing carefully." });
  });

  it("passes validated arguments to build", async () => {
    const client = await connect((s) =>
      registerWorkflowPrompt(s, CTX, {
        name: "widget_find",
        title: "Find",
        description: "Find a thing.",
        argsSchema: { about: requiredPromptArg("What to find."), since: promptArg("When.") },
        build: ({ about, since }) => `find:${about}|since:${since ?? "-"}`,
      }),
    );

    const withBoth = await client.getPrompt({
      name: "widget_find",
      arguments: { about: "atlas", since: "2026-08-01" },
    });
    expect(textOf(withBoth.messages[1])).toBe("find:atlas|since:2026-08-01");

    const withoutOptional = await client.getPrompt({
      name: "widget_find",
      arguments: { about: "atlas" },
    });
    expect(textOf(withoutOptional.messages[1])).toBe("find:atlas|since:-");
  });

  it("advertises its arguments, marking the required one", async () => {
    const client = await connect((s) =>
      registerWorkflowPrompt(s, CTX, {
        name: "widget_find",
        title: "Find",
        description: "Find a thing.",
        argsSchema: { about: requiredPromptArg("What to find."), since: promptArg("When.") },
        build: ({ about }) => String(about),
      }),
    );

    const [prompt] = (await client.listPrompts()).prompts;
    expect(prompt?.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "about", required: true }),
        expect.objectContaining({ name: "since", required: false }),
      ]),
    );
  });

  it("rejects a call that omits a required argument", async () => {
    const client = await connect((s) =>
      registerWorkflowPrompt(s, CTX, {
        name: "widget_find",
        title: "Find",
        description: "Find a thing.",
        argsSchema: { about: requiredPromptArg("What to find.") },
        build: ({ about }) => String(about),
      }),
    );

    await expect(client.getPrompt({ name: "widget_find", arguments: {} })).rejects.toThrow();
  });
});

/**
 * An upstream boundary, pinned here so a future reader does not mistake it for
 * a bug in this package.
 *
 * The MCP spec makes `GetPromptRequest.params.arguments` OPTIONAL, but the SDK
 * parses whatever arrives against the declared object schema, and
 * `z.object({…}).safeParse(undefined)` fails however optional every key is. So
 * a prompt that declares any argument rejects a request that omits the field
 * entirely, even when nothing was required.
 *
 * Hosts that render an argument form send `{}` and are unaffected. A host that
 * skips the form on an all-optional prompt would see an error, and the fix
 * belongs upstream: there is no way to soften it through `registerPrompt`,
 * because the parse happens inside the SDK's own handler before our callback
 * is reached.
 */
describe("SDK argument handling", () => {
  const withArgs = () =>
    connect((s) =>
      registerWorkflowPrompt(s, CTX, {
        name: "widget_optional",
        title: "Optional",
        description: "Everything is optional.",
        argsSchema: { since: promptArg("When.") },
        build: ({ since }) => `since:${since ?? "-"}`,
      }),
    );

  it("accepts an empty arguments object", async () => {
    const got = await (await withArgs()).getPrompt({ name: "widget_optional", arguments: {} });
    expect(textOf(got.messages[1])).toBe("since:-");
  });

  it("rejects an omitted arguments field, even with every argument optional", async () => {
    await expect((await withArgs()).getPrompt({ name: "widget_optional" })).rejects.toThrow(
      /expected object, received undefined/,
    );
  });
});
