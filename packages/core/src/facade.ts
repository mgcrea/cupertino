import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { fail, okText, type ToolResult } from "./tools.js";

/**
 * Lazy tool loading: a searchable index and a dispatcher, in place of the full
 * `tools/list`.
 *
 * ## Why a facade rather than a smaller listing
 *
 * MCP has no method for fetching a tool's schema later. `inputSchema` is
 * required in a `tools/list` entry and clients validate against it, so a
 * name-only listing is not a cheap server, it is a broken one. An index plus a
 * dispatcher is the only lazy discovery the protocol permits.
 *
 * Measured on the eight servers with writes on, the full listing is ~106 KB
 * (~26.5k tokens), paid by every client on every connect whether or not a tool
 * is ever called. Mail alone is ~25 KB.
 *
 * ## Two dispatchers, split on the write gate
 *
 * Bastion — the sibling project this is modelled on — ships ONE dispatcher, and
 * documents that it therefore cannot carry `readOnlyHint` at all: `true` would
 * be a lie that relaxes the host's confirmation for every write, and `false`
 * would gate the reads along with them. It accepts that, and calls it "the one
 * switch in the app that trades rather than tightens".
 *
 * Cupertino should not accept it. `docs/alternatives.md` sells "unregistered,
 * not refused" as a differentiator against a competitor whose `--read-only`
 * flag leaves write tools listed, and collapsing every call into one anonymous
 * name would hand that back. So the dispatcher is split on the axis the write
 * gate already uses: `call_tool` reaches reads and is honestly `readOnlyHint:
 * true`; `call_write_tool` reaches writes, is honestly `readOnlyHint: false`
 * and `destructiveHint: true`, and is NOT REGISTERED AT ALL when writes are
 * off. A host still gets a read/write boundary to hang a permission rule on.
 *
 * The cost that remains, and it is real: a host's rule is now per surface and
 * per direction rather than per tool. `apple_mail_send_message` and
 * `apple_mail_move_messages` share one prompt. That is the trade this file
 * makes, and it is why the flag defaults off.
 *
 * ## A write tool is one that disappears when the gate closes
 *
 * Classification does NOT read `annotations.readOnlyHint`. Thirteen mutating
 * tools ship without it — every `create`/`update`/`delete`/`move` tool on
 * Calendar, Notes and Reminders — so trusting it would file
 * `apple_notes_delete_notes` behind the READ dispatcher, silently, with nothing
 * to notice it. Instead the registrar is run twice against throwaway recorders,
 * once with the real `allowWrites` and once with it forced off, and the
 * difference is the write set. That is not a heuristic: it is the repo's own
 * definition, and `each surface's src/tools/index.ts` states the invariant it
 * relies on — "the registered set is a pure function of `allowWrites` and
 * nothing else". Registration is side-effect free, so running it twice costs
 * two arrays of closures and touches no client.
 *
 * ## What this deliberately does not copy from Bastion
 *
 * No `nextCursor` walk (registration is in-process, so there are no pages), no
 * catalog cache or invalidation, no `ttlMs`/`cacheScope` annotation, and no
 * pass-through of real tool names for clients holding a stale list. The flag is
 * read from the environment at process launch and cannot change while the
 * process lives, exactly like `allowWrites`, so the listing never varies at
 * runtime and the caching concern that rules out `listChanged` here does not
 * arise.
 */

// ─── recording the registration ──────────────────────────────────────────────

type ToolConfig = {
  description?: string;
  inputSchema?: Record<string, z.ZodType>;
  annotations?: Record<string, unknown>;
};

type ToolHandler = (...args: never[]) => unknown;

type Declaration = { name: string; config: ToolConfig; handler: ToolHandler };

/**
 * A stand-in server that records what would have been registered.
 *
 * Typed as a whole `McpServer` and cast once, here, rather than narrowed to a
 * `Pick<…, "registerTool">` that every surface's `registerTools` would then
 * have to widen its parameter to accept — eight signatures and the ~95
 * functions beneath them, changed to describe a fact that is already true.
 *
 * The cast is safe by inspection, and the inspection is the point: all 95
 * `registerTool` call sites across the eight surfaces call this one method and
 * nothing else, and not one uses its return value. If a registrar ever reaches
 * for `registerPrompt` or `server.server`, it will fail here at runtime rather
 * than quietly registering into a void — which is why this returns a bare
 * object instead of a Proxy that would forward the difference to a real server
 * and half-register a surface.
 */
const recorder = (into: Declaration[]): McpServer =>
  ({
    registerTool: (name: string, config: ToolConfig, handler: ToolHandler) => {
      into.push({ name, config, handler });
      return undefined;
    },
  }) as unknown as McpServer;

// ─── the index ───────────────────────────────────────────────────────────────

/** Terms shorter than this are dropped: they match everything and rank nothing. */
const SHORTEST_TERM = 3;
/** How much of a description is printed per row. The whole of it is searched. */
const SUMMARY_LIMIT = 160;
const SEARCH_LIMIT = 25;
/** Partial matches are low precision by construction, so fewer of them. */
const PARTIAL_LIMIT = 10;
const INDEX_LIMIT = 200;

/**
 * Rank tiers, best first, SUMMED across the query's terms.
 *
 * Summing rather than taking the best single term is deliberate: a two-word
 * query scored on its luckiest word ranks a tool that matched one term above a
 * tool that matched both.
 */
const RANK = { exactName: 0, namePrefix: 1, nameSubstring: 2, summary: 3, tail: 4, missing: 5 };

type Indexed = {
  name: string;
  summary: string;
  /** name + summary. Decides how WELL a term matched. */
  head: string;
  /** name + the entire description. Decides WHETHER it matched at all. */
  whole: string;
};

const summarize = (description: string): string => {
  const flat = description.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
};

const index = (decl: Declaration): Indexed => {
  const description = decl.config.description ?? "";
  const summary = summarize(description);
  return {
    name: decl.name,
    summary,
    head: `${decl.name} ${summary}`.toLowerCase(),
    whole: `${decl.name} ${description}`.toLowerCase(),
  };
};

/**
 * Regular plural fold, guarded.
 *
 * The guards are the whole point: without them `status` searches for `statu`,
 * `class` for `clas` and `focus` for `focu`, and a three-letter term like `ios`
 * loses a third of itself.
 */
const singular = (term: string): string => {
  if (term.length <= SHORTEST_TERM) return term;
  if (term.endsWith("ss") || term.endsWith("us")) return term;
  return term.endsWith("s") ? term.slice(0, -1) : term;
};

const queryTerms = (query: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = raw.trim();
    if (term.length < SHORTEST_TERM || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
};

const rankTerm = (term: string, entry: Indexed): number => {
  const name = entry.name.toLowerCase();
  const folded = singular(term);
  const hit = (haystack: string): boolean => haystack.includes(term) || haystack.includes(folded);
  if (name === term) return RANK.exactName;
  if (name.startsWith(term)) return RANK.namePrefix;
  if (hit(name)) return RANK.nameSubstring;
  if (hit(entry.head)) return RANK.summary;
  if (hit(entry.whole)) return RANK.tail;
  return RANK.missing;
};

type SearchResult = {
  rows: Indexed[];
  /** How many entries matched as well as the best ones, before the cap. */
  matched: number;
  /** Query words no returned row matched. Named back to the caller. */
  missed: string[];
  partial: boolean;
};

/**
 * Find tools for a query.
 *
 * An empty query returns the server's OWN order rather than an alphabetised
 * one: the registrars group related tools together, and sorting throws that
 * grouping away for no gain.
 *
 * Nothing may cache this keyed on the query — a row's tier is a property of the
 * query AND of the whole catalog it was ranked against.
 */
const find = (entries: Indexed[], query: string): SearchResult => {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return {
      rows: entries.slice(0, INDEX_LIMIT),
      matched: entries.length,
      missed: [],
      partial: false,
    };
  }

  const scored = entries.map((entry) => {
    let total = 0;
    let matched = 0;
    const missed: string[] = [];
    for (const term of terms) {
      const rank = rankTerm(term, entry);
      total += rank;
      if (rank === RANK.missing) missed.push(term);
      else matched += 1;
    }
    return { entry, total, matched, missed };
  });

  const best = scored.reduce((acc, s) => Math.max(acc, s.matched), 0);
  if (best === 0) return { rows: [], matched: 0, missed: terms, partial: false };

  const group = scored
    .filter((s) => s.matched === best)
    .toSorted((a, b) => a.total - b.total || a.entry.name.localeCompare(b.entry.name));
  const partial = best < terms.length;
  // Filtered from the ordered term list, never collected from a Set, so the
  // sentence a caller reads is the same on every run.
  const missed = partial ? terms.filter((t) => group.every((g) => g.missed.includes(t))) : [];
  return {
    rows: group.slice(0, partial ? PARTIAL_LIMIT : SEARCH_LIMIT).map((g) => g.entry),
    matched: group.length,
    missed,
    partial,
  };
};

/**
 * Suggestions for a name that is not in the catalog.
 *
 * Substring search cannot find a string that appears nowhere, so a typo needs
 * its own answer: shared underscore-separated words first, then the longest
 * common prefix.
 *
 * Both comparisons run on the name with `apple_<surface>_` REMOVED. Every tool
 * on a surface shares that prefix, so comparing whole names makes every tool
 * share two words with every other and "did you mean" answers with the first
 * few tools in the catalog — worse than saying nothing, because it reads like a
 * real suggestion. Measured before the fix: `apple_mail_send_messge` suggested
 * `apple_mail_list_accounts`.
 */
const nearest = (names: string[], wanted: string, prefix: string): string[] => {
  const strip = (n: string): string =>
    n.toLowerCase().startsWith(`${prefix}_`) ? n.slice(prefix.length + 1) : n;
  const target = strip(wanted);
  const words = new Set(
    target
      .toLowerCase()
      .split("_")
      .filter((w) => w.length >= SHORTEST_TERM),
  );
  const shared = names.filter((n) =>
    strip(n)
      .toLowerCase()
      .split("_")
      .some((w) => words.has(w)),
  );
  if (shared.length > 0) return shared.slice(0, 5);

  const common = (n: string): number => {
    const candidate = strip(n).toLowerCase();
    const lower = target.toLowerCase();
    let i = 0;
    while (i < candidate.length && i < lower.length && candidate[i] === lower[i]) i += 1;
    return i;
  };
  const ranked = names.toSorted((a, b) => common(b) - common(a) || a.localeCompare(b));
  /*
   * A one- or two-letter overlap is coincidence, not a near miss. Returning
   * nothing lets the caller read "no tool named X" as the whole answer and go
   * to the search tool, which is the move that actually works.
   */
  const bestName = ranked[0];
  if (bestName === undefined || common(bestName) < SHORTEST_TERM) return [];
  return ranked.filter((n) => common(n) >= SHORTEST_TERM).slice(0, 3);
};

// ─── rendering ───────────────────────────────────────────────────────────────

/** The three names a search result has to point the caller at. */
type FacadeNames = { search: string; describe: string; call: string };

const renderSearch = (result: SearchResult, total: number, names: FacadeNames): string => {
  if (result.rows.length === 0) {
    return `No tool matches. ${total} tools are available — call ${names.search} with no query to list them all.`;
  }
  const rows = result.rows.map((r) => `${r.name} — ${r.summary}`).join("\n");
  let notice = "";
  if (result.partial) {
    // Naming the words that missed is the difference between a caller
    // rephrasing and a caller giving up and asking for the whole listing.
    const which = result.missed.length > 0 ? ` (no match for ${result.missed.join(", ")})` : "";
    notice = `No tool matched every word${which}. Closest:\n`;
  }
  // Three numbers kept apart on purpose: shown, matched, and the catalog total.
  const footer = `${result.rows.length} of ${total} tools. Read a schema with ${names.describe}, then run it with ${names.call}.`;
  return `${notice}${rows}\n\n${footer}`;
};

/**
 * A tool's declaration as a client would have received it.
 *
 * Built from the recorded zod shape rather than re-derived by hand, so
 * `describe` and a non-lazy listing cannot drift. `$schema` is dropped for the
 * same reason `listing.ts` drops it from `tools/list`.
 */
const describe = (decl: Declaration): Record<string, unknown> => {
  const shape = decl.config.inputSchema;
  const schema = shape ? (z.toJSONSchema(z.object(shape)) as Record<string, unknown>) : undefined;
  if (schema) delete schema["$schema"];
  return {
    name: decl.name,
    ...(decl.config.description === undefined ? {} : { description: decl.config.description }),
    ...(schema === undefined ? {} : { inputSchema: schema }),
    ...(decl.config.annotations === undefined ? {} : { annotations: decl.config.annotations }),
  };
};

// ─── dispatch ────────────────────────────────────────────────────────────────

/**
 * Run a recorded tool, reproducing the validation the SDK would have done.
 *
 * Under a facade the SDK never sees the real call, so it never parses the real
 * arguments. Skipping this would hand every handler unvalidated input — the one
 * way a facade can be actively less safe than the listing it replaced.
 */
const invoke = async (decl: Declaration, args: unknown, extra: unknown): Promise<unknown> => {
  const shape = decl.config.inputSchema;
  if (!shape) return (decl.handler as unknown as (e: unknown) => unknown)(extra);
  const parsed = await z.object(shape).safeParseAsync(args ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(`Invalid arguments for ${decl.name}: ${why}`);
  }
  return (decl.handler as unknown as (a: unknown, e: unknown) => unknown)(parsed.data, extra);
};

// ─── the entry point ─────────────────────────────────────────────────────────

export type LazyToolsOptions = {
  /** Surface id as in surfaces.json, e.g. "mail". Prefixes every facade name. */
  surface: string;
  /** Display name, e.g. "Mail". Used only in the facade's own descriptions. */
  displayName: string;
  lazy: boolean;
  allowWrites: boolean;
};

/**
 * Register a surface's tools, either directly or behind the facade.
 *
 * The callback takes `allowWrites` rather than closing over it so the facade
 * can run it a second time with the gate forced shut and learn which tools are
 * writes. Everything else it needs — the client, the config — it closes over as
 * before.
 */
export const withLazyTools = (
  server: McpServer,
  opts: LazyToolsOptions,
  register: (target: McpServer, allowWrites: boolean) => void,
): void => {
  if (!opts.lazy) {
    register(server, opts.allowWrites);
    return;
  }

  const all: Declaration[] = [];
  register(recorder(all), opts.allowWrites);

  let writeNames = new Set<string>();
  if (opts.allowWrites) {
    const readsOnly: Declaration[] = [];
    register(recorder(readsOnly), false);
    const readNames = new Set(readsOnly.map((d) => d.name));
    writeNames = new Set(all.filter((d) => !readNames.has(d.name)).map((d) => d.name));
  }

  const prefix = `apple_${opts.surface}`;

  /*
   * Diagnostics stays eagerly listed. It is the tool every surface guide points
   * at first when something returns `degraded: true` or a permission error, and
   * a model that has just been refused should not have to discover the search
   * tool before it can find out why. All eight cost 3,766 B combined.
   */
  const eagerName = `${prefix}_diagnostics`;
  const eager = all.filter((d) => d.name === eagerName);
  for (const decl of eager)
    server.registerTool(decl.name, decl.config as never, decl.handler as never);

  const lazy = all.filter((d) => d.name !== eagerName);
  const reads = lazy.filter((d) => !writeNames.has(d.name));
  const writes = lazy.filter((d) => writeNames.has(d.name));
  const byName = new Map(lazy.map((d) => [d.name, d]));
  const readIndex = reads.map(index);
  const writeIndex = writes.map(index);
  const allIndex = [...readIndex, ...writeIndex];

  const searchName = `${prefix}_search_tools`;
  const describeName = `${prefix}_describe_tool`;
  const callName = `${prefix}_call_tool`;
  const callWriteName = `${prefix}_call_write_tool`;

  server.registerTool(
    searchName,
    {
      description:
        `Find ${opts.displayName} tools by what you want to do. This server loads its ` +
        `${allIndex.length} tools on demand: they are not listed up front, and this is how you ` +
        `reach them. Returns matching tool names with a one-line summary each. Call with no ` +
        `query to list everything. Read a schema with ${describeName}, then run it with ` +
        `${callName}` +
        (writes.length > 0 ? ` or ${callWriteName}` : "") +
        `.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("What you want to do, e.g. 'search messages' or 'unread'. Omit to list all."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ query }) =>
      okText(
        renderSearch(find(allIndex, query ?? ""), allIndex.length, {
          search: searchName,
          describe: describeName,
          call: callName,
        }),
      ),
  );

  server.registerTool(
    describeName,
    {
      description:
        `Get the full description and input schema of one ${opts.displayName} tool, as it would ` +
        `have appeared in a normal tool listing. Find names with ${searchName} first.`,
      inputSchema: {
        name: z.string().describe(`Exact tool name, e.g. ${lazy[0]?.name ?? callName}.`),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ name }) => {
      const decl = byName.get(name);
      if (!decl) {
        const suggestions = nearest([...byName.keys()], name, prefix);
        return fail(
          `No tool named ${name}.` +
            (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
        );
      }
      const runner = writeNames.has(name) ? callWriteName : callName;
      return okText(
        `${JSON.stringify(describe(decl))}\n\nCall it with ${runner}: {"name": ${JSON.stringify(name)}, "arguments": {…}}.`,
      );
    },
  );

  server.registerTool(
    callName,
    {
      description:
        `Run one of this server's read-only ${opts.displayName} tools. Find a name with ` +
        `${searchName} and its arguments with ${describeName}. Reads only: it cannot reach ` +
        (writes.length > 0
          ? `anything that changes ${opts.displayName} — those go through ${callWriteName}.`
          : `anything that changes ${opts.displayName}, and this server has writes turned off.`),
      inputSchema: {
        name: z.string().describe("Exact tool name to run."),
        arguments: z.record(z.string(), z.unknown()).optional().describe("That tool's arguments."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name, arguments: args }, extra) => {
      const decl = byName.get(name);
      if (!decl) {
        const suggestions = nearest([...byName.keys()], name, prefix);
        return fail(
          `No tool named ${name}.` +
            (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
        );
      }
      if (writeNames.has(name)) {
        return fail(
          `${name} changes ${opts.displayName}, so it cannot be run through ${callName}. Use ${callWriteName}.`,
        );
      }
      return (await invoke(decl, args, extra)) as ToolResult;
    },
  );

  /*
   * Absent, not present-and-empty, when the gate is shut. A dispatcher that
   * exists and refuses everything is exactly the "registered but refuses" shape
   * docs/alternatives.md holds against a competitor.
   */
  if (writes.length > 0) {
    // Named in full rather than counted. A permission prompt that says only
    // "a Mail write tool" tells the person approving it nothing about the
    // blast radius, and this description is the only place left that can.
    const writeList = writes.map((d) => d.name.slice(prefix.length + 1)).join(", ");
    server.registerTool(
      callWriteName,
      {
        description:
          `Run one of this server's ${writes.length} ${opts.displayName} tools that CHANGE data ` +
          `— ${writeList}. Find arguments ` +
          `with ${describeName}. Read-only tools go through ${callName} instead.`,
        inputSchema: {
          name: z.string().describe("Exact tool name to run."),
          arguments: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("That tool's arguments."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ name, arguments: args }, extra) => {
        const decl = byName.get(name);
        if (!decl) {
          const suggestions = nearest([...writeNames], name, prefix);
          return fail(
            `No tool named ${name}.` +
              (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
          );
        }
        if (!writeNames.has(name)) {
          return fail(`${name} is read-only. Use ${callName}.`);
        }
        return (await invoke(decl, args, extra)) as ToolResult;
      },
    );
  }
};
