import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
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
 * An upstream boundary that v2 of the SDK lifted, pinned so it does not
 * quietly come back.
 *
 * The MCP spec makes `GetPromptRequest.params.arguments` OPTIONAL. Version 1
 * of the SDK parsed whatever arrived against the declared object schema, and
 * `z.object({…}).safeParse(undefined)` fails however optional every key is, so
 * a prompt that declared any argument rejected a request that omitted the
 * field entirely. Version 2 accepts the omission and runs the callback with no
 * arguments, which is what hosts that skip the argument form on an
 * all-optional prompt needed.
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

  it("accepts an omitted arguments field when every argument is optional", async () => {
    const got = await (await withArgs()).getPrompt({ name: "widget_optional" });
    expect(textOf(got.messages[1])).toBe("since:-");
  });
});
