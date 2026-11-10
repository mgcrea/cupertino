import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RecordingNotFoundError } from "../src/client/errors.js";
import { transcriptText } from "../src/client/transcript.js";
import { VoiceMemosClient } from "../src/client/voice-memos.js";
import { loadConfig } from "../src/config.js";
import { m4aWithTranscript, qtaWithTranscript } from "./helpers/audio.js";
import { insertFolder, insertRecording, type Library, makeLibrary } from "./helpers/store.js";

/** Core Data seconds for a UTC date, so rows read back at a known instant. */
const at = (iso: string): number => Date.parse(iso) / 1000 - 978_307_200;

const runs = (words: [string, number, number][]): unknown => ({
  locale: { identifier: "fr_FR", current: 0 },
  attributedString: {
    runs: words.flatMap(([text], i) => [text, i]),
    attributeTable: words.map(([, start, end]) => ({ timeRange: [start, end] })),
  },
});

let lib: Library;
let client: VoiceMemosClient;

beforeEach(() => {
  lib = makeLibrary();
  insertFolder(lib.db, { pk: 1, uuid: "F-WORK", name: "Work", rank: 0, count: 2 });
  insertFolder(lib.db, { pk: 2, uuid: "F-HOME", name: "Home", rank: 1, count: 1 });

  const m4a = lib.addAudio(
    "a.m4a",
    m4aWithTranscript(
      runs([
        ["On", 0, 0.3],
        [" parle", 0.3, 0.7],
        [" du", 0.7, 0.9],
        [" café.", 0.9, 1.4],
        [" Ensuite", 3, 3.5],
        [" le", 3.5, 3.7],
        [" budget.", 3.7, 4.2],
      ]),
    ),
  );
  const qta = lib.addAudio(
    "b.qta",
    qtaWithTranscript(
      runs([
        ["Hello", 0, 0.4],
        [" world.", 0.4, 0.9],
      ]),
    ),
  );
  const silent = lib.addAudio("c.qta", qtaWithTranscript({ locale: {}, attributedString: "" }));
  const old = lib.addAudio("d.m4a", m4aWithTranscript(null));
  const broken = lib.addAudio("e.m4a", m4aWithTranscript({ a: 1 }).subarray(0, 60));

  insertRecording(lib.db, {
    pk: 1,
    id: "M4A",
    title: "Réunion",
    label: "2025-11-05T09:00:00Z",
    date: at("2025-11-05T09:00:00Z"),
    duration: 4.2,
    folder: 1,
    shared: 1,
    path: m4a,
  });
  insertRecording(lib.db, {
    pk: 2,
    id: "QTA",
    title: "Café chat",
    date: at("2026-01-10T10:00:00Z"),
    folder: 1,
    path: qta,
  });
  insertRecording(lib.db, { pk: 3, id: "SILENT", date: at("2026-02-01T10:00:00Z"), path: silent });
  insertRecording(lib.db, {
    pk: 4,
    id: "OLD",
    title: "Old memo",
    date: at("2019-06-01T10:00:00Z"),
    folder: 2,
    path: old,
  });
  insertRecording(lib.db, { pk: 5, id: "BROKEN", date: at("2025-12-01T10:00:00Z"), path: broken });
  insertRecording(lib.db, { pk: 6, id: "NOFILE", title: "Lost", date: at("2019-01-01T10:00:00Z") });
  insertRecording(lib.db, {
    pk: 7,
    id: "BINNED",
    title: "Café binned",
    label: "café label",
    date: at("2026-03-01T10:00:00Z"),
    evicted: at("2026-03-02T10:00:00Z"),
    path: qta,
  });

  client = new VoiceMemosClient({
    config: loadConfig({ APPLE_VOICE_MEMOS_STORE: lib.storePath }),
  });
});

afterEach(() => lib.cleanup());

describe("listRecordings", () => {
  it("lists newest first and hides Recently Deleted by default", () => {
    const { recordings, total } = client.listRecordings({});
    expect(recordings.map((r) => r.id)).toEqual([
      "SILENT",
      "QTA",
      "BROKEN",
      "M4A",
      "OLD",
      "NOFILE",
    ]);
    expect(total).toBe(6);
    const only = client.listRecordings({ onlyDeleted: true }).recordings;
    expect(only.map((r) => r.id)).toEqual(["BINNED"]);
    expect(only[0]?.deletedAt).toBe("2026-03-02T10:00:00.000Z");
    expect(client.listRecordings({ includeDeleted: true }).total).toBe(7);
  });

  it("renders folder, audio and no transcript", () => {
    const r = client.listRecordings({}).recordings.find((x) => x.id === "M4A");
    expect(r).toMatchObject({
      title: "Réunion",
      folder: { id: "F-WORK", name: "Work" },
      favorite: true,
      audio: { format: "m4a" },
    });
    expect(r?.audio?.bytes).toBeGreaterThan(0);
    expect(r).not.toHaveProperty("transcript");
    expect(r).not.toHaveProperty("audioPath");
    expect(client.listRecordings({}).recordings.find((x) => x.id === "NOFILE")?.audio).toBeNull();
  });

  it("filters by folderId, favorite and since/until", () => {
    expect(client.listRecordings({ folderId: "F-WORK" }).recordings.map((r) => r.id)).toEqual([
      "QTA",
      "M4A",
    ]);
    expect(client.listRecordings({ favorite: true }).recordings.map((r) => r.id)).toEqual(["M4A"]);
    expect(
      client
        .listRecordings({ since: "2025-11-01T00:00:00Z", until: "2026-01-31T00:00:00Z" })
        .recordings.map((r) => r.id),
    ).toEqual(["QTA", "BROKEN", "M4A"]);
  });

  it("pages with limit and offset, and says when it truncated", () => {
    const page = client.listRecordings({ limit: 2, offset: 1 });
    expect(page.recordings.map((r) => r.id)).toEqual(["QTA", "BROKEN"]);
    expect(page.total).toBe(6);
    expect(page.truncated).toMatch(/offset/);
  });
});

describe("listFolders", () => {
  it("returns the folders in sidebar order", () => {
    expect(client.listFolders().map((f) => f.name)).toEqual(["Work", "Home"]);
  });
});

describe("getRecording", () => {
  it("gets an M4A and a QTA transcript as text and as segments", () => {
    const m4a = client.getRecording("M4A");
    expect(m4a.transcript).toMatchObject({
      status: "ok",
      locale: "fr_FR",
      text: "On parle du café.\nEnsuite le budget.",
    });
    const segs = client.getRecording("M4A", { format: "segments" }).transcript;
    expect(segs).toMatchObject({
      status: "ok",
      segments: [
        { start: 0, end: 1.4, text: "On parle du café." },
        { start: 3, end: 4.2, text: "Ensuite le budget." },
      ],
    });
    expect(client.getRecording("QTA").transcript).toMatchObject({
      status: "ok",
      text: "Hello world.",
    });
    expect(client.getRecording("SILENT").transcript).toEqual({ status: "empty", locale: null });
  });

  it("pages a long transcript, and the pages add up to the whole", () => {
    const words: [string, number, number][] = Array.from({ length: 15_000 }, (_, i) => [
      `${i === 0 ? "" : " "}word${i}${i % 12 === 11 ? "." : ""}`,
      i * 0.3,
      (i + 1) * 0.3,
    ]);
    const path = lib.addAudio("long.m4a", m4aWithTranscript(runs(words)));
    insertRecording(lib.db, { pk: 20, id: "LONG", date: 1, path });

    const whole = client.getRecording("LONG", { format: "segments", maxSegments: 100_000 });
    if (whole.transcript.status !== "ok") throw new Error("expected ok");
    const fullText = transcriptText(whole.transcript.segments ?? []);

    let text = "";
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = client.getRecording("LONG", { offset });
      if (page.transcript.status !== "ok") throw new Error("expected ok");
      text += page.transcript.text;
      offset = page.transcript.nextOffset;
      pages += 1;
    }
    expect(pages).toBeGreaterThan(1);
    expect(text).toBe(fullText);

    const first = client.getRecording("LONG", { format: "segments" });
    if (first.transcript.status !== "ok") throw new Error("expected ok");
    expect(first.transcript.segments).toHaveLength(200);
    expect(first.transcript.nextOffset).toBe(200);
  });

  it("reports no-audio, none and unreadable, and still returns the metadata", () => {
    const lost = client.getRecording("NOFILE");
    expect(lost).toMatchObject({ id: "NOFILE", title: "Lost", audio: null });
    expect(lost.transcript).toEqual({ status: "no-audio" });

    const old = client.getRecording("OLD");
    expect(old).toMatchObject({ title: "Old memo", folder: { name: "Home" } });
    expect(old.transcript).toEqual({ status: "none" });

    const broken = client.getRecording("BROKEN");
    expect(broken.audio).toMatchObject({ format: "m4a" });
    expect(broken.transcript.status).toBe("unreadable");
    expect(broken.transcript.status === "unreadable" && broken.transcript.reason).toMatch(
      /overruns|truncated/,
    );
  });

  it("gets a Recently Deleted recording by id", () => {
    expect(client.getRecording("BINNED").deletedAt).toBe("2026-03-02T10:00:00.000Z");
  });

  it("unknown id throws RecordingNotFoundError", () => {
    expect(() => client.getRecording("NOPE")).toThrow(RecordingNotFoundError);
  });
});

describe("searchRecordings", () => {
  it('finds "cafe" in a "Café" title and in transcript text, with the moment', () => {
    const { hits } = client.searchRecordings({ query: "cafe" });
    expect(hits.map((h) => h.recording.id)).toEqual(["QTA", "M4A"]);
    const title = hits.find((h) => h.recording.id === "QTA");
    expect(title).toMatchObject({ title: true, segments: [] });
    const spoken = hits.find((h) => h.recording.id === "M4A");
    expect(spoken).toMatchObject({
      title: false,
      segments: [{ start: 0, end: 1.4, text: "On parle du café." }],
    });
  });

  it("folds case and accents in the query too", () => {
    expect(client.searchRecordings({ query: "BUDGÈT" }).hits.map((h) => h.recording.id)).toEqual([
      "M4A",
    ]);
  });

  it("skips deleted recordings unless includeDeleted, and never matches the label", () => {
    expect(client.searchRecordings({ query: "binned" }).hits).toEqual([]);
    expect(
      client
        .searchRecordings({ query: "binned", includeDeleted: true })
        .hits.map((h) => h.recording.id),
    ).toEqual(["BINNED"]);
    expect(client.searchRecordings({ query: "label", includeDeleted: true }).hits).toEqual([]);
  });

  it("caps hits at limit and says so", () => {
    const res = client.searchRecordings({ query: "e", limit: 1 });
    expect(res.hits).toHaveLength(1);
    expect(res.truncated).toMatch(/limit/);
  });

  // "No hits" must not read as "never said": count what had no transcript to search.
  it("says how many recordings had no transcript it could search", () => {
    const res = client.searchRecordings({ query: "nothing like this" });
    expect(res.hits).toEqual([]);
    expect(res.transcriptsNotSearched).toEqual({ none: 1, unreadable: 1, noAudio: 1 });
    expect(
      client.searchRecordings({ query: "nothing like this", includeDeleted: true })
        .transcriptsNotSearched,
    ).toEqual({ none: 1, unreadable: 1, noAudio: 1 });
  });
});
