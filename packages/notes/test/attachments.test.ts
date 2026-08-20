import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppleNotesClient } from "../src/client/notes.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig, type Config } from "../src/config.js";

/**
 * `save_attachment` is the only tool that puts a file on the user's disk, so
 * the questions worth testing are where it may write and what it may clobber —
 * not what it reads. The store only has to be *readable* for the Full Disk
 * Access precondition to pass; nothing here opens it as SQLite.
 */

const NOTE_ID = "x-coredata://B1FD1F1B/ICNote/p42";
const ATT_ID = "att-1";
const ref = encodeRef(NOTE_ID);

let dir: string;
let store: string;
let downloads: string;

/** The runner only ever answers LIST_ATTACHMENTS here. */
const runnerFor = (name: string | null): OsascriptRunner => ({
  run: async () => [{ id: ATT_ID, name, url: null, contentIdentifier: null }] as never,
});

const clientWith = (name: string | null, over: Partial<Config> = {}): AppleNotesClient =>
  new AppleNotesClient({
    config: {
      ...loadConfig({ APPLE_NOTES_STORE: store, APPLE_NOTES_ATTACHMENT_DIR: downloads }),
      ...over,
    },
    osascript: runnerFor(name),
  });

/** Media lives at Accounts/<uuid>/Media/<attachmentId>/<filename>. */
const seedMedia = (filename: string, body = "BYTES"): void => {
  const media = join(dir, "Accounts", "uuid-1", "Media", ATT_ID);
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, filename), body);
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-notes-att-"));
  store = join(dir, "NoteStore.sqlite");
  downloads = join(dir, "Downloads");
  writeFileSync(store, "not really sqlite, only readable");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("saving attachments", () => {
  it("writes the bytes into the configured directory", async () => {
    seedMedia("invoice.pdf", "PDF-BYTES");
    const saved = await clientWith("invoice.pdf").saveAttachment(ref, ATT_ID);

    expect(saved.path).toBe(join(downloads, "invoice.pdf"));
    expect(readFileSync(saved.path, "utf8")).toBe("PDF-BYTES");
  });

  it("refuses to overwrite by default, and obeys an explicit overwrite", async () => {
    seedMedia("dup.pdf", "ORIGINAL");
    const client = clientWith("dup.pdf");
    await client.saveAttachment(ref, ATT_ID);

    await expect(client.saveAttachment(ref, ATT_ID)).rejects.toThrow(/already exists/);
    await expect(
      client.saveAttachment(ref, ATT_ID, undefined, { overwrite: true }),
    ).resolves.toMatchObject({ bytes: 8 });
  });

  /**
   * The attachment name comes from note content, so `../` in it must be
   * stripped rather than honoured.
   */
  it.each([
    ["../escaped.pdf", "escaped.pdf"],
    ["../../../../etc/passwd", "passwd"],
    ["/absolute/path.pdf", "path.pdf"],
  ])("confines a traversing name %s to the attachment dir", async (evil, expected) => {
    seedMedia(expected);
    const saved = await clientWith(evil).saveAttachment(ref, ATT_ID, undefined, {
      overwrite: true,
    });

    expect(saved.path).toBe(join(downloads, expected));
    expect(existsSync(join(dir, "escaped.pdf"))).toBe(false);
  });

  /**
   * `directory` selects a subdirectory of the configured root; it does not
   * replace it. An absolute path outside the root is the whole point of the
   * check — honouring it would make the configured directory advisory.
   */
  it("accepts a subdirectory of the configured root", async () => {
    seedMedia("nested.pdf");
    const saved = await clientWith("nested.pdf").saveAttachment(ref, ATT_ID, "invoices/2026");

    expect(saved.path).toBe(join(downloads, "invoices", "2026", "nested.pdf"));
  });

  it.each(["/tmp", "../../escape", join(tmpdir(), "elsewhere")])(
    "refuses the out-of-root directory %s",
    async (escape) => {
      seedMedia("nope.pdf");
      await expect(clientWith("nope.pdf").saveAttachment(ref, ATT_ID, escape)).rejects.toThrow(
        /Refusing to write outside/,
      );
    },
  );

  it("reports the missing permission rather than failing obscurely", async () => {
    seedMedia("x.pdf");
    const client = clientWith("x.pdf", { storePath: join(dir, "gone", "NoteStore.sqlite") });

    await expect(client.saveAttachment(ref, ATT_ID)).rejects.toThrow(/Full Disk Access/);
  });
});
