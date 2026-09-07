import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

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
import { ADD_ATTACHMENT, CREATE_NOTE, DELETE_NOTES, MOVE_NOTE, UPDATE_NOTE } from "./jxa/write.js";
import { locateStore, type LocateResult } from "./locate.js";
import { attachmentPrimaryKey, decodeRef, encodeRef, refFromPrimaryKey } from "./ref.js";
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

/**
 * A page of notes, plus the two facts a bare array had no room for: which lane
 * answered, and whether anything was left behind.
 *
 * `hasMore` is about the PAGE — more notes matched than `limit` allowed. `note`
 * is about the LANE: the Apple Events bulk read is capped independently of
 * `limit`, so a caller asking for 500 could be handed 200 with nothing saying
 * which of the two bounds stopped the list. Only the second one needs prose,
 * because only the second one is fixable by the person reading it.
 */
export type NoteListing = {
  notes: NoteSummary[];
  source: "index" | "apple-events";
  hasMore: boolean;
  note?: string;
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

  /**
   * Whether the index can answer this request FAITHFULLY.
   *
   * Two things it cannot do, and both used to be ignored rather than declined.
   *
   * The store has no readable account name on a note row — `#fromIndex` sets
   * `account: null` — so an account allowlist cannot be applied to index rows.
   * Answering from the index anyway ignored the one setting whose whole job is
   * limiting what gets read, and did so ONLY on machines with Full Disk Access,
   * which is exactly where it matters.
   *
   * And `folder` was accepted, resolved to `undefined` by a stub whose comment
   * claimed the opposite, and dropped: `list_notes({folder: "Projects"})`
   * returned the newest notes from every folder.
   *
   * Reminders reached the same conclusion first, in `#indexCanAnswer` there.
   */
  #indexCanAnswer(opts: { folder?: string | undefined } = {}): boolean {
    return this.config.accounts.length === 0 && !opts.folder;
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
  async listNotes(opts: { folder?: string | undefined; limit: number }): Promise<NoteListing> {
    const store = this.#indexCanAnswer(opts) ? this.index() : null;
    if (store?.caps.storeUuid) {
      // One row past the page, so a full page can be told from an exhausted
      // library. SQL is asked for it rather than counted separately: a COUNT
      // over the whole table costs more than the extra row on every call.
      const rows = store.search({ limit: opts.limit + 1, offset: 0 });
      const uuid = store.caps.storeUuid;
      return {
        notes: rows.slice(0, opts.limit).map((r) => this.#fromIndex(r, uuid)),
        source: "index",
        hasMore: rows.length > opts.limit,
      };
    }
    return this.#bulkNotes(opts);
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

  async #bulkNotes(opts: { folder?: string | undefined; limit: number }): Promise<NoteListing> {
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
    const matched = data.notes
      .filter((n) => this.#allowed(n.account))
      .filter((n) => !opts.folder || n.folder === opts.folder);
    const cap = Math.min(opts.limit, this.config.degradedMaxNotes);
    return {
      notes: matched.slice(0, cap).map((n) => ({
        ref: encodeRef(n.id),
        title: n.name,
        snippet: null,
        folder: n.folder,
        account: n.account,
        modified: n.modified,
        created: n.created,
        locked: n.locked,
        source: "apple-events" as const,
      })),
      source: "apple-events",
      hasMore: matched.length > cap,
      // Only when the LANE is what stopped the list — the cap sitting below a
      // larger `limit`, with more notes behind it. A caller whose own limit ran
      // out first is not being shortchanged and does not need telling.
      ...(matched.length > cap && this.config.degradedMaxNotes < opts.limit
        ? {
            note:
              `The Apple Events lane is capped at ${this.config.degradedMaxNotes} notes and you ` +
              `asked for ${opts.limit}, so this list stops short of what matched. Grant Full ` +
              `Disk Access to read Notes' own index instead, or raise ` +
              `APPLE_NOTES_DEGRADED_MAX_NOTES.`,
          }
        : {}),
    };
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

    const store = this.#indexCanAnswer() ? this.index() : null;
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
  }): Promise<NoteListing & { scope: string }> {
    const store = this.#indexCanAnswer() ? this.index() : null;

    if (opts.scope === "title" && store?.caps.storeUuid) {
      const rows = store.search({
        query: opts.query,
        limit: opts.limit + 1,
        offset: opts.offset,
      });
      const uuid = store.caps.storeUuid;
      return {
        notes: rows.slice(0, opts.limit).map((r) => this.#fromIndex(r, uuid)),
        source: "index",
        hasMore: rows.length > opts.limit,
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
      // Exact, not a guess: the corpus behind a full-text search is every note
      // in both lanes, so `hits` is the whole match set and not a page of it.
      hasMore: hits.length > opts.offset + opts.limit,
      scope: "full-text",
    };
  }

  async getNote(
    ref: string,
    opts: { body?: boolean } = {},
  ): Promise<{ summary: NoteSummary; body: string | null; bodySource: string | null }> {
    const decoded = decodeRef(ref);
    const store = this.#indexCanAnswer() ? this.index() : null;

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
    const listed = await withBusyRetry(() =>
      this.runner.run<
        {
          id: string | null;
          name: string | null;
          url: string | null;
          contentIdentifier: string | null;
        }[]
      >(LIST_ATTACHMENTS, { id: decoded.id }),
    );
    // Notes can enumerate the same attachment more than once — measured after a
    // `make`, where one new attachment appeared twice in the element collection
    // and `count of attachments` said 3 for 2 real ones. Passing that through
    // would have a caller save the same file twice, or believe a note holds
    // attachments it does not.
    const seen = new Set<string>();
    return listed.filter((a) => {
      if (!a.id) return true;
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
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
    opts: { overwrite?: boolean } = {},
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

    // ICAttachment holds no path, so the directory names come from the ICMedia
    // row it points at. That needs the index; without it there is nothing to
    // resolve against and saying so beats walking the tree for a name that is
    // not there.
    const pk = attachmentPrimaryKey(attachmentId);
    const media = pk === null ? null : (this.index()?.mediaFor(pk) ?? null);
    if (!media) {
      throw new PreconditionError(
        `Cannot resolve where ${attachmentId} is stored. Its media record is missing from ` +
          `NoteStore.sqlite, so there is no directory name to look for.`,
      );
    }

    const source = this.#findMedia(located.mediaRoot, media);
    if (!source) {
      throw new PreconditionError(
        `Found the attachment's metadata but no file for it under ${located.mediaRoot}.`,
      );
    }

    // The configured directory is the confinement boundary, not a default that
    // `targetDir` replaces: an override may only select a subdirectory of it.
    // Resolving the override *against* the root means a relative path lands
    // inside it and an absolute one is caught by the check below.
    const root = resolve(this.config.attachmentDir);
    const dir = targetDir ? resolve(root, targetDir) : root;
    if (dir !== root && !dir.startsWith(root + sep)) {
      throw new PreconditionError(
        `Refusing to write outside ${root}. Set APPLE_NOTES_ATTACHMENT_DIR to change the destination.`,
      );
    }
    // basename() first: the name comes from note content, which is
    // attacker-controlled in exactly the way path traversal needs.
    const name = basename(media.filename ?? meta.name ?? basename(source));
    const target = resolve(join(dir, name));
    if (target !== join(dir, name) || !target.startsWith(dir + sep)) {
      throw new PreconditionError(`Refusing to write outside ${dir}.`);
    }
    if (existsSync(target) && !opts.overwrite) {
      throw new PreconditionError(`${target} already exists; refusing to overwrite it.`);
    }
    const bytes = readFileSync(source);
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, bytes, { mode: 0o600 });
    return { path: target, bytes: bytes.length };
  }

  /**
   * The file for an ICMedia row.
   *
   * Layout, verified on a real store:
   *
   *     Accounts/<account>/Media/<identifier>/<generation>/<filename>
   *
   * The account directory is not known here, so each one is tried — there are a
   * handful, not thousands. Every segment after the identifier is treated as a
   * hint rather than a certainty: the generation directory is skipped when the
   * row has none, and a directory holding a single file answers even when the
   * filename on disk differs from the one recorded.
   */
  #findMedia(
    root: string,
    media: { identifier: string; generation: string | null; filename: string | null },
  ): string | null {
    const accounts = (() => {
      try {
        return readdirSync(root);
      } catch {
        return [];
      }
    })();

    const fileIn = (dir: string): string | null => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return null;
      }
      const files = entries.filter((e) => {
        try {
          return statSync(join(dir, e)).isFile();
        } catch {
          return false;
        }
      });
      if (media.filename && files.includes(media.filename)) return join(dir, media.filename);
      // A single file is unambiguous whatever it is called; several are not, and
      // guessing among them would hand back the wrong bytes silently.
      return files.length === 1 ? join(dir, files[0] as string) : null;
    };

    for (const account of accounts) {
      const base = join(root, account, "Media", media.identifier);
      try {
        if (!statSync(base).isDirectory()) continue;
      } catch {
        continue;
      }
      const candidates = media.generation ? [join(base, media.generation), base] : [base];
      for (const dir of candidates) {
        const hit = fileIn(dir);
        if (hit) return hit;
      }
      // The generation directory is named in the row, but fall back to whatever
      // single subdirectory is actually there rather than failing on a rename.
      const subdirs = (() => {
        try {
          return readdirSync(base).filter((e) => statSync(join(base, e)).isDirectory());
        } catch {
          return [];
        }
      })();
      if (subdirs.length === 1) {
        const hit = fileIn(join(base, subdirs[0] as string));
        if (hit) return hit;
      }
    }
    return null;
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  async createNote(opts: { title?: string; body?: string; folderId?: string }): Promise<unknown> {
    this.#bodies = null;
    return withBusyRetry(() => this.runner.run(CREATE_NOTE, opts));
  }

  /**
   * Attach a file to a note.
   *
   * The path is resolved and checked here rather than in JXA: Notes reports a
   * missing or unreadable file as a generic refusal, which would surface as
   * "Notes refused the file" for what is really a typo.
   */
  async addAttachment(ref: string, filePath: string): Promise<unknown> {
    const decoded = decodeRef(ref);
    const resolved = resolve(filePath);
    let stats;
    try {
      stats = statSync(resolved);
    } catch {
      throw new PreconditionError(`No file at ${resolved}.`);
    }
    if (!stats.isFile()) {
      throw new PreconditionError(`${resolved} is not a file.`);
    }
    this.#bodies = null;
    return withBusyRetry(() => this.runner.run(ADD_ATTACHMENT, { id: decoded.id, path: resolved }));
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
