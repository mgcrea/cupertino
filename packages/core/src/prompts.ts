import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { surfaceUri } from "./resources.js";

/**
 * The workflow prompts.
 *
 * ## What a prompt is for here
 *
 * The same thing every tool description in this repo is for: holding a
 * constraint the model would otherwise re-derive. A tool holds the ones that
 * are about *one call* — that a body search wants a narrowing filter, that a
 * ref is opaque. A prompt holds the ones that are about the *order of calls*,
 * and those have nowhere else to live. "Search before you list", "read the
 * thread before you answer it", "check what exists before you create a
 * duplicate" are not properties of any single tool, so no single tool
 * description can carry them, and the model rebuilds them from scratch every
 * session — usually correctly, sometimes not, always at a cost.
 *
 * ## Every prompt embeds its surface guide
 *
 * A prompt returns messages, and one of them is the `cupertino://<surface>/guide`
 * resource. That is the coupling that makes both primitives worth more than
 * either alone: the guide is the reference, the prompt is the task, and a host
 * that expands the prompt gets both without the model having to know the guide
 * exists.
 *
 * ## Write-gated prompts follow the tools
 *
 * A prompt that ends in a mutation is registered only when writes are on, for
 * the same reason the mutating tools are: with the gate closed it must not
 * merely refuse, it must be *invisible*. A visible `draft_reply` on a
 * read-only server is an offer the server cannot keep.
 */

/** MCP prompt arguments are strings on the wire. This is the only shape they take. */
export const promptArg = (description: string): z.ZodOptional<z.ZodString> =>
  z.string().optional().describe(description);

/** Same, for an argument the prompt is useless without. */
export const requiredPromptArg = (description: string): z.ZodString =>
  z.string().min(1).describe(description);

export type PromptContext = {
  /** Surface id, e.g. "mail". */
  surface: string;
  /** The static guide, embedded ahead of every prompt's instruction. */
  guide: string;
};

export type WorkflowPrompt<Args extends z.ZodRawShape> = {
  /** Namespaced like the tools, e.g. "apple_mail_triage". */
  name: string;
  title: string;
  /** What this does and when to reach for it. Shown in the host's prompt list. */
  description: string;
  argsSchema?: Args;
  /**
   * The instruction. Receives validated arguments; returns the text that does
   * the actual work of ordering the calls.
   */
  build: (args: { [K in keyof Args]: z.infer<Args[K]> }) => string;
};

/**
 * Register one workflow prompt.
 *
 * Called once per prompt rather than handed an array, because the argument
 * shape is generic and an array of prompts with differing shapes loses the
 * inference that makes `build`'s parameter typed at all.
 */
export const registerWorkflowPrompt = <Args extends z.ZodRawShape>(
  server: McpServer,
  ctx: PromptContext,
  prompt: WorkflowPrompt<Args>,
): void => {
  const guideUri = surfaceUri(ctx.surface, "guide");

  const result = (instruction: string): GetPromptResult => ({
    messages: [
      {
        role: "user",
        content: {
          type: "resource",
          resource: { uri: guideUri, mimeType: "text/markdown", text: ctx.guide },
        },
      },
      { role: "user", content: { type: "text", text: instruction } },
    ],
  });

  server.registerPrompt(
    prompt.name,
    {
      title: prompt.title,
      description: prompt.description,
      ...(prompt.argsSchema ? { argsSchema: prompt.argsSchema } : {}),
    },
    // The SDK hands an args object only when a schema was declared. Both
    // callback arities are assignable here; the cast keeps one code path.
    ((args: { [K in keyof Args]: z.infer<Args[K]> }) =>
      result(prompt.build(args ?? ({} as never)))) as never,
  );
};
