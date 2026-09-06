import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexUnavailableError } from "../src/errors.js";
import { openReadOnly } from "../src/sqlite.js";

/**
 * These are about the handle, not the ladder.
 *
 * `validate` runs against an OPEN database, and every surface passes one — it
 * is where schema drift is detected. When it threw, the loop moved on to the
 * next open mode (or rethrew, for a fatal error) without closing what it had
 * already opened. The files in question are the ones Mail, Notes and Messages
 * hold open themselves, so leaking descriptors onto them is not academic.
 *
 * A closed `DatabaseSync` throws on use, which is how these assert it.
 */
const isClosed = (db: DatabaseSync): boolean => {
  try {
    db.prepare("SELECT 1").get();
    return false;
  } catch {
    return true;
  }
};

describe("openReadOnly", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cupertino-sqlite-"));
    path = join(dir, "store.sqlite");
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE t (x INTEGER)");
    seed.exec("INSERT INTO t VALUES (1)");
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("closes the handle when validate throws and the ladder moves on", () => {
    const seen: DatabaseSync[] = [];
    const store = openReadOnly(path, "auto", {
      validate: (db) => {
        seen.push(db);
        // Fail the `ro` attempt only, so the ladder falls through to immutable.
        if (seen.length === 1) throw new Error("schema drift");
        return "ok";
      },
    });

    expect(store.mode).toBe("immutable");
    expect(store.validated).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(isClosed(seen[0] as DatabaseSync)).toBe(true);
    // And the one that succeeded is still usable, or the caller got nothing.
    expect(isClosed(store.db)).toBe(false);
    store.db.close();
  });

  it("closes the handle on the fatal path too, before rethrowing", () => {
    const seen: DatabaseSync[] = [];
    expect(() =>
      openReadOnly(path, "auto", {
        validate: (db) => {
          seen.push(db);
          throw new Error("unrecoverable");
        },
        fatal: () => true,
      }),
    ).toThrow(/unrecoverable/);

    expect(seen).toHaveLength(1);
    expect(isClosed(seen[0] as DatabaseSync)).toBe(true);
  });

  it("closes every attempt's handle when the whole ladder fails", () => {
    const seen: DatabaseSync[] = [];
    expect(() =>
      openReadOnly(path, "auto", {
        validate: (db) => {
          seen.push(db);
          throw new Error("nope");
        },
      }),
    ).toThrow(IndexUnavailableError);

    expect(seen).toHaveLength(2);
    expect(seen.every(isClosed)).toBe(true);
  });

  it("opens read-only, and refuses a write through the handle it returns", () => {
    const store = openReadOnly(path, "auto");
    expect(store.db.prepare("SELECT x FROM t").get()).toEqual({ x: 1 });
    expect(() => store.db.exec("INSERT INTO t VALUES (2)")).toThrow();
    store.db.close();
  });
});
