# Voice Memos Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `voice-memos` MCP surface that lists, reads and searches Voice Memos recordings and Apple's embedded transcripts, plus one write-gated tool that exports the audio.

**Architecture:** A new node package `packages/voice-memos`, built from `packages/maps`' layout. Reads go through the file lane: `CloudRecordings.db` via `openReadOnly`. Transcripts come from a positioned-read MP4/QuickTime box walker that never reads `mdat`. The surface goes into `surfaces.json`, and `make surfaces` generates the wiring.

**Tech Stack:** TypeScript 7, Node ≥ 24 (`node:sqlite`), zod 4, `@modelcontextprotocol/server` 2.4, vitest 4, tsdown.

**Spec:** [docs/superpowers/specs/2026-11-10-voice-memos-design.md](../specs/2026-11-10-voice-memos-design.md). Findings: [docs/voice-memos.md](../../voice-memos.md). Read both before Task 1.

## Global Constraints

- Work on a branch in a worktree under `.claude/worktrees/voice-memos` (git-ignored, checked). Never on `main`.
- Surface id `voice-memos`, package `@mgcrea/mcp-apple-voice-memos`, bin `apple-voice-memos-mcp`, env prefix `APPLE_VOICE_MEMOS_`, tool prefix `apple_voice_memos_`.
- Package `version` equals the other packages' (1.37.1 today); `pnpm version:check` must pass.
- No new runtime dependencies beyond what `packages/maps/package.json` lists.
- Core Data epoch: seconds since 2001-01-01, offset `978_307_200`.
- Verified schema fingerprint `fb804d4a4d59` (macOS 27.2).
- `timeRange` is `[start, end]` in seconds. Runs carry their own leading space.
- Never read `mdat`. Transcript payloads above 16 MiB are refused as `unreadable`.
- Tests use synthetic rows and synthetic audio only. No real recording, title or transcript enters the repo.
- Don't touch `apps/website/src/data/surfaces.ts` (no card), `docs/alternatives.md` or `docs/desktop.md` (other uncommitted work).
- Each commit passes `pnpm lint`, `pnpm format:check`, the package's `test` and `typecheck`, and `make surfaces-check`.

## Review Focus

1. **A 342 KB transcript (15 000 runs).** `get_recording` pages it and returns `nextOffset`; nothing is silently cut. Pinned in Task 5.
2. **A row with `ZPATH` null** (measured: one 2019 row). It lists with `audio: null` and transcript status `no-audio`, and `save_recording` refuses with that reason. Pinned in Tasks 3 and 6.
3. **A `ZPATH` that escapes `Recordings/`** (`../x.m4a`, absolute) is treated as missing and never opened. Pinned in Task 3.
4. **Accents and case in search:** `cafe` finds `Café` in a title and in a transcript. Pinned in Task 5.
5. **A truncated or corrupt audio file:** transcript status `unreadable` with the reason, while the recording's metadata still lists. Pinned in Tasks 1 and 5.

---

### Task 1: Box walker (`client/mp4.ts`)

**Files:**

- Create: `packages/voice-memos/src/client/mp4.ts`
- Create: `packages/voice-memos/test/helpers/audio.ts`
- Test: `packages/voice-memos/test/mp4.test.ts`

(The package skeleton does not exist yet. Create `package.json`, `tsconfig.json` and `tsdown.config.ts` copied from `packages/maps`, with the names above, so vitest runs. The rest of the skeleton is Task 4.)

**Interfaces:**

- Produces:
  ```ts
  export type ReadAt = (position: number, length: number) => Uint8Array; // short read at EOF is allowed
  export type TranscriptContainer = "tsrp-box" | "qt-keyed-item";
  export type AudioScan = {
    brand: string | null;            // ftyp major brand, trimmed: "M4A", "qt"
    format: "m4a" | "qta" | "unknown";
    transcript: { container: TranscriptContainer; bytes: Uint8Array } | null;
  };
  export class AudioParseError extends Error {}
  export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
  export const scanAudio = (read: ReadAt, size: number): AudioScan; // throws AudioParseError
  export const scanAudioFile = (path: string): AudioScan;            // fs wrapper, closes its fd
  ```
- Test helper (used by Tasks 3, 5 and 6):
  ```ts
  export const box: (type: string, ...payload: Uint8Array[]) => Uint8Array;
  export const m4aWithTranscript: (json: unknown | null) => Uint8Array; // null = no tsrp box
  export const qtaWithTranscript: (json: unknown | null) => Uint8Array;
  export const readerOf: (bytes: Uint8Array) => ReadAt;
  ```

**Layouts the helper must build** (measured, see docs/voice-memos.md):

- M4A: `ftyp`(major `M4A `) · `moov`[`mvhd`, `trak`[`udta`[`tsrp`(UTF-8 JSON)]], `udta`[`meta`(**FullBox**: 4 zero bytes, then `hdlr`, `ilst`)]] · `mdat`.
- QTA: `ftyp`(major `qt  `) · `moov`[`trak`[`meta`(**plain box**: `hdlr` first) [`hdlr`, `keys`(FullBox: 4 B version/flags, u32 count, then per entry u32 size + `mdta` + name `com.apple.VoiceMemos.tsrp`), `ilst`[box whose type is u32 `1` [`data`(u32 size, `data`, u32 type 0, u32 locale 0, payload)]]]]] · `mdat`.

- [ ] **Step 1: Write the failing tests** in `test/mp4.test.ts`:
  - `finds the tsrp box in an M4A`: `scanAudio(readerOf(m4aWithTranscript({a:1})), len)` → `{ brand: "M4A", format: "m4a", transcript.container: "tsrp-box" }`, and the bytes parse to `{a:1}`.
  - `finds the keyed item in a QTA`: same with `qtaWithTranscript` → `format: "qta"`, `container: "qt-keyed-item"`.
  - `reads a QuickTime meta without a version header and an ISO meta with one`: both helpers carry a `meta`, and both scan without throwing.
  - `returns transcript null when there is none`: `m4aWithTranscript(null)` → `transcript: null`.
  - `never reads mdat`: wrap `readerOf` to record every `(position, length)`. No read may overlap the `mdat` payload range beyond its 16-byte header.
  - `handles a 64-bit box size and a size-0 last box`.
  - `throws AudioParseError on a box that overruns its parent`: truncate the M4A by 10 bytes inside `moov`.
  - `refuses a transcript over MAX_TRANSCRIPT_BYTES`: a `tsrp` header that declares 17 MiB → `AudioParseError` whose message names the size.
- [ ] **Step 2: Run it and check it fails.** `pnpm --filter @mgcrea/mcp-apple-voice-memos test -- mp4` → FAIL, module not found.
- [ ] **Step 3: Implement `scanAudio`.** Descend only into `moov trak mdia minf udta meta ilst edts`. Peek at the four bytes after a `meta` header: `hdlr` means a plain box, anything else means skip 4. Resolve `ilst` item types against the sibling `keys` names. Stop at the first transcript found.
- [ ] **Step 4: Run it and check it passes.** Same command → PASS.
- [ ] **Step 5: Commit.** `git add packages/voice-memos && git commit -m "feat(voice-memos): walk M4A and QuickTime boxes to find Apple's transcript"`

### Task 2: Transcript decoder (`client/transcript.ts`)

**Files:**

- Create: `packages/voice-memos/src/client/transcript.ts`
- Test: `packages/voice-memos/test/transcript.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type Segment = { start: number; end: number; text: string };
  export type Transcript =
    | { status: "ok"; locale: string | null; segments: Segment[] }
    | { status: "empty"; locale: string | null }   // attributedString === ""
    | { status: "none" }                           // file has no transcript
    | { status: "no-audio" }                       // row has no file
    | { status: "unreadable"; reason: string };
  export const SEGMENTING = { maxGapSeconds: 1.0, maxWordSeconds: 1.0, maxChars: 400 } as const;
  export const decodeTranscript = (bytes: Uint8Array): Transcript; // ok | empty | unreadable
  export const transcriptText = (segments: Segment[]): string;     // segments joined by "\n"
  ```

- [ ] **Step 1: Write the failing tests.**
  - `decodes runs + attributeTable`: runs `["Hello",0," world.",1," Next",2]`, table `[[0,0.4],[0.4,0.9],[0.9,1.2]]` (each as `{timeRange}`), locale `{identifier:"en_US"}` → one segment break after `world.`: `[{start:0,end:0.9,text:"Hello world."},{start:0.9,end:1.2,text:"Next"}]`.
  - `decodes the flat alternating array`: `["Hi",{timeRange:[0,0.3]}," there",{timeRange:[0.3,0.6]}]` → `[{start:0,end:0.6,text:"Hi there"}]`.
  - `reports empty for attributedString ""` → `{status:"empty", locale:"en_US"}`.
  - `breaks after a word wider than maxWordSeconds`: a run with timeRange `[1,2.5]` ends its segment.
  - `breaks at a gap over maxGapSeconds`.
  - `caps a segment at maxChars` without splitting a word.
  - `drops the space before a punctuation-only run`: runs `"Yes"`, `" ,"`, `" sir"` → `"Yes, sir"`.
  - `is unreadable, not empty, on bad JSON or an unknown shape`: the `reason` names which.
  - `transcriptText` joins segments with `\n`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.** Normalise both variants to words `{text, start, end}`, then segment. Strip whitespace before a run made only of `.` or `,`. Trim each segment.
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** `feat(voice-memos): decode Apple's transcript JSON into timed segments`

### Task 3: Locate and read the store (`client/locate.ts`, `client/store.ts`)

**Files:**

- Create: `packages/voice-memos/src/client/locate.ts`, `packages/voice-memos/src/client/store.ts`, `packages/voice-memos/src/client/errors.ts`
- Test: `packages/voice-memos/test/store.test.ts`, `packages/voice-memos/test/locate.test.ts`
- Uses: `packages/voice-memos/test/fixtures/cloud-recordings.sql` (exists)

**Interfaces:**

- Consumes: `describeStore`, `inspectFile`, `openReadOnly`, `type ReadOnlyMode` from `@mgcrea/mcp-apple-core`.
- Produces:
  ```ts
  // errors.ts
  export const VOICE_MEMOS_SURFACE: SurfaceContext = {
    appName: "Voice Memos",
    envPrefix: "APPLE_VOICE_MEMOS",
  };
  export class VoiceMemosStoreUnavailableError extends AppleAutomationError {} // copy of Maps' wording: no second lane
  export class RecordingNotFoundError extends AppleAutomationError {} // (id: string)
  // locate.ts
  export const GROUP_RECORDINGS_DIR = [
    "Library",
    "Group Containers",
    "group.com.apple.VoiceMemos.shared",
    "Recordings",
  ];
  export const LEGACY_RECORDINGS_DIR = [
    "Library",
    "Application Support",
    "com.apple.voicememos",
    "Recordings",
  ];
  export const STORE_FILENAME = "CloudRecordings.db";
  export type LocateResult = StoreFacts & {
    directory: string;
    storePath: string;
    legacy: boolean;
    reason: string | null;
  };
  export const locateStore: (opts?: { storePath?: string; home?: string }) => LocateResult;
  // store.ts
  export const VERIFIED_FINGERPRINT = "fb804d4a4d59";
  export type RecordingRow = {
    id: string;
    title: string | null;
    label: string | null;
    recordedAt: string | null;
    duration: number | null;
    folderId: string | null;
    favorite: boolean;
    deletedAt: string | null;
    audioPath: string | null; // absolute, confined to the Recordings directory, else null
    changeToken: number; // Z_OPT
  };
  export type FolderRow = { id: string; name: string | null; rank: number | null; count: number };
  export class VoiceMemosStore {
    constructor(db: DatabaseSync, recordingsDir: string);
    listRecordings(): RecordingRow[]; // every row, deleted included, newest first
    listFolders(): FolderRow[]; // ZRANK order
    schemaFingerprint(): string;
  }
  ```

**Rules** (spec, Field mapping, plus "Schema and macOS versions"):

- `title`: `ZENCRYPTEDTITLE` trimmed, or null. If that column is absent: `ZCUSTOMLABEL` unless it matches `/^[0-9TZ:.\- ]+$/`.
- `label`: `ZCUSTOMLABEL`. `favorite`: `(ZSHAREDFLAGS ?? 0) & 1`. `deletedAt`: `ZEVICTIONDATE` as ISO.
- `folderId`: `ZFOLDER.ZUUID` via a `LEFT JOIN` on `ZFOLDER.Z_PK`.
- Every column is checked against `PRAGMA table_info` before it is selected; a missing one yields null.
- `schemaFingerprint`: the sha256 (first 12 hex chars) of the `sql` of every `sqlite_master` row with non-null `sql` and a name not starting `sqlite_`, ordered tables, then indexes, then views, then the rest, then by name, joined with `\n`. This is the same algorithm as `scripts/lib/probe-kit.mjs` `dumpSchema`.
- `audioPath`: `resolve(recordingsDir, ZPATH)` when the result is inside `recordingsDir + sep`; null otherwise and when `ZPATH` is null.
- `locateStore`: the group directory first, then legacy (`legacy: true`), then an explicit `storePath` overrides both. `reason` names Full Disk Access when the store exists but is unreadable (copy Maps' `FDA_HINT`, saying "Voice Memos.app").

- [ ] **Step 1: Write the failing tests.** Build the fixture in `:memory:` (as `packages/maps/test/store.test.ts` does) and insert synthetic rows.
  - `maps a recording row`: all fields, and `recordedAt` for `ZDATE = 784000000` → `"2025-11-05T01:46:40.000Z"`.
  - `title is null, not the label, when ZENCRYPTEDTITLE is empty`.
  - `falls back to ZCUSTOMLABEL for title when ZENCRYPTEDTITLE is absent`: drop the column from a copy of the fixture. A date-shaped label still gives null.
  - `favorite reads bit 0x1 of ZSHAREDFLAGS`, for null, `0`, `1` and `3`.
  - `deletedAt is set only when ZEVICTIONDATE is`.
  - `audioPath is null for a null ZPATH, "../x.m4a" and "/etc/passwd"` (Review Focus 2 and 3).
  - `lists folders in ZRANK order with ZCOUNTOFRECORDINGS`.
  - `fingerprint is stable and differs when a column is added`.
  - `locate.test.ts`: the group dir is chosen over legacy; legacy is chosen when the group dir is absent; explicit `storePath` wins; `reason` mentions Full Disk Access for an unreadable file (use a `chmod 000` temp file).
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** `feat(voice-memos): read recordings and folders from CloudRecordings.db`

### Task 4: Surface, package skeleton, diagnostics

**Files:**

- Modify: `surfaces.json`: add the entry from the spec, after `maps`. Its `notes` cover the lane verdict, the ZENCRYPTEDTITLE trap and the two-container transcript, in the style of the Maps entry.
- Run: `make surfaces` (regenerates Swift, bridge, Makefile regions, CI loop, bundler entry, `.mcp.json`, the website `id` union). Review the diff.
- Create in `packages/voice-memos/`: `README.md`, `LICENSE`, `server.json`, `.release-it.json`, and `src/{index,cli,server,config,build-info,guide}.ts`, `src/client/voice-memos.ts` (status only for now), `src/tools/{index,util,diagnostics}.ts`, each mirroring `packages/maps`. No `prompts.ts`: this surface ships no prompts.
- Test: `packages/voice-memos/test/surface.test.ts`, `packages/voice-memos/test/tools.test.ts`, `packages/voice-memos/test/config.test.ts`

**Interfaces:**

- Produces:
  ```ts
  // config.ts — BaseConfigSchema.extend({...}).strict()
  storePath?: string;                                   // APPLE_VOICE_MEMOS_STORE
  indexMode: "auto" | "ro" | "immutable" | "off";       // APPLE_VOICE_MEMOS_INDEX_MODE, default "auto"
  exportDir: string;                                    // APPLE_VOICE_MEMOS_EXPORT_DIR, default join(homedir(), "Downloads")
  // plus the BaseConfigSchema keys loaded exactly as packages/maps/src/config.ts loads them
  export const loadConfig: (env?: NodeJS.ProcessEnv) => Config;
  // client/voice-memos.ts
  export class VoiceMemosClient {
    constructor(opts: { config: Config; logger?: Logger; home?: string });
    status(): VoiceMemosStatus;
  }
  export type VoiceMemosStatus = {
    store: LocateResult & { opened: boolean; mode: "ro" | "immutable" | null; error: string | null };
    schema: { fingerprint: string | null; verified: boolean };
    counts: { recordings: number; deleted: number; favorites: number; folders: number } | null;
  };
  // server.ts
  export const createServer: (opts: { config: Config; logger?: Logger; home?: string }) => { server: McpServer; client: VoiceMemosClient };
  ```
- `apple_voice_memos_diagnostics` returns `status()` plus `transcripts: { checked, withTranscript, byFormat: Record<"m4a"|"qta"|"unknown", {files, withTranscript}>, unreadable }` over non-deleted rows. It is computed with `scanAudioFile` and gives the box-level answer only; it decodes nothing.

- [ ] **Step 1: Write the failing tests.**
  - `surface.test.ts`: resources are exactly `cupertino://voice-memos/guide` and `cupertino://voice-memos/diagnostics`. Diagnostics parses as JSON with `home: "/nonexistent-home"`. The guide states there is no transcription and no editing.
  - `tools.test.ts` with `EXPECTED = ["apple_voice_memos_diagnostics"]` for now. Tasks 5 and 6 extend this list. Every listed tool must be registered even with no store.
  - `config.test.ts`: `exportDir` defaults to `~/Downloads`; `APPLE_VOICE_MEMOS_EXPORT_DIR` overrides it; an unknown key is rejected (strict).
  - `diagnostics reports schema.verified false for the fixture`: the fixture has dropped triggers, so its fingerprint differs. `VERIFIED_FINGERPRINT` comparison is the rule.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** The package `test` and `typecheck` pass, `make surfaces-check` passes, `pnpm version:check` passes, and `make smoke` shows the new surface handshaking (the CI loop is generated).
- [ ] **Step 5: Commit.** `feat(voice-memos): register the surface and its diagnostics`

### Task 5: Read tools

**Files:**

- Modify: `packages/voice-memos/src/client/voice-memos.ts`
- Create: `packages/voice-memos/src/tools/recordings.ts`
- Modify: `packages/voice-memos/src/tools/index.ts`, `packages/voice-memos/test/tools.test.ts`
- Test: `packages/voice-memos/test/client.test.ts` (temp dir holding the fixture DB plus synthetic audio from `test/helpers/audio.ts`; client constructed with `config.storePath`)

**Interfaces:**

- Consumes: `VoiceMemosStore`, `scanAudioFile`, `decodeTranscript`, `transcriptText`, `Transcript`, `Segment`.
- Produces on `VoiceMemosClient`:
  ```ts
  type RecordingView = Omit<RecordingRow, "audioPath" | "changeToken" | "folderId"> & {
    folder: { id: string; name: string | null } | null;
    audio: { format: "m4a" | "qta" | "unknown"; bytes: number } | null;
  };
  listFolders(): FolderRow[];
  listRecordings(q: { folderId?: string; favorite?: boolean; since?: string; until?: string;
                      includeDeleted?: boolean; onlyDeleted?: boolean; limit?: number; offset?: number })
    : { recordings: RecordingView[]; total: number; truncated?: string };
  getRecording(id: string, o?: { format?: "text" | "segments"; offset?: number; maxChars?: number; maxSegments?: number })
    : RecordingView & { transcript: Transcript | (Extract<Transcript,{status:"ok"}> & { text?: string; nextOffset?: number }) };
  searchRecordings(q: { query: string; includeDeleted?: boolean; limit?: number })
    : { hits: { recording: RecordingView; title: boolean; segments: Segment[] }[]; truncated?: string };
  ```
- Defaults: `format: "text"`, `maxChars: 20_000` (`offset` counts characters), `maxSegments: 200` (`offset` counts segments). Search returns `limit` 20 recordings and at most 3 segments per recording.
- Transcript cache: a `Map` keyed `${path}\0${mtimeMs}\0${size}`, holding at most 256 entries, oldest evicted first.
- `list_recordings` never opens audio for transcripts: `audio.bytes` comes from `stat`, and `format` from the extension (`.m4a` gives `m4a`, `.qta` gives `qta`).
- Search folds case and accents on both sides with `normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()`, and matches titles and segment text, never `label`.
- Tools (all `readOnlyHint: true`, wrapped with `wrap` from core): `apple_voice_memos_list_folders`, `apple_voice_memos_list_recordings`, `apple_voice_memos_get_recording`, `apple_voice_memos_search_recordings`. Each description says that transcripts exist only for recordings Apple transcribed (2025 on, measured), and that an unknown id means re-listing.

- [ ] **Step 1: Write the failing tests** in `client.test.ts`:
  - `lists newest first and hides Recently Deleted by default`. `onlyDeleted` returns just those, with `deletedAt` set.
  - `filters by folderId, favorite and since/until`.
  - `gets an M4A and a QTA transcript as text and as segments`.
  - `pages a long transcript`: synthesise 15 000 runs and check `nextOffset` is present. Concatenated pages equal `transcriptText` of the whole (Review Focus 1).
  - `reports no-audio for a row without ZPATH` (Review Focus 2), `none` for a file with no transcript, and `unreadable` with a reason for a truncated file (Review Focus 5). In all three the metadata is still returned.
  - `search finds "cafe" in a "Café" title and in transcript text`, and returns the segment's `start` (Review Focus 4).
  - `search skips deleted recordings unless includeDeleted`, and never matches the label.
  - `unknown id throws RecordingNotFoundError`.
  - `tools.test.ts`: `EXPECTED` gains the four tools, and every one has `readOnlyHint: true`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** `feat(voice-memos): list, read and search recordings and their transcripts`

### Task 6: Export tool

**Files:**

- Create: `packages/voice-memos/src/tools/export.ts`
- Modify: `packages/voice-memos/src/client/voice-memos.ts`, `packages/voice-memos/src/tools/index.ts`, `packages/voice-memos/test/tools.test.ts`, `packages/voice-memos/server.json` (add `APPLE_VOICE_MEMOS_EXPORT_DIR`)
- Test: `packages/voice-memos/test/export.test.ts`

**Interfaces:**

- Consumes: `writeConfinedFile` from core (`root: config.exportDir`, `settingName: "APPLE_VOICE_MEMOS_EXPORT_DIR"`).
- Produces: `VoiceMemosClient.saveRecording(id: string, o?: { directory?: string; overwrite?: boolean }): { path: string; bytes: number; format: "m4a" | "qta" | "unknown" }`.
- File name: `title`, else `label`, else `id`, plus the original extension. Characters outside `[\p{L}\p{N} ._-]` become `_`, the result is capped at 120 characters, and `basename` is applied.
- Tool `apple_voice_memos_save_recording`, registered only when `allowWrites`, with annotations `readOnlyHint: false, destructiveHint: false, idempotentHint: false`. Its description follows `apple_messages_save_attachment`'s: what it writes and where, that it never overwrites unless asked, that it is write-gated because it creates a file, and that the default folder is one Cadence can import from.

- [ ] **Step 1: Write the failing tests.**
  - `copies the audio byte for byte into exportDir with the title as name`.
  - `refuses to overwrite unless asked`.
  - `refuses a row without audio with the no-audio reason` (Review Focus 2).
  - `a title with "/" and ".." cannot leave exportDir`.
  - `tools.test.ts`: the tool is absent by default and present with `APPLE_VOICE_MEMOS_ALLOW_WRITES=1`, as exactly `[...EXPECTED, "apple_voice_memos_save_recording"]`.
- [ ] **Step 2: Run them and check they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and check they pass.**
- [ ] **Step 5: Commit.** `feat(voice-memos): export a recording's audio behind the write gate`

### Task 7: Live check, docs, changelog

**Files:**

- Create: `scripts/check-voice-memos-live.mjs`
- Modify: `docs/surfaces.md` (state-of-play row: "Voice Memos | **file lane only**, no `.sdef`; App Intents unreachable | implemented, read-only plus export"), `packages/voice-memos/README.md`, `CHANGELOG.md` (Unreleased section, in the existing entry style), `docs/voice-memos.md` (add a "Shipped" note giving the live-check result)

`check-voice-memos-live.mjs` spawns `packages/voice-memos/dist/cli.js` and speaks MCP over stdio, as the snippet in the repo memory on piping JSON-RPC does. It calls `diagnostics`, `list_recordings`, `get_recording` on the newest M4A and newest QTA with a transcript, and `search_recordings` with a word from that transcript. It prints **counts, statuses and timings only**, never a title or transcript text. It exits non-zero if any transcript status from 2025 on is not `ok`/`empty`, or if `schema.verified` is false. With `--export` it also saves those two recordings and prints their paths.

- [ ] **Step 1: Build.** `pnpm --filter @mgcrea/mcp-apple-voice-memos build`.
- [ ] **Step 2: Run the live check through `apple_shell_run` (Olivier approves).** `node scripts/check-voice-memos-live.mjs --export` with `APPLE_VOICE_MEMOS_ALLOW_WRITES=1`. Expected: 87 recordings (± his changes), `schema.verified: true`, 28 transcripts `ok` or `empty`, both exports written.
- [ ] **Step 3: Cadence intake.** `cadence_add_files` with the two exported paths and `transcribe: true`, then `cadence_wait`. Expected: both reach done. If the `.qta` fails, stop and report; do not add conversion.
- [ ] **Step 4: Ask Olivier before deleting the two exported files** from `~/Downloads`. They are copies of his recordings.
- [ ] **Step 5: Write the docs and the CHANGELOG entry.** Then run the full gate: `pnpm lint && pnpm format:check && pnpm test && pnpm typecheck && make surfaces-check && pnpm version:check`.
- [ ] **Step 6: Commit.** `docs(voice-memos): record the live check and announce the surface`

Release (first npm publish of a new package, npm trusted publisher, app rebuild) is not part of this plan. It goes through `cut-a-release`.
