import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_SEARCH_LIMIT,
  SEGMENTS_PER_HIT,
  type VoiceMemosClient,
} from "../client/voice-memos.js";
import { wrap } from "./util.js";

/** Said once, in every description that can return a transcript. */
const TRANSCRIPT_NOTE =
  "Transcripts are Apple's own, made on-device; only recordings Apple transcribed have one " +
  "(measured: every recording from 2025 on, none before). Status `none` means Apple never " +
  "transcribed it, `empty` that it heard nothing, `unreadable` that the file would not parse " +
  "(not evidence of either), `no-audio` that the file is not on this Mac.";

const ID_NOTE =
  "An id comes from list_recordings or search_recordings; one that no longer resolves means " +
  "the memo was removed, so list again.";

export const idArg = z.string().min(1).describe(`The recording's id. ${ID_NOTE}`);

export const registerRecordingTools = (server: McpServer, client: VoiceMemosClient): void => {
  server.registerTool(
    "apple_voice_memos_list_folders",
    {
      description:
        "List Voice Memos' folders in sidebar order, with how many recordings each holds. " +
        "Favourites and Recently Deleted are not folders: they are filters on list_recordings.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ({ folders: client.listFolders() })),
  );

  server.registerTool(
    "apple_voice_memos_list_recordings",
    {
      description:
        "List recordings, newest first: title (null when never named), the date-shaped " +
        "default `label`, date, duration, folder, favourite, and the audio file's format and " +
        "size. Recently Deleted is hidden unless asked for. This never reads transcripts; " +
        `use get_recording for what was said. ${TRANSCRIPT_NOTE}`,
      inputSchema: z.object({
        folderId: z
          .string()
          .min(1)
          .optional()
          .describe("Only this folder, by id from list_folders."),
        favorite: z.boolean().optional().describe("true for favourites only, false for the rest."),
        since: z
          .string()
          .optional()
          .describe(
            'Recorded at or after this: "2026-08-20", "2026-08-20T09:00", "-7d", "yesterday".',
          ),
        until: z.string().optional().describe("Recorded before this. A whole day is included."),
        includeDeleted: z.boolean().optional().describe("Include Recently Deleted. Default false."),
        onlyDeleted: z.boolean().optional().describe("Only Recently Deleted."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe(`How many to return. Default ${DEFAULT_LIST_LIMIT}.`),
        offset: z.number().int().min(0).optional().describe("Skip this many, to page."),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => wrap(async () => client.listRecordings(args)),
  );

  server.registerTool(
    "apple_voice_memos_get_recording",
    {
      description:
        "One recording and its transcript. As `text` (default) the transcript is a page of " +
        `up to maxChars characters (default ${DEFAULT_MAX_CHARS}); as \`segments\` it is up to ` +
        `maxSegments timed segments (default ${DEFAULT_MAX_SEGMENTS}), each with start and end ` +
        "in seconds from the start of the recording. When `nextOffset` is present there is " +
        "more: call again with offset set to it, and do not summarise the whole from one page. " +
        `${TRANSCRIPT_NOTE} ${ID_NOTE}`,
      inputSchema: z.object({
        id: idArg,
        format: z
          .enum(["text", "segments"])
          .optional()
          .describe("`text` for reading, `segments` for timings."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Where to resume: characters in text format, segments in segment format."),
        maxChars: z.number().int().min(100).max(200_000).optional(),
        maxSegments: z.number().int().min(1).max(5_000).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, ...o }) => wrap(async () => client.getRecording(id, o)),
  );

  server.registerTool(
    "apple_voice_memos_search_recordings",
    {
      description:
        "Find recordings whose title or transcript contains the query, ignoring case and " +
        `accents ("cafe" finds "Café"), newest first. Each hit gives up to ${SEGMENTS_PER_HIT} ` +
        "matching segments with their start time, so the moment can be quoted and found by " +
        "listening; `title: true` means the title matched. The default label is never " +
        "searched. Recently Deleted is skipped unless asked for. Reads every transcript, " +
        "cached after the first search. `transcriptsNotSearched` counts the recordings whose " +
        "transcript could not be searched (Apple never made one, the file would not parse, or " +
        "the file is not on this Mac): with no hits, say how many, rather than that it was " +
        `never said. ${TRANSCRIPT_NOTE}`,
      inputSchema: z.object({
        query: z.string().min(1).describe("Words to find, matched as one phrase."),
        includeDeleted: z.boolean().optional().describe("Search Recently Deleted too."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`How many recordings to return. Default ${DEFAULT_SEARCH_LIMIT}.`),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => wrap(async () => client.searchRecordings(args)),
  );
};
