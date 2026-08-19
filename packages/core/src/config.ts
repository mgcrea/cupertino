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
