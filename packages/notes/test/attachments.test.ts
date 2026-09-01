import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { OsascriptRunner } from "@mgcrea/mcp-apple-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppleNotesClient } from "../src/client/notes.js";
import { encodeRef } from "../src/client/ref.js";
import { loadConfig, type Config } from "../src/config.js";

/**
 * `save_attachment` puts a file on the user's disk, so where it may write and
 * what it may clobber are the obvious things to test — but they are not the
 * ones that broke.
 *
 * An earlier version of this file used `ATT_ID = "att-1"` and seeded
 * `Media/att-1/<file>`, then asserted the bytes came back. Every assertion
 * passed while the tool could not save a single real attachment, because the id
 * Apple Events actually returns is `x-coredata://<store>/ICAttachment/p<N>` — a
 * URI containing slashes, which no directory can ever be named. The fixture had
 * quietly invented an id shape that cannot occur, and with it a filesystem
 * layout that does not exist.
 *
 * So the ids here are real-shaped, and the store is a real SQLite database
 * built from the captured schema. The resolution path is:
 *
 *     ICAttachment.ZMEDIA -> ICMedia -> Media/<ZIDENTIFIER>/<ZGENERATION1>/<ZFILENAME>
 *
 * See `scripts/probe-notes-media.mjs`, which established that against a live
 * store.
 */

const DDL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "note-store.sql"),
  "utf8",
);

const STORE_UUID = "B1FD1F1B-0000-0000-0000-000000000000";
const NOTE_ENT = 12;
const NOTE_PK = 42;
const ATTACHMENT_PK = 100;
const MEDIA_PK = 200;

const NOTE_ID = `x-coredata://${STORE_UUID}/ICNote/p${NOTE_PK}`;
const ATT_ID = `x-coredata://${STORE_UUID}/ICAttachment/p${ATTACHMENT_PK}`;
const ref = encodeRef(NOTE_ID);

/** The two directory levels, named exactly as a real store names them. */
const MEDIA_UUID = "3F2A1C55-0000-0000-0000-0000000000AA";
const GENERATION = "{9B7E4D01-0000-0000-0000-0000000000BB}";
const ACCOUNT = "uuid-1";

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

/** An ICAttachment pointing at an ICMedia row, the way Notes stores one. */
const seedRows = (filename: string, opts: { generation?: string | null } = {}): void => {
  const fresh = !existsSync(store);
  const db = new DatabaseSync(store);
  if (fresh) {
    db.exec(DDL);
    db.prepare("INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)").run(
      NOTE_ENT,
      "ICNote",
    );
    db.prepare("INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, ?)").run(STORE_UUID);
  }
  // Re-seeding is how a test states a different row for the same attachment.
  db.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK IN (?, ?)").run(MEDIA_PK, ATTACHMENT_PK);
  db.prepare(
    "INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1) " +
      "VALUES (?, 11, ?, ?, ?)",
  ).run(
    MEDIA_PK,
    MEDIA_UUID,
    filename,
    opts.generation === undefined ? GENERATION : opts.generation,
  );
  db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZMEDIA) VALUES (?, 5, ?)").run(
    ATTACHMENT_PK,
    MEDIA_PK,
  );
  db.close();
};

/** Media lives at Accounts/<account>/Media/<identifier>/<generation>/<filename>. */
const seedMedia = (
  filename: string,
  body = "BYTES",
  opts: { generation?: string | null } = {},
): void => {
  const generation = opts.generation === undefined ? GENERATION : opts.generation;
  const media = join(
    dir,
    "Accounts",
    ACCOUNT,
    "Media",
    MEDIA_UUID,
    ...(generation ? [generation] : []),
  );
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, filename), body);
  seedRows(filename, { generation });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-apple-notes-att-"));
  store = join(dir, "NoteStore.sqlite");
  downloads = join(dir, "Downloads");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("locating the bytes", () => {
  /**
   * THE REGRESSION. The id is a Core Data URI, so nothing on disk is named it;
   * only the ICMedia hop can resolve where the file actually is.
   */
  it("resolves a real Core Data attachment id through ICMedia", async () => {
    seedMedia("invoice.pdf", "PDF-BYTES");
    const saved = await clientWith("invoice.pdf").saveAttachment(ref, ATT_ID);

    expect(saved.path).toBe(join(downloads, "invoice.pdf"));
    expect(readFileSync(saved.path, "utf8")).toBe("PDF-BYTES");
  });

  /** Older rows carry no generation, so the file sits under the identifier. */
  it("falls back to the identifier directory when there is no generation", async () => {
    seedMedia("flat.pdf", "FLAT", { generation: null });
    const saved = await clientWith("flat.pdf").saveAttachment(ref, ATT_ID);

    expect(readFileSync(saved.path, "utf8")).toBe("FLAT");
  });

  /**
   * The filename recorded in the row is a hint. A directory holding exactly one
   * file is unambiguous whatever that file is called.
   */
  it("takes the only file in the directory when the recorded name differs", async () => {
    seedMedia("renamed-on-disk.pdf", "STILL-FOUND");
    seedRows("what-the-row-says.pdf");
    const saved = await clientWith(null).saveAttachment(ref, ATT_ID);

    expect(readFileSync(saved.path, "utf8")).toBe("STILL-FOUND");
  });

  it("says the media record is missing rather than walking for a name that is not there", async () => {
    seedMedia("orphan.pdf");
    const db = new DatabaseSync(store);
    db.prepare("UPDATE ZICCLOUDSYNCINGOBJECT SET ZMEDIA = NULL WHERE Z_PK = ?").run(ATTACHMENT_PK);
    db.close();

    await expect(clientWith("orphan.pdf").saveAttachment(ref, ATT_ID)).rejects.toThrow(
      /Cannot resolve where .* is stored/,
    );
  });
});

describe("saving attachments", () => {
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
   * The name comes from note content, so `../` in it must be stripped rather
   * than honoured. It is now read from ZFILENAME rather than the Apple Events
   * name, so the traversal check has to hold on the store's value too.
   */
  it.each([
    ["../escaped.pdf", "escaped.pdf"],
    ["../../../../etc/passwd", "passwd"],
    ["/absolute/path.pdf", "path.pdf"],
  ])("confines a traversing name %s to the attachment dir", async (evil, expected) => {
    seedMedia(expected);
    seedRows(evil);
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

describe("listing attachments", () => {
  /**
   * Notes can enumerate one attachment more than once. Measured after a `make`:
   * the element collection returned the new attachment twice and `count of
   * attachments` said 3 where two existed. Passed through, a caller would save
   * the same file twice or believe a note holds attachments it does not.
   */
  it("collapses an attachment Notes enumerates more than once", async () => {
    const dup = {
      id: `x-coredata://${STORE_UUID}/ICAttachment/p6918`,
      name: "cupertino-test.png",
      url: null,
      contentIdentifier: "cid:23864A61",
    };
    const client = new AppleNotesClient({
      config: loadConfig({ APPLE_NOTES_STORE: store, APPLE_NOTES_ATTACHMENT_DIR: downloads }),
      osascript: {
        run: async () =>
          [
            { id: ATT_ID, name: "first.png", url: null, contentIdentifier: "cid:98152263" },
            dup,
            dup,
          ] as never,
      },
    });

    const listed = await client.attachments(ref);
    expect(listed.map((a) => a.id)).toEqual([ATT_ID, dup.id]);
  });

  /** An id-less row cannot be deduped, so it must survive rather than collapse. */
  it("keeps rows with no id rather than folding them together", async () => {
    const client = new AppleNotesClient({
      config: loadConfig({ APPLE_NOTES_STORE: store, APPLE_NOTES_ATTACHMENT_DIR: downloads }),
      osascript: {
        run: async () =>
          [
            { id: null, name: "a.png", url: null, contentIdentifier: null },
            { id: null, name: "b.png", url: null, contentIdentifier: null },
          ] as never,
      },
    });

    expect(await client.attachments(ref)).toHaveLength(2);
  });
});

describe("adding an attachment", () => {
  /**
   * A missing path is checked here rather than in JXA: Notes reports it as a
   * generic refusal, so a typo would surface as "Notes refused the file".
   */
  it("names a missing file instead of blaming Notes", async () => {
    const client = clientWith(null);
    await expect(client.addAttachment(ref, join(dir, "nope.png"))).rejects.toThrow(/No file at/);
  });

  it("refuses a directory", async () => {
    const client = clientWith(null);
    await expect(client.addAttachment(ref, dir)).rejects.toThrow(/is not a file/);
  });

  it("passes an absolute resolved path to Notes", async () => {
    const seen: Record<string, unknown>[] = [];
    const file = join(dir, "attach-me.png");
    writeFileSync(file, "PNG");
    const client = new AppleNotesClient({
      config: loadConfig({ APPLE_NOTES_STORE: store, APPLE_NOTES_ATTACHMENT_DIR: downloads }),
      osascript: {
        run: async (_script: unknown, params: Record<string, unknown>) => {
          seen.push(params);
          return { noteId: NOTE_ID, attachment: { id: ATT_ID, name: "attach-me.png" } } as never;
        },
      } as never,
    });

    await client.addAttachment(ref, join(dir, ".", "attach-me.png"));
    expect(seen[0]?.path).toBe(file);
  });
});
