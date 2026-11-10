#!/usr/bin/env node
/**
 * The Voice Memos surface against a real library: the built server, spoken to over stdio.
 *
 * Run it where Full Disk Access is held (the agent's own shell has none; `apple_shell_run`
 * or a terminal with the grant does):
 *
 *     pnpm --filter @mgcrea/mcp-apple-voice-memos build
 *     node scripts/check-voice-memos-live.mjs [--export]
 *
 * It prints COUNTS, STATUSES and TIMINGS only, never a title, a label or a word of a
 * transcript. The search uses a word taken from a transcript in memory and reports only how
 * many recordings it found.
 *
 * It exits non-zero when `schema.verified` is false, or when any recording from 2025 on has
 * a transcript status other than `ok` or `empty` (measured: Apple transcribed every one).
 *
 * `--export` also saves the newest .m4a and the newest .qta that carry a transcript into
 * `~/Downloads/cupertino-voice-memos-check/`, then renames the copies to `newest.m4a` and
 * `newest.qta` so the printed paths carry no title. Those are copies; delete them when done.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "voice-memos", "dist", "cli.js");
const EXPORT = process.argv.includes("--export");
const EXPORT_DIR = join(homedir(), "Downloads");
const SUBDIR = "cupertino-voice-memos-check";

const server = spawn(process.execPath, [CLI], {
  stdio: ["pipe", "pipe", "ignore"],
  env: {
    ...process.env,
    APPLE_VOICE_MEMOS_ALLOW_WRITES: EXPORT ? "1" : "0",
    APPLE_VOICE_MEMOS_EXPORT_DIR: EXPORT_DIR,
  },
});

const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

/** Calls a tool and returns its parsed JSON, with how long it took. Throws on a tool error. */
const call = async (name, args = {}) => {
  const t0 = performance.now();
  const res = await request("tools/call", { name, arguments: args });
  const ms = Math.round(performance.now() - t0);
  const text = res.content.map((c) => c.text).join("");
  // An error message can quote a path, so only its first words are shown.
  if (res.isError) throw new Error(`${name} failed: ${text.slice(0, 60)}…`);
  return { data: JSON.parse(text), ms };
};

const problems = [];
const out = {};

try {
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "check-voice-memos-live", version: "0" },
  });
  server.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );

  const diag = await call("apple_voice_memos_diagnostics");
  const d = diag.data;
  out.diagnostics = {
    ms: diag.ms,
    opened: d.store.opened,
    mode: d.store.mode,
    walPresent: d.store.walPresent,
    schema: { fingerprint: d.schema.fingerprint, verified: d.schema.verified },
    counts: d.counts,
    transcripts: d.transcripts,
  };
  if (!d.store.opened) throw new Error("the store did not open: run this with Full Disk Access");
  if (!d.schema.verified) problems.push(`schema ${d.schema.fingerprint} is not the verified one`);

  const folders = await call("apple_voice_memos_list_folders");
  out.folders = { ms: folders.ms, count: folders.data.folders.length };

  const list = await call("apple_voice_memos_list_recordings", { limit: 500 });
  const deleted = await call("apple_voice_memos_list_recordings", {
    onlyDeleted: true,
    limit: 500,
  });
  const favs = await call("apple_voice_memos_list_recordings", { favorite: true, limit: 500 });
  const recs = list.data.recordings;
  out.list = {
    ms: list.ms,
    total: list.data.total,
    deleted: deleted.data.total,
    favorites: favs.data.total,
    titled: recs.filter((r) => r.title !== null).length,
    withAudio: recs.filter((r) => r.audio !== null).length,
    byFormat: Object.fromEntries(
      ["m4a", "qta", "unknown"].map((f) => [f, recs.filter((r) => r.audio?.format === f).length]),
    ),
  };

  // Every transcript, by status, split at 2025 where Apple's transcription starts.
  const statuses = { before2025: {}, from2025: {} };
  let words = 0;
  let segments = 0;
  let getMs = 0;
  const newest = { m4a: null, qta: null };
  let probeWord = null;
  for (const r of recs) {
    const got = await call("apple_voice_memos_get_recording", {
      id: r.id,
      format: "segments",
      maxSegments: 5000,
    });
    getMs += got.ms;
    const t = got.data.transcript;
    const era = r.recordedAt && r.recordedAt >= "2025" ? "from2025" : "before2025";
    statuses[era][t.status] = (statuses[era][t.status] ?? 0) + 1;
    if (era === "from2025" && t.status !== "ok" && t.status !== "empty") {
      problems.push(
        `a recording from ${r.recordedAt.slice(0, 7)} has transcript status ${t.status}`,
      );
    }
    if (t.status === "ok") {
      segments += t.segments.length;
      for (const s of t.segments) words += s.text.split(/\s+/).length;
      const fmt = r.audio?.format;
      if ((fmt === "m4a" || fmt === "qta") && newest[fmt] === null) newest[fmt] = r.id;
      // A long word from the newest transcript, kept in memory only.
      probeWord ??=
        t.segments.flatMap((s) => s.text.split(/[^\p{L}]+/u)).find((w) => w.length >= 7) ?? null;
    }
  }
  out.transcripts = { statuses, segments, words, totalGetMs: getMs };

  // Paging: the largest transcript read as text pages adds up to its whole.
  if (newest.qta ?? newest.m4a) {
    const id = newest.qta ?? newest.m4a;
    const whole = await call("apple_voice_memos_get_recording", { id, maxChars: 200_000 });
    let text = "";
    let offset = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = await call("apple_voice_memos_get_recording", { id, offset, maxChars: 500 });
      text += page.data.transcript.text ?? "";
      offset = page.data.transcript.nextOffset;
      pages += 1;
    }
    if (whole.data.transcript.nextOffset !== undefined) {
      out.paging = { pages, matchesWhole: "skipped: over 200 000 characters" };
    } else {
      const same = text === whole.data.transcript.text;
      out.paging = { pages, chars: text.length, matchesWhole: same };
      if (!same) problems.push("text pages do not add up to the whole transcript");
    }
  }

  if (probeWord) {
    const found = await call("apple_voice_memos_search_recordings", { query: probeWord });
    const again = await call("apple_voice_memos_search_recordings", { query: probeWord });
    out.search = {
      firstMs: found.ms,
      cachedMs: again.ms,
      hits: found.data.hits.length,
      segmentsInHits: found.data.hits.reduce((n, h) => n + h.segments.length, 0),
    };
    if (found.data.hits.length === 0) problems.push("a word from a transcript found nothing");
  }

  if (EXPORT) {
    const dir = join(EXPORT_DIR, SUBDIR);
    mkdirSync(dir, { recursive: true });
    out.export = {};
    for (const fmt of ["m4a", "qta"]) {
      if (!newest[fmt]) {
        problems.push(`no ${fmt} with a transcript to export`);
        continue;
      }
      const saved = await call("apple_voice_memos_save_recording", {
        id: newest[fmt],
        directory: SUBDIR,
        overwrite: true,
      });
      const target = join(dir, `newest${extname(saved.data.path)}`);
      renameSync(saved.data.path, target);
      out.export[fmt] = { path: target, bytes: saved.data.bytes, ms: saved.ms };
    }
    out.export.filesInFolder = readdirSync(dir).length;
  }
} catch (error) {
  problems.push(error.message);
} finally {
  server.stdin.end();
  server.kill();
}

out.problems = problems;
console.log(JSON.stringify(out, null, 2));
process.exit(problems.length ? 1 : 0);
