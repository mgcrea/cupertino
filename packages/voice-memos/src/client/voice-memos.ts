import { statSync } from "node:fs";
import { extname } from "node:path";

import { type Logger, openReadOnly, parseBound, type ReadOnlyMode } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { RecordingNotFoundError, VoiceMemosStoreUnavailableError } from "./errors.js";
import { FDA_HINT, type LocateResult, locateStore } from "./locate.js";
import {
  type FolderRow,
  type RecordingRow,
  VERIFIED_FINGERPRINT,
  VoiceMemosStore,
} from "./store.js";
import { TranscriptCache } from "./transcript-cache.js";
import { type Segment, type Transcript, transcriptText } from "./transcript.js";

export type AudioFormat = "m4a" | "qta" | "unknown";

export type RecordingView = Omit<RecordingRow, "audioPath" | "changeToken" | "folderId"> & {
  folder: { id: string; name: string | null } | null;
  audio: { format: AudioFormat; bytes: number } | null;
};

type OkTranscript = Extract<Transcript, { status: "ok" }>;
/** A page of an `ok` transcript: `text` in text format, `segments` in segment format. */
export type TranscriptPage = Omit<OkTranscript, "segments"> & {
  segments?: Segment[];
  text?: string;
  /** Present when there is more: pass it back as `offset`. */
  nextOffset?: number;
};

export type ListQuery = {
  folderId?: string | undefined;
  favorite?: boolean | undefined;
  since?: string | undefined;
  until?: string | undefined;
  includeDeleted?: boolean | undefined;
  onlyDeleted?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type GetOptions = {
  format?: "text" | "segments" | undefined;
  offset?: number | undefined;
  maxChars?: number | undefined;
  maxSegments?: number | undefined;
};

export type SearchQuery = {
  query: string;
  includeDeleted?: boolean | undefined;
  limit?: number | undefined;
};

export type SearchHit = { recording: RecordingView; title: boolean; segments: Segment[] };

export const DEFAULT_MAX_CHARS = 20_000;
export const DEFAULT_MAX_SEGMENTS = 200;
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 20;
export const SEGMENTS_PER_HIT = 3;

/** Case and accents folded, so "cafe" finds "Café". */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const formatOf = (path: string): AudioFormat => {
  const ext = extname(path).toLowerCase();
  return ext === ".m4a" ? "m4a" : ext === ".qta" ? "qta" : "unknown";
};

export type VoiceMemosStatus = {
  store: LocateResult & { opened: boolean; mode: "ro" | "immutable" | null; error: string | null };
  schema: { fingerprint: string | null; verified: boolean };
  counts: { recordings: number; deleted: number; favorites: number; folders: number } | null;
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  /** Injected by tests so discovery never reaches anyone's real home. */
  home?: string | undefined;
};

/**
 * The surface's one client. It opens the store lazily, once, and every read goes through
 * `store()`, which throws `VoiceMemosStoreUnavailableError` rather than returning nothing:
 * an empty list reads exactly like a person who has never recorded a memo.
 */
export class VoiceMemosClient {
  readonly #config: Config;
  readonly #logger: Logger | undefined;
  readonly #home: string | undefined;

  #located: LocateResult | null = null;
  #store: VoiceMemosStore | null = null;
  #mode: "ro" | "immutable" | null = null;
  #storeError: string | null = null;
  readonly #transcripts = new TranscriptCache();

  constructor(opts: CreateClientOptions) {
    this.#config = opts.config;
    this.#logger = opts.logger;
    this.#home = opts.home;
  }

  get config(): Config {
    return this.#config;
  }

  located(): LocateResult {
    this.#located ??= locateStore({ storePath: this.#config.storePath, home: this.#home });
    return this.#located;
  }

  /** Open the store, once, lazily. */
  store(): VoiceMemosStore {
    if (this.#store) return this.#store;
    if (this.#storeError !== null) throw new VoiceMemosStoreUnavailableError(this.#storeError);
    const located = this.located();
    if (!located.readable) {
      this.#storeError = located.reason ?? "Voice Memos' store could not be read.";
      throw new VoiceMemosStoreUnavailableError(this.#storeError);
    }
    try {
      const opened = openReadOnly(located.storePath, this.#config.indexMode as ReadOnlyMode, {
        envVar: "APPLE_VOICE_MEMOS_INDEX_MODE",
        label: "Voice Memos' store",
        hint: FDA_HINT,
        onFallback: () =>
          this.#logger?.warn?.(
            "Voice Memos' store opened immutable=1: reads may miss a recording made moments ago.",
          ),
      });
      this.#mode = opened.mode;
      this.#store = new VoiceMemosStore(opened.db, located.directory);
      return this.#store;
    } catch (err) {
      this.#storeError = err instanceof Error ? err.message : String(err);
      throw new VoiceMemosStoreUnavailableError(this.#storeError);
    }
  }

  listFolders(): FolderRow[] {
    return this.store().listFolders();
  }

  /** Recordings, newest first. Never opens audio for a transcript: this has to stay cheap. */
  listRecordings(q: ListQuery): { recordings: RecordingView[]; total: number; truncated?: string } {
    const since = q.since === undefined ? undefined : parseBound("since", q.since, "start");
    const until = q.until === undefined ? undefined : parseBound("until", q.until, "end");
    const rows = this.store()
      .listRecordings()
      .filter((r) => {
        if (q.onlyDeleted) {
          if (r.deletedAt === null) return false;
        } else if (!q.includeDeleted && r.deletedAt !== null) return false;
        if (q.folderId !== undefined && r.folderId !== q.folderId) return false;
        if (q.favorite !== undefined && r.favorite !== q.favorite) return false;
        if (since || until) {
          const t = r.recordedAt === null ? NaN : Date.parse(r.recordedAt);
          if (Number.isNaN(t)) return false;
          if (since && t < since.getTime()) return false;
          if (until && t >= until.getTime()) return false;
        }
        return true;
      });
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.max(1, q.limit ?? DEFAULT_LIST_LIMIT);
    const page = rows.slice(offset, offset + limit);
    const folders = this.#folderNames();
    const recordings = page.map((r) => this.#view(r, folders));
    const next = offset + page.length;
    return {
      recordings,
      total: rows.length,
      ...(next < rows.length
        ? {
            truncated: `Showing ${page.length} of ${rows.length} from offset ${offset}; call again with offset ${next} for more.`,
          }
        : {}),
    };
  }

  /** One recording, Recently Deleted included, with its transcript as text or segments, paged. */
  getRecording(
    id: string,
    o: GetOptions = {},
  ): RecordingView & { transcript: Exclude<Transcript, OkTranscript> | TranscriptPage } {
    const row = this.store()
      .listRecordings()
      .find((r) => r.id === id);
    if (!row) throw new RecordingNotFoundError(id);
    const view = this.#view(row, this.#folderNames());
    const transcript = this.#transcriptOf(row);
    if (transcript.status !== "ok") return { ...view, transcript };
    const offset = Math.max(0, o.offset ?? 0);
    if (o.format === "segments") {
      const max = Math.max(1, o.maxSegments ?? DEFAULT_MAX_SEGMENTS);
      const segments = transcript.segments.slice(offset, offset + max);
      const next = offset + segments.length;
      return {
        ...view,
        transcript: {
          status: "ok",
          locale: transcript.locale,
          segments,
          ...(next < transcript.segments.length ? { nextOffset: next } : {}),
        },
      };
    }
    const full = transcriptText(transcript.segments);
    const max = Math.max(1, o.maxChars ?? DEFAULT_MAX_CHARS);
    const text = full.slice(offset, offset + max);
    const next = offset + text.length;
    return {
      ...view,
      transcript: {
        status: "ok",
        locale: transcript.locale,
        text,
        ...(next < full.length ? { nextOffset: next } : {}),
      },
    };
  }

  /** Titles and transcript text, case- and accent-insensitive, newest first. Never the label. */
  searchRecordings(q: SearchQuery): { hits: SearchHit[]; truncated?: string } {
    const needle = fold(q.query.trim());
    if (!needle) return { hits: [] };
    const limit = Math.max(1, q.limit ?? DEFAULT_SEARCH_LIMIT);
    const folders = this.#folderNames();
    const hits: SearchHit[] = [];
    let more = false;
    for (const row of this.store().listRecordings()) {
      if (!q.includeDeleted && row.deletedAt !== null) continue;
      const title = row.title !== null && fold(row.title).includes(needle);
      const transcript = this.#transcriptOf(row);
      const segments =
        transcript.status === "ok"
          ? transcript.segments
              .filter((s) => fold(s.text).includes(needle))
              .slice(0, SEGMENTS_PER_HIT)
          : [];
      if (!title && segments.length === 0) continue;
      if (hits.length === limit) {
        more = true;
        break;
      }
      hits.push({ recording: this.#view(row, folders), title, segments });
    }
    return {
      hits,
      ...(more
        ? { truncated: `Stopped at limit ${limit}; narrow the query or raise the limit.` }
        : {}),
    };
  }

  #folderNames(): Map<string, string | null> {
    return new Map(
      this.store()
        .listFolders()
        .map((f) => [f.id, f.name]),
    );
  }

  #transcriptOf(row: RecordingRow): Transcript {
    return row.audioPath ? this.#transcripts.read(row.audioPath) : { status: "no-audio" };
  }

  #view(row: RecordingRow, folders: Map<string, string | null>): RecordingView {
    const { audioPath, changeToken: _changeToken, folderId, ...rest } = row;
    let audio: RecordingView["audio"] = null;
    if (audioPath) {
      try {
        audio = { format: formatOf(audioPath), bytes: statSync(audioPath).size };
      } catch {
        audio = null;
      }
    }
    return {
      ...rest,
      folder: folderId === null ? null : { id: folderId, name: folders.get(folderId) ?? null },
      audio,
    };
  }

  /** Everything diagnostics needs, with no failure allowed to fail the call. */
  status(): VoiceMemosStatus {
    const located = this.located();
    let store: VoiceMemosStore | null = null;
    let error: string | null = null;
    try {
      store = this.store();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (!store) {
      return {
        store: { ...located, opened: false, mode: null, error },
        schema: { fingerprint: null, verified: false },
        counts: null,
      };
    }
    const fingerprint = store.schemaFingerprint();
    const rows = store.listRecordings();
    return {
      store: { ...located, opened: true, mode: this.#mode, error: null },
      schema: { fingerprint, verified: fingerprint === VERIFIED_FINGERPRINT },
      counts: {
        recordings: rows.length,
        deleted: rows.filter((r) => r.deletedAt !== null).length,
        favorites: rows.filter((r) => r.favorite).length,
        folders: store.listFolders().length,
      },
    };
  }
}
