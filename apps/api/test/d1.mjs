// A D1 binding over node:sqlite, for the handler tests.
//
// Plain JavaScript on purpose: this package's tsconfig carries workerd's types
// and no Node ones, so `node:sqlite` and `node:fs` have no declarations there.
// shims.d.ts states the shape the tests see instead.
//
// Real SQLite rather than a hand-rolled fake, with the real migrations applied
// in order, so a query naming a column no migration added fails here the way
// it would on D1. What it does not reproduce is D1's network. Every call
// resolves on a later turn of the event loop instead, which is what lets two
// requests interleave at each await, and that is all the race tests need.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

const later = () => new Promise((resolve) => setImmediate(resolve));

/** Stripped of node:sqlite's null prototype, so `toEqual` compares plainly. */
const plain = (row) => (row ? { ...row } : null);

export const createD1 = () => {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }

  const statement = (query, params) => ({
    bind: (...next) => statement(query, next),
    first: async () => {
      await later();
      return plain(db.prepare(query).get(...params));
    },
    run: async () => {
      await later();
      const result = db.prepare(query).run(...params);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    all: async () => {
      await later();
      return {
        success: true,
        results: db
          .prepare(query)
          .all(...params)
          .map(plain),
        meta: {},
      };
    },
  });

  return {
    binding: { prepare: (query) => statement(query, []) },
    /** Synchronous, for arranging and asserting. Returns rows for a SELECT, [] otherwise. */
    sql: (query, ...params) =>
      db
        .prepare(query)
        .all(...params)
        .map(plain),
  };
};
