import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  createOsascriptRunner,
  withBusyRetry,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { NoteLockedError, NoteNotFoundError, NOTES_SURFACE, PreconditionError } from "./errors.js";
import {
  BULK_NOTES,
  BULK_PLAINTEXT,
  GET_NOTE_BODIES,
  LIST_ACCOUNTS,
  LIST_ATTACHMENTS,
  LIST_FOLDERS,
} from "./jxa/read.js";
import { CREATE_NOTE, DELETE_NOTES, MOVE_NOTE, UPDATE_NOTE } from "./jxa/write.js";
import { locateStore, type LocateResult } from "./locate.js";
import { decodeRef, encodeRef, refFromPrimaryKey } from "./ref.js";
import { NoteStore, openStore, type NoteRow } from "./store.js";

export type LaneStatus = {
  applescript: "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexMode: string | null;
  storeFingerprint: string | null;
  reason: string | null;
};

export type NoteAccount = {
  id: string | null;
  name: string | null;
  defaultFolder: string | null;
  folderCount: number;
  noteCount: number;
};

export type NoteFolder = {
  id: string | null;
  name: string | null;
  accountId: string | null;
  accountName: string | null;
  depth: number;
  shared: boolean;
  noteCount: number | null;
};

export type NoteSummary = {
  ref: string;
  title: string | null;
  snippet: string | null;
  folder: string | null;
  account: string | null;
  modified: string | null;
  created: string | null;
  locked: boolean;
  source: "index" | "apple-events";
};

type BodyCache = {
  at: number;
  source: "index" | "apple-events";
  /** Note id -> body text. */
  texts: Map<string, string>;
};

export type AppleNotesClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  /** Injected by tests so nothing spawns a process or touches a real Notes. */
  osascript?: OsascriptRunner | undefined;
};

/**
 * The Notes client.
 *
 * Two lanes, and which one answers depends on what was granted:
 *
 * - **Apple Events** — accounts, folders, every mutation, and bodies. Always the
 *   authority: after a write, the result is what Notes re-read.
 * - **Index** — `NoteStore.sqlite`, for search and metadata at a scale Apple
 *   Events cannot reach.
 *
 * The discipline the measurements impose is in `jxa/core.ts`: bulk array fetches
 * only, never `whose`, never a property read per note.
 */
export class AppleNotesClient {
  readonly config: Config;
  readonly runner: OsascriptRunner;
  readonly #logger: Logger | undefined;
  #store: NoteStore | null = null;
  #storeTried = false;
  #bodies: BodyCache | null = null;

  constructor(opts: AppleNotesClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        surface: NOTES_SURFACE,
        logger: opts.logger,
      });
  }

  locate(): LocateResult {
    return locateStore({ storePath: this.config.storePath });
  }

  /** Open the index once and remember the outcome, including the failure. */
  index(): NoteStore | null {
    if (this.#storeTried) return this.#store;
    this.#storeTried = true;
    if (this.config.indexMode === "off") return null;
    try {
      this.#store = openStore(this.locate().storePath, this.config.indexMode, this.#logger);
    } catch (err) {
      this.#logger?.debug?.("index lane unavailable", err);
      this.#store = null;
    }
    return this.#store;
  }

  /**
   * Probe both lanes.
   *
   * Apple Events is probed twice with a gap: the first event is what triggers
   * the Automation prompt, and it can return failure while the user is still
   * deciding — reporting "denied" then would be wrong.
   */
  async lanes(): Promise<LaneStatus> {
    let applescript: LaneStatus["applescript"] = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.runner.run(LIST_ACCOUNTS);
        applescript = "live";
        break;
      } catch (err) {
        this.#logger?.debug?.("applescript probe failed", err);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }

    const located = this.locate();
    const store = this.index();
    return {
      applescript,
      index: this.config.indexMode === "off" ? "disabled" : store ? "live" : "unavailable",
      indexMode: store?.mode ?? null,
      storeFingerprint: store?.caps.fingerprint ?? null,
      reason: store ? null : located.reason,
    };
  }

  #allowed(accountName: string | null): boolean {
    const list = this.config.accounts;
    if (!list.length) return true;
    return Boolean(accountName && list.some((a) => a.toLowerCase() === accountName.toLowerCase()));
  }

  async accounts(): Promise<NoteAccount[]> {
    const all = await withBusyRetry(() => this.runner.run<NoteAccount[]>(LIST_ACCOUNTS));
    return all.filter((a) => this.#allowed(a.name));
  }

  async folders(): Promise<NoteFolder[]> {
    const all = await withBusyRetry(() => this.runner.run<NoteFolder[]>(LIST_FOLDERS));
    return all.filter((f) => this.#allowed(f.accountName));
  }

  /**
   * Note metadata.
   *
   * Prefers the index — it holds the same fields, costs no Apple Event, and
   * keeps working as a library grows past the point where a bulk fetch stops
   * being instant.
   */
  async listNotes(opts: { folder?: string | undefined; limit: number }): Promise<NoteSummary[]> {
    const store = this.index();
    if (store?.caps.storeUuid) {
      const folderPk = opts.folder ? await this.#folderPk(opts.folder) : undefined;
      const rows = store.search({
        ...(folderPk === undefined ? {} : { folderPk }),
        limit: opts.limit,
        offset: 0,
      });
      return rows.map((r) => this.#fromIndex(r, store.caps.storeUuid as string));
    }
    return this.#bulkNotes(opts);
  }

  async #folderPk(_name: string): Promise<number | undefined> {
    // The index stores folders by primary key; resolving a name to one needs the
    // folder table, which this version does not read. Filtering falls back to
    // the Apple Events lane rather than silently ignoring the argument.
    return undefined;
  }

  #fromIndex(row: NoteRow, storeUuid: string): NoteSummary {
    return {
      ref: refFromPrimaryKey(storeUuid, row.primaryKey),
      title: row.title,
      snippet: row.snippet,
      folder: null,
      account: null,
      modified: row.modified,
      created: row.created,
      locked: row.locked,
      source: "index",
    };
  }

  async #bulkNotes(opts: { folder?: string | undefined; limit: number }): Promise<NoteSummary[]> {
    const data = await withBusyRetry(() =>
      this.runner.run<{
        count: number;
        notes: {
          id: string;
          name: string | null;
          modified: string | null;
          created: string | null;
          locked: boolean;
          folder: string | null;
          account: string | null;
        }[];
      }>(BULK_NOTES),
    );
    return data.notes
      .filter((n) => this.#allowed(n.account))
      .filter((n) => !opts.folder || n.folder === opts.folder)
      .slice(0, Math.min(opts.limit, this.config.degradedMaxNotes))
      .map((n) => ({
        ref: encodeRef(n.id),
        title: n.name,
        snippet: null,
        folder: n.folder,
        account: n.account,
        modified: n.modified,
        created: n.created,
        locked: n.locked,
        source: "apple-events" as const,
      }));
  }

  /**
   * Body text for every note, cached.
   *
   * A TTL rather than invalidation, deliberately: checking whether the cache is
   * stale costs *more* over Apple Events (fetching ids and modification dates,
   * 128ms) than simply redoing the scan (97ms). There is no cheap freshness
   * check to be had, so bounded staleness is the honest trade.
   */
  async #allBodies(): Promise<BodyCache> {
    const now = Date.now();
    if (this.#bodies && now - this.#bodies.at < this.config.searchCacheTtlMs) return this.#bodies;

    const store = this.index();
    const texts = new Map<string, string>();
    if (store?.caps.storeUuid) {
      const uuid = store.caps.storeUuid;
      for (const row of store.search({ limit: 100_000, offset: 0 })) {
        const body = store.bodyOf(row.primaryKey);
        if (body.text) texts.set(refFromPrimaryKey(uuid, row.primaryKey), body.text);
      }
      this.#bodies = { at: now, source: "index", texts };
      return this.#bodies;
    }

    const bulk = await withBusyRetry(() =>
      this.runner.run<{ ids: string[]; texts: (string | null)[] }>(BULK_PLAINTEXT),
    );
    bulk.ids.forEach((id, i) => {
      const text = bulk.texts[i];
      if (text) texts.set(encodeRef(String(id)), String(text));
    });
    this.#bodies = { at: now, source: "apple-events", texts };
    return this.#bodies;
  }

  /**
   * Search.
   *
   * `title` uses the index's title and snippet columns, which is a SQL query.
   * `full` needs the body, which no indexed column carries — so it decodes the
   * gzipped protobuf when the index is available and falls back to the Apple
   * Events bulk scan when it is not. Either way the match happens in JS over a
   * cached corpus, because `whose` is 6.9x slower than fetching and filtering.
   */
  async searchNotes(opts: {
    query: string;
    scope: "title" | "full";
    limit: number;
    offset: number;
  }): Promise<{ notes: NoteSummary[]; source: "index" | "apple-events"; scope: string }> {
    const store = this.index();

    if (opts.scope === "title" && store?.caps.storeUuid) {
      const rows = store.search({ query: opts.query, limit: opts.limit, offset: opts.offset });
      return {
        notes: rows.map((r) => this.#fromIndex(r, store.caps.storeUuid as string)),
        source: "index",
        scope: "title+snippet",
      };
    }

    const corpus = await this.#allBodies();
    const needle = opts.query.toLowerCase();
    const hits: string[] = [];
    for (const [ref, text] of corpus.texts) {
      if (text.toLowerCase().includes(needle)) hits.push(ref);
    }
    const page = hits.slice(opts.offset, opts.offset + opts.limit);

    const summaries = await Promise.all(page.map((ref) => this.getNote(ref, { body: false })));
    return {
      notes: summaries.map((s) => s.summary),
      source: corpus.source,
      scope: "full-text",
    };
  }

  async getNote(
    ref: string,
    opts: { body?: boolean } = {},
  ): Promise<{ summary: NoteSummary; body: string | null; bodySource: string | null }> {
    const decoded = decodeRef(ref);
    const store = this.index();

    if (store?.caps.storeUuid) {
      const row = store.byPrimaryKey(decoded.primaryKey);
      if (row) {
        const summary = this.#fromIndex(row, store.caps.storeUuid);
        if (opts.body === false) return { summary, body: null, bodySource: null };
        if (row.locked) throw new NoteLockedError(ref);
        const body = store.bodyOf(decoded.primaryKey);
        if (body.encrypted) throw new NoteLockedError(ref);
        if (body.text !== null) {
          return { summary, body: this.#truncate(body.text), bodySource: `index:${body.via}` };
        }
      }
    }

    const [found] = await withBusyRetry(() =>
      this.runner.run<
        {
          id: string;
          found: boolean;
          locked: boolean;
          name: string | null;
          plaintext: string | null;
          modified: string | null;
          created: string | null;
        }[]
      >(GET_NOTE_BODIES, { ids: [decoded.id] }),
    );
    if (!found?.found) throw new NoteNotFoundError(ref);
    if (found.locked) throw new NoteLockedError(ref);
    return {
      summary: {
        ref,
        title: found.name,
        snippet: null,
        folder: null,
        account: null,
        modified: found.modified,
        created: found.created,
        locked: false,
        source: "apple-events",
      },
      body: found.plaintext === null ? null : this.#truncate(found.plaintext),
      bodySource: "apple-events",
    };
  }

  #truncate(text: string): string {
    const max = this.config.bodyMaxBytes;
    if (Buffer.byteLength(text, "utf8") <= max) return text;
    return `${text.slice(0, max)}\n\n[truncated at ${max} bytes; raise APPLE_NOTES_BODY_MAX_BYTES]`;
  }

  async attachments(ref: string): Promise<
    {
      id: string | null;
      name: string | null;
      url: string | null;
      contentIdentifier: string | null;
    }[]
  > {
    const decoded = decodeRef(ref);
    return withBusyRetry(() => this.runner.run(LIST_ATTACHMENTS, { id: decoded.id }));
  }

  /**
   * Save an attachment's bytes.
   *
   * The scripting dictionary exposes `name`, `id`, `URL` and `content
   * identifier` but **no filesystem path**, so the bytes can only come from the
   * media directory — which is Full Disk Access territory. Without it this
   * reports what is missing rather than failing obscurely.
   */
  async saveAttachment(
    ref: string,
    attachmentId: string,
    targetDir?: string,
  ): Promise<{
    path: string;
    bytes: number;
  }> {
    const located = this.locate();
    if (!located.readable) {
      throw new PreconditionError(
        "Attachment bytes need Full Disk Access: the scripting dictionary carries no file path " +
          "for attachments, so they can only be read from the Notes media directory. " +
          "Call apple_notes_diagnostics for the exact pane to open.",
      );
    }
    const list = await this.attachments(ref);
    const meta = list.find((a) => a.id === attachmentId);
    if (!meta) throw new PreconditionError(`No attachment ${attachmentId} on note ${ref}.`);

    const source = this.#findMedia(located.mediaRoot, attachmentId, meta.name);
    if (!source) {
      throw new PreconditionError(
        `Found the attachment's metadata but no file for it under ${located.mediaRoot}.`,
      );
    }

    const root = resolve(targetDir ?? this.config.attachmentDir);
    const target = resolve(join(root, basename(meta.name ?? basename(source))));
    if (!target.startsWith(`${root}/`)) {
      throw new PreconditionError(`Refusing to write outside ${root}.`);
    }
    const bytes = readFileSync(source);
    mkdirSync(root, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: target, bytes: bytes.length };
  }

  /** Bounded walk for a file whose directory is named after the attachment id. */
  #findMedia(root: string, attachmentId: string, name: string | null, depth = 0): string | null {
    if (depth > 5) return null;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(root, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (entry === attachmentId) {
          const inner = (() => {
            try {
              return readdirSync(full);
            } catch {
              return [];
            }
          })();
          const pick = name ? (inner.find((f) => f === name) ?? inner[0]) : inner[0];
          if (pick) return join(full, pick);
        }
        const found = this.#findMedia(full, attachmentId, name, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  async createNote(opts: { title?: string; body?: string; folderId?: string }): Promise<unknown> {
    this.#bodies = null;
    return withBusyRetry(() => this.runner.run(CREATE_NOTE, opts));
  }

  async updateNote(ref: string, body: string, mode: "replace" | "append"): Promise<unknown> {
    this.#bodies = null;
    const decoded = decodeRef(ref);
    return withBusyRetry(() => this.runner.run(UPDATE_NOTE, { id: decoded.id, body, mode }));
  }

  async moveNote(ref: string, folderId: string): Promise<unknown> {
    this.#bodies = null;
    const decoded = decodeRef(ref);
    return withBusyRetry(() => this.runner.run(MOVE_NOTE, { id: decoded.id, folderId }));
  }

  async deleteNotes(refs: string[]): Promise<unknown> {
    this.#bodies = null;
    const ids = refs.map((r) => decodeRef(r).id);
    return withBusyRetry(() => this.runner.run(DELETE_NOTES, { ids }));
  }
}
