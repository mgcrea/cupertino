/**
 * Pure helpers for network capture: the pieces that have no Safari in them, so
 * they can be tested without one. The chunked body pull, the tool surface and
 * the content script are built on top of these.
 *
 * The second half of the file is the server's client for the page's three
 * network commands. It takes a `run(command)` callback instead of the client
 * class so that the chunk loop, the reassembly and the save can be read (and
 * tested) without the lane orchestrator around them; `AppleSafariClient` only
 * supplies `run` and the settings.
 */

import { writeConfinedFile } from "@mgcrea/mcp-apple-core";

import { pageOfRequest, type Command, type CommandResult } from "./actions.js";
import { PageCommandTimeoutError, PreconditionError } from "./errors.js";

type PathResult = { ok: true; value: unknown } | { ok: false; error: string };

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number };

/**
 * Tokenise a path into keys and indices.
 *
 * Hand-rolled rather than a dependency because the grammar is four productions
 * (`$`, `.key`, `[n]`, `["quoted"]`) and because the error messages are the
 * product: this is what a model reads when it guessed the response shape wrong,
 * so each failure has to say where it stopped, not just that it did.
 */
function tokenize(path: string): Segment[] | string {
  const segments: Segment[] = [];
  let i = path.startsWith("$") ? 1 : 0;
  // A bare leading key ("data.x") is allowed; a dot is only a separator after
  // something, so "$.a" and "a" are both fine but "a..b" is not.
  let expectKey = i === 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === "[") {
      if (path[i + 1] === '"') {
        const end = path.indexOf('"]', i + 2);
        if (end < 0) return `Unterminated quoted key at position ${i} in "${path}".`;
        segments.push({ kind: "key", key: path.slice(i + 2, end) });
        i = end + 2;
      } else {
        const end = path.indexOf("]", i + 1);
        if (end < 0) return `Unterminated "[" at position ${i} in "${path}".`;
        const raw = path.slice(i + 1, end);
        if (!/^\d+$/.test(raw)) {
          return `Expected a number or a quoted key inside [] at position ${i} in "${path}", got "${raw}".`;
        }
        segments.push({ kind: "index", index: Number(raw) });
        i = end + 1;
      }
      expectKey = false;
    } else {
      if (ch === ".") {
        i += 1;
        expectKey = true;
      }
      if (!expectKey) return `Unexpected "${path[i]}" at position ${i} in "${path}".`;
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end += 1;
      if (end === i) return `Empty key at position ${i} in "${path}".`;
      segments.push({ kind: "key", key: path.slice(i, end) });
      i = end;
      expectKey = false;
    }
  }
  return segments;
}

const describeAt = (walked: string[]): string => (walked.length ? walked.join("") : "the root");

/**
 * Walk `path` through `root`. Never throws: a path that does not resolve is a
 * normal outcome of guessing at a response's shape, and the caller turns the
 * message into a tool error the model can correct itself from.
 */
export function resolveJsonPath(root: unknown, path: string): PathResult {
  const segments = tokenize(path);
  if (typeof segments === "string") return { ok: false, error: segments };

  let current = root;
  // Rendered as it is walked ("data.document", "items[0]") so a failure can
  // name its parent in the same notation the caller typed.
  const walked: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "index") {
      if (!Array.isArray(current)) {
        return {
          ok: false,
          error: `Cannot take index ${segment.index} of ${describeAt(walked)}: it is not an array.`,
        };
      }
      if (segment.index >= current.length) {
        return {
          ok: false,
          error: `No index ${segment.index} at ${describeAt(walked)}: it has length ${current.length}.`,
        };
      }
      current = current[segment.index];
      walked.push(`[${segment.index}]`);
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return {
          ok: false,
          error: `Cannot read key "${segment.key}" of ${describeAt(walked)}: it is not an object.`,
        };
      }
      // Own properties only: "constructor" or "toString" must not resolve
      // against the prototype chain of a parsed JSON object.
      if (!Object.hasOwn(current, segment.key)) {
        const keys = Object.keys(current);
        const shown = keys.slice(0, 20).join(", ") + (keys.length > 20 ? ", ..." : "");
        return {
          ok: false,
          error: `No key "${segment.key}" at ${describeAt(walked)}. Keys there: ${shown || "(none)"}.`,
        };
      }
      current = (current as Record<string, unknown>)[segment.key];
      walked.push(walked.length ? `.${segment.key}` : segment.key);
    }
  }
  return { ok: true, value: current };
}

/**
 * Decode base64 strictly.
 *
 * Node's `Buffer.from(s, "base64")` silently skips anything outside the
 * alphabet, so a truncated or mangled field decodes to a plausible but wrong
 * file with no signal. Validating first turns that into an error. Both the
 * standard and URL-safe alphabets are accepted (APIs return either), as is a
 * `data:*;base64,` prefix, since that is how a page often holds the same bytes.
 */
export function decodeBase64(text: string): Buffer {
  const stripped = text.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(stripped)) {
    const bad = stripped.search(/[^A-Za-z0-9+/_=-]/);
    throw new PreconditionError(
      `Not valid base64: unexpected character at position ${bad >= 0 ? bad : stripped.length} ` +
        `(standard and URL-safe alphabets are accepted).`,
    );
  }
  return Buffer.from(stripped, "base64");
}

/**
 * Name a file type from its first bytes, for a body whose Content-Type is
 * missing or lies (signing sites serve PDFs as octet-stream). Deliberately a
 * short list of unambiguous magic numbers; JSON is a guess from the first
 * character, so it is only reported for `{` and `[`.
 */
export function sniffType(bytes: Buffer): string | null {
  const starts = (...sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (starts(0x7b) || starts(0x5b)) return "application/json";
  return null;
}

/**
 * Header names whose values are never returned. Exact names for the standard
 * credentials, substrings for the custom ones every API invents (`x-csrf-token`,
 * `x-api-key`).
 *
 * The content script keeps a copy of this pattern because it is plain JS and
 * cannot import TypeScript; a test asserts the two sources agree. Keep it a
 * plain literal with only the `i` flag so that comparison stays trivial.
 */
export const REDACTED_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api-key|apikey/i;

/** Replace the value of every sensitive header with its length, keeping the name. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    out[name] = REDACTED_HEADER.test(name) ? `<redacted: ${value.length} chars>` : value;
  }
  return out;
}

// ── The client half ──────────────────────────────────────────────────────────

/** Sends one command to the page and returns its answer; supplied by the client. */
export type NetRun = (command: Omit<Command, "id" | "expiresAt">) => Promise<CommandResult>;

/** What `get` returns inline at most, however much the caller asks for. */
export const INLINE_CAP_CHARS = 20_000;

export type RecordState = {
  recording: boolean;
  page: string;
  expiresAt: string | number | null;
  options?: unknown;
  counts?: unknown;
  dropped?: unknown;
  hook?: {
    installed: boolean;
    /** Hook copies that answered a ping: "isolated" (the source provider), "main" (the recorder), both, or none. */
    worlds?: string[];
    /**
     * How the recorder was put into the page on this load. Safari ignores
     * `world: "MAIN"`, so `network.js` injects it as a `<script>`: inline,
     * or by URL (`src`) when the page's CSP refuses inline scripts, which
     * loads late and can miss the first requests. `blocked` means that load
     * failed too; `unavailable` that there was no source to inject; null that
     * nothing was attempted (never armed, or a page copy already answered).
     */
    injection?: "inline" | "src" | "blocked" | "unavailable" | null;
    /**
     * Why `injection` is not simply "inline": `"inline threw: <name: message>"`,
     * `"inline appended, no main answer"`, `"fallback threw: <message>"` (after
     * the inline reason, joined with "; "), or `"no source"`. Null otherwise.
     */
    injectionDetail?: string | null;
  };
  resourceStatusSupported?: boolean;
};

export type ListResult = {
  recording: boolean;
  page: string;
  entries: Record<string, unknown>[];
  next: string | null;
  dropped?: unknown;
};

export type GetResult = {
  entry: Record<string, unknown>;
  headers?: Record<string, string> | undefined;
  encoding: "text" | "base64" | "summary" | null;
  /** The page stored only the first `maxBodyBytes` of this body. */
  bodyTruncated: boolean;
  /** Absent when the body was saved: the bytes never travel back to the caller. */
  text?: string;
  offset: number;
  totalChars: number;
  truncated: boolean;
  nextOffset: number | null;
  saved?: { path: string; bytes: number; type: string | null };
};

type Slice = {
  entry: Record<string, unknown>;
  headers?: Record<string, string>;
  encoding: GetResult["encoding"];
  totalChars: number;
  offset: number;
  slice: string;
  done: boolean;
};

/**
 * A page's refusal becomes a tool error carrying the page's own words.
 *
 * Verbatim, because the page knows which of "unknown id", "evicted" and "wrong
 * page load" it is, and each one tells the caller a different next step (list
 * again, or give up on that body). Rewording it here could only lose that.
 */
const unwrap = <T>(result: CommandResult): T => {
  if (!result.ok) throw new PreconditionError(result.error ?? "The page refused the request.");
  return result.data as T;
};

export type RecordInput = {
  url: string;
  op: "start" | "stop" | "clear" | "status";
  kinds?: string[] | undefined;
  captureBodies?: boolean | undefined;
  bodyFilter?: string | undefined;
  maxBodyBytes?: number | undefined;
  armMinutes?: number | undefined;
  reload?: boolean | undefined;
};

export async function networkRecord(
  run: NetRun,
  settings: { allowWrites: boolean },
  input: RecordInput,
): Promise<RecordState> {
  // A reload throws away the page's state and may re-submit a form's request,
  // so it is a write in every sense `allowWrites` means, and is refused before
  // anything is sent. Recording alone is not: it only watches.
  if (input.reload && !settings.allowWrites) {
    throw new PreconditionError(
      "Reloading the tab to record from its first request is a write: it re-runs the page. " +
        "Set APPLE_SAFARI_ALLOW_WRITES=true, or start recording without reload and trigger the " +
        "request yourself.",
    );
  }
  const { url, ...rest } = input;
  return unwrap<RecordState>(await run({ action: "netRecord", url, ...rest }));
}

export async function networkList(
  run: NetRun,
  input: {
    url: string;
    filter?: Record<string, unknown> | undefined;
    after?: string | undefined;
    limit?: number | undefined;
  },
): Promise<ListResult> {
  return unwrap<ListResult>(
    await run({
      action: "netList",
      url: input.url,
      filter: input.filter,
      after: input.after,
      limit: input.limit,
    }),
  );
}

export type GetInput = {
  url: string;
  id: string;
  part?: "response" | "request" | undefined;
  headers?: boolean | undefined;
  jsonPath?: string | undefined;
  decode?: "base64" | undefined;
  offset?: number | undefined;
  maxChars?: number | undefined;
  saveAs?: string | undefined;
  overwrite?: boolean | undefined;
};

/**
 * Fetch a body from the page, in as many commands as it takes.
 *
 * ## Why chunks at all
 *
 * One answer travels through Safari's native-message channel, which has a size
 * limit, and a signed PDF as base64 is megabytes. So the page serves a slice
 * per command and this reassembles them. Two shapes of caller want different
 * amounts, and each pays only for what it asked:
 *
 *  - Inline: the window `[offset, offset + maxChars)`, at most the inline cap.
 *    Only the chunks covering it are pulled, so reading the head of a 40 MB body
 *    costs one command.
 *  - Anything that needs the WHOLE body (`jsonPath`, `decode`, `saveAs`):
 *    every chunk, because a JSON document cannot be parsed from its middle and
 *    a file cannot be saved from part of itself.
 */
export async function networkGet(
  run: NetRun,
  settings: { allowWrites: boolean; downloadDir: string; chunkChars: number },
  input: GetInput,
): Promise<GetResult> {
  const page = pageOfRequest(input.id);
  if (!page) {
    throw new PreconditionError(
      `"${input.id}" is not a request id from apple_safari_network_list. IDs look like ` +
        `"3f9a2c1d-r12" — the part before the dash names the page load that recorded it. ` +
        `Pass an id exactly as listed; never construct one.`,
    );
  }
  // Refused before the first command, so a caller without writes does not wait
  // out a multi-chunk pull only to be told it could never save the result.
  if (input.saveAs !== undefined && !settings.allowWrites) {
    throw new PreconditionError(
      "Saving a body to disk is a write. Set APPLE_SAFARI_ALLOW_WRITES=true to allow saveAs.",
    );
  }

  const whole =
    input.jsonPath !== undefined || input.decode !== undefined || input.saveAs !== undefined;
  const chunk = settings.chunkChars;
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const want = Math.max(1, Math.min(input.maxChars ?? INLINE_CAP_CHARS, INLINE_CAP_CHARS));

  // Which slice is wanted: everything, or the inline window.
  const from = whole ? 0 : offset;
  const limit = whole ? Number.POSITIVE_INFINITY : want;

  const pulled: string[] = [];
  let first: Slice | undefined;
  let position = from;
  let index = 0;
  let planned = 1;
  for (;;) {
    const length = Math.min(chunk, limit - (position - from));
    let slice: Slice;
    try {
      slice = unwrap<Slice>(
        await run({
          action: "netGet",
          url: input.url,
          page,
          requestId: input.id,
          part: input.part ?? "response",
          // Headers once: the page repeats them in every answer otherwise, and
          // a chunk's worth of channel is better spent on body. On unless the
          // caller said no, as the design has it (they are already redacted).
          headers: index === 0 ? input.headers !== false : false,
          offset: position,
          length,
        }),
      );
    } catch (error) {
      if (!(error instanceof PageCommandTimeoutError)) throw error;
      // Two different silences. Before the first answer, the likeliest cause
      // is the id itself: the native handler gives a page-addressed command
      // only to the page load that minted its token, so an id from a load that
      // has since gone is never claimed and looks exactly like a dead tab.
      // After the first answer the page demonstrably existed, so that
      // explanation is wrong and the honest one is that it went away mid-pull.
      throw new PageCommandTimeoutError(
        index === 0
          ? `No page answered for request ${input.id}. It was recorded by a page load that has ` +
              `since gone (reloaded, navigated or closed), or the tab is hidden and slow to ` +
              `answer; list again with apple_safari_network_list.`
          : `The page stopped answering partway through the body (chunk ${index + 1} of ` +
              `${planned}). The tab may have reloaded, navigated or closed; nothing was saved. ` +
              `List again and retry.`,
      );
    }
    first ??= slice;
    if (index === 0 && whole && slice.entry.bodyTruncated === true) {
      // The page keeps only the first `maxBodyBytes` of a larger body. Parsing
      // that as JSON fails confusingly, and saving it writes a corrupt file
      // that looks whole (a PDF missing its tail still opens as a PDF), so the
      // refusal comes before the rest is pulled, parsed or written.
      throw new PreconditionError(
        `The recorded body of ${input.id} was cut short at the recording's maxBodyBytes, so ` +
          `jsonPath, decode and saveAs would work from an incomplete body. Record again with a ` +
          `larger maxBodyBytes (up to 50 MiB), repeat the request, and get it again.`,
      );
    }
    if (index === 0) {
      const end = whole ? slice.totalChars : Math.min(slice.totalChars, from + limit);
      planned = Math.max(1, Math.ceil((end - from) / chunk));
    }
    pulled.push(slice.slice);
    position += slice.slice.length;
    index += 1;
    // An empty slice from a page that says it is not done would loop forever;
    // treat it as the end rather than trust it.
    if (slice.done || slice.slice.length === 0 || position - from >= limit) break;
  }

  const head = first as Slice;
  const body = pulled.join("");
  const base = {
    entry: head.entry,
    ...(head.headers ? { headers: head.headers } : {}),
    encoding: head.encoding,
    // Said on every answer, so an inline read of a cut-short body is never
    // mistaken for the whole of it.
    bodyTruncated: head.entry.bodyTruncated === true,
  };

  if (!whole) {
    const truncated = from + body.length < head.totalChars;
    return {
      ...base,
      text: body,
      offset: from,
      totalChars: head.totalChars,
      truncated,
      nextOffset: truncated ? from + body.length : null,
    };
  }

  if (head.encoding === null) {
    throw new PreconditionError(
      `Request ${input.id} has no ${input.part ?? "response"} body to read` +
        `${head.entry.bodyEvicted ? " (it was evicted from the buffer to make room)" : ""}.`,
    );
  }
  if (head.encoding === "summary" && input.saveAs !== undefined) {
    throw new PreconditionError(
      "The page kept only a summary of this body, not its bytes, so there is nothing to save. " +
        "Record again with captureBodies on and a larger maxBodyBytes.",
    );
  }

  // A body the page marked base64 holds binary; everything below that wants
  // TEXT (a JSON parse) looks at what those bytes spell, and everything that
  // wants BYTES (a save) decodes it once. `decode` on such a body is therefore
  // already done, not owed twice.
  const asText = (): string =>
    head.encoding === "base64" ? decodeBase64(body).toString("utf8") : body;

  let text: string | undefined;
  let bytes: Buffer | undefined;
  if (input.jsonPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(asText());
    } catch {
      throw new PreconditionError(
        `body is not JSON (content-type ${String(head.entry.contentType ?? "unknown")}), so ` +
          `jsonPath cannot select from it. Read it without jsonPath.`,
      );
    }
    const found = resolveJsonPath(parsed, input.jsonPath);
    if (!found.ok) throw new PreconditionError(found.error);
    if (input.decode === "base64") {
      if (typeof found.value !== "string") {
        throw new PreconditionError(
          `decode: "base64" the selected value must be a string: ${input.jsonPath} is ` +
            `${found.value === null ? "null" : Array.isArray(found.value) ? "an array" : typeof found.value}.`,
        );
      }
      bytes = decodeBase64(found.value);
    } else if (input.saveAs !== undefined) {
      bytes = Buffer.from(
        typeof found.value === "string" ? found.value : JSON.stringify(found.value),
        "utf8",
      );
    } else {
      text = JSON.stringify(found.value);
    }
  } else if (head.encoding === "base64" || input.decode === "base64") {
    bytes = decodeBase64(body);
  } else {
    text = body;
  }

  if (input.saveAs !== undefined) {
    const out = (bytes ?? Buffer.from(text ?? "", "utf8")) as Buffer;
    // The confinement lives in core: basename only, symlinks resolved, no
    // overwrite without being asked. The bytes are handed over once and are
    // deliberately not returned, so a PDF never lands in the model's context.
    const written = writeConfinedFile({
      root: settings.downloadDir,
      name: input.saveAs,
      bytes: out,
      overwrite: input.overwrite ?? false,
      settingName: "APPLE_SAFARI_DOWNLOAD_DIR",
    });
    return {
      ...base,
      offset: 0,
      totalChars: head.totalChars,
      truncated: false,
      nextOffset: null,
      saved: { path: written.path, bytes: written.bytes, type: sniffType(out) },
    };
  }

  // Not saving: the caller wants to read it, so it has to be text.
  if (text === undefined) {
    const decoded = bytes as Buffer;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      throw new PreconditionError(
        `The decoded value is ${decoded.length} bytes of binary (${sniffType(decoded) ?? "unknown type"}). ` +
          `Pass saveAs to write it to ${settings.downloadDir}.`,
      );
    }
  }
  const window = text.slice(offset, offset + want);
  const truncated = offset + window.length < text.length;
  return {
    ...base,
    text: window,
    offset,
    totalChars: text.length,
    truncated,
    nextOffset: truncated ? offset + window.length : null,
  };
}
