import { z } from "zod";

/**
 * Environment parsing shared by every server.
 *
 * Configuration is environment-only. The sibling servers that also read a
 * `~/.config/<service>/config.json` do so because they hold a private key or an
 * OAuth token; these servers hold no secret at all — their access is the macOS
 * permission the user granted.
 */

export const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export const parseBool = (v: string | undefined): boolean | undefined => {
  const t = trimmed(v)?.toLowerCase();
  if (t === undefined) return undefined;
  return t === "1" || t === "true" || t === "yes" || t === "on";
};

export const parseIntOpt = (v: string | undefined): number | undefined => {
  const t = trimmed(v);
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

export const parseList = (v: string | undefined): string[] | undefined => {
  const t = trimmed(v);
  if (t === undefined) return undefined;
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Settings every Apple-app server has. Extend it rather than repeating them:
 *
 *   const ConfigSchema = BaseConfigSchema.extend({ ... }).strict();
 */
export const BaseConfigSchema = z.object({
  allowWrites: z.boolean().default(false),
  /**
   * Register the workflow prompts and the surface resources.
   *
   * ON by default, unlike `allowWrites`, and the difference is the point: the
   * write gate is a SAFETY invariant — off means a mutation cannot be reached
   * even by name — while this is a COST knob, in the same family as
   * `maxResults`. Conflating the two would muddy the one that matters.
   *
   * What it costs, measured across all seven servers with writes on: the
   * prompt and resource listings come to ~3.4k tokens against ~18.5k for the
   * tool definitions, so roughly 18% on top of a bill that is dominated by
   * tools either way. Resource CONTENTS cost nothing until something reads
   * them. The knob exists for hosts that put every listing in the prompt and
   * for people counting bytes; if context is the problem, running fewer
   * servers is the bigger lever by far.
   *
   * One flag for both, not two, because they ship as a pair: every prompt
   * embeds its surface guide, and a prompt naming a `cupertino://…/guide` that
   * nothing serves would be a dangling reference by configuration.
   */
  exposePrompts: z.boolean().default(true),
  debug: z.boolean().default(false),
  osascriptPath: z.string().default("/usr/bin/osascript"),
  osascriptTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  maxResults: z.number().int().min(1).max(1_000).default(200),
});

/**
 * Parse an env-derived object against a schema.
 *
 * Undefined values are dropped so zod's defaults apply, rather than failing on
 * an explicitly-undefined key.
 */
export const parseConfig = <T extends z.ZodType>(
  schema: T,
  raw: Record<string, unknown>,
): z.infer<T> => {
  const compacted = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const parsed = schema.safeParse(compacted);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data as z.infer<T>;
};
