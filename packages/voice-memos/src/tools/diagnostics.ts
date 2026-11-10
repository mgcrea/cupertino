import { existsSync } from "node:fs";
import { extname } from "node:path";

import { buildBaseDiagnostics } from "@mgcrea/mcp-apple-core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BUILD_INFO } from "../build-info.js";
import type { LaneStatus } from "../client/lane.js";
import { type AudioScan, scanAudioFile } from "../client/mp4.js";
import type { VoiceMemosClient } from "../client/voice-memos.js";
import { STORE_WRITE_TOOLS, WRITE_TOOLS } from "./names.js";
import { wrap } from "./util.js";

type Format = AudioScan["format"];

export type TranscriptCoverage = {
  /** Non-deleted recordings whose audio file was looked at. */
  checked: number;
  withTranscript: number;
  /** Rows with no ZPATH, or whose file is not on disk (an iCloud placeholder, say). */
  missingAudio: number;
  /** Files whose boxes would not parse. Never counted as "no transcript". */
  unreadable: number;
  byFormat: Record<Format, { files: number; withTranscript: number }>;
};

const formatFromName = (path: string): Format => {
  const ext = extname(path).toLowerCase();
  return ext === ".m4a" ? "m4a" : ext === ".qta" ? "qta" : "unknown";
};

/**
 * Box-level transcript coverage over the non-deleted recordings: whether a transcript is
 * present, by container. It decodes nothing, so it costs a few header reads per file.
 */
const transcriptCoverage = (client: VoiceMemosClient): TranscriptCoverage => {
  const coverage: TranscriptCoverage = {
    checked: 0,
    withTranscript: 0,
    missingAudio: 0,
    unreadable: 0,
    byFormat: {
      m4a: { files: 0, withTranscript: 0 },
      qta: { files: 0, withTranscript: 0 },
      unknown: { files: 0, withTranscript: 0 },
    },
  };
  for (const row of client.store().listRecordings()) {
    if (row.deletedAt !== null) continue;
    if (!row.audioPath || !existsSync(row.audioPath)) {
      coverage.missingAudio += 1;
      continue;
    }
    coverage.checked += 1;
    let format = formatFromName(row.audioPath);
    let found = false;
    try {
      const scan = scanAudioFile(row.audioPath);
      if (scan.format !== "unknown") format = scan.format;
      found = scan.transcript !== null;
    } catch {
      coverage.unreadable += 1;
    }
    coverage.byFormat[format].files += 1;
    if (found) {
      coverage.withTranscript += 1;
      coverage.byFormat[format].withTranscript += 1;
    }
  }
  return coverage;
};

/**
 * The store lane's own answer, asked only when Cupertino hosts this server. A lane that cannot
 * answer is reported as `{ error }`, never as a failed diagnostics call: this report is where
 * a person looks when the lane is the thing that broke.
 */
const writeLaneStatus = async (
  client: VoiceMemosClient,
): Promise<LaneStatus | { error: string } | null> => {
  if (!client.lane) return null;
  try {
    return await client.lane.status();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
};

/** The report, shared by the tool and the `cupertino://voice-memos/diagnostics` resource. */
export const buildDiagnostics = async (
  client: VoiceMemosClient,
): Promise<Record<string, unknown>> => {
  const status = client.status();
  const base = buildBaseDiagnostics({
    build: BUILD_INFO,
    config: client.config,
    allowWrites: client.config.allowWrites,
  });
  let transcripts: TranscriptCoverage | null = null;
  if (status.store.opened) {
    try {
      transcripts = transcriptCoverage(client);
    } catch {
      transcripts = null;
    }
  }
  const writeLane = await writeLaneStatus(client);
  const hosted = client.lane !== null;
  return {
    ...base,
    settings: { ...base.settings, exportDir: client.config.exportDir },
    lanes: {
      summary:
        "Voice Memos has ONE read lane. VoiceMemos.app ships no scripting dictionary, and its " +
        "App Intents can only be run from Shortcuts, so every read comes from " +
        "CloudRecordings.db and the audio files beside it, under Full Disk Access. Without the " +
        "grant this server reads nothing and says so rather than returning empty lists. When " +
        "Cupertino hosts this server, renames, moves, favourites and deletes go through the " +
        "app's store lane, which saves them with Voice Memos' own data model.",
      fileLane: {
        needs: "Full Disk Access",
        answers: "recordings, folders, favourites, Recently Deleted, Apple's transcripts",
        working: status.store.opened,
      },
      appleEvents: "none: Voice Memos is not scriptable",
      writes: {
        enabled: client.config.allowWrites,
        lane:
          "save_recording copies a recording's audio into exportDir. The store tools write " +
          "Voice Memos' store only through Cupertino, which saves with Voice Memos' own model " +
          "so iCloud uploads the change; this server never writes the store itself.",
        tools: client.config.allowWrites ? [...WRITE_TOOLS] : [],
        storeTools: client.config.allowWrites && hosted ? [...STORE_WRITE_TOOLS] : [],
      },
      writeLane,
      ...(hosted
        ? {}
        : {
            writeLaneNote:
              "not hosted by Cupertino: rename, move, favourite and delete need the app",
          }),
    },
    store: status.store,
    schema: {
      ...status.schema,
      note: status.schema.verified
        ? "The schema this server was measured against (macOS 27.2)."
        : "Not the schema this server was measured against (fb804d4a4d59, macOS 27.2). Fields " +
          "are read by column presence, so reads still work; a field whose column is gone reads null.",
    },
    counts: status.counts,
    transcripts,
    caveats: [
      "Apple transcribes on-device and embeds the transcript in the audio file. Recordings " +
        "made before 2025 were never backfilled: on the probed library 0 of 58 had one, and 28 " +
        "of 28 from 2025 on did.",
      "`title` is null for a memo that was never named. `label` is the date-shaped default " +
        "Voice Memos shows instead, and is never a title.",
      "Recently Deleted keeps a memo with `deletedAt` set to the moment of deletion. When it " +
        "will be purged is a Voice Memos setting this store does not hold.",
    ],
  };
};

export const registerDiagnosticsTools = (server: McpServer, client: VoiceMemosClient): void => {
  server.registerTool(
    "apple_voice_memos_diagnostics",
    {
      description:
        "Report whether Voice Memos' store can be read, how many recordings, folders and " +
        "favourites it holds, how many carry Apple's transcript, and what this server cannot " +
        "do. Start here when a read fails: this surface has no second lane, so a missing grant " +
        "means no data at all.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client)),
  );
};
