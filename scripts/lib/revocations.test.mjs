// Which licences `make revocations` bakes into the app, run against the real
// migrations in an in-memory SQLite rather than read off the query's text.
//
// One D1 database holds both Stripe modes, and the Worker signs with the one
// production key whichever mode the event came from. So a test-mode purchase
// mints a key the shipped app genuinely accepts, from a checkout anybody holding
// a test-mode link can complete with card 4242. The list must carry every one of
// those, revoked or not, beside the live licences a refund or dispute revoked.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { REVOKED_QUERY } from "./revocations.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const migrations = join(root, "apps/api/migrations");

const database = () => {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations)
    .filter((n) => n.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(join(migrations, name), "utf8"));
  }
  return db;
};

const insert = (db, id, { livemode, revoked }) =>
  db
    .prepare(
      `INSERT INTO licenses (id, email, major, key, stripe_session_id, amount_paid, currency,
         issued_at, livemode, revoked_at)
       VALUES (?, 'buyer@example.com', 1, 'cup1.x.y', ?, 1499, 'eur', '2026-10-03', ?, ?)`,
    )
    .run(id, `cs_${id}`, livemode ? 1 : 0, revoked ? "2026-10-03" : null);

describe("REVOKED_QUERY", () => {
  const db = database();
  insert(db, "A_LIVE", { livemode: true, revoked: false });
  insert(db, "B_LIVE_REFUNDED", { livemode: true, revoked: true });
  insert(db, "C_TEST", { livemode: false, revoked: false });
  insert(db, "D_TEST_REFUNDED", { livemode: false, revoked: true });
  const ids = db
    .prepare(REVOKED_QUERY)
    .all()
    .map((row) => row.id);

  it("revokes a live licence a refund or dispute revoked", () => {
    assert.ok(ids.includes("B_LIVE_REFUNDED"));
  });

  it("revokes every test-mode licence, revoked or not", () => {
    assert.ok(ids.includes("C_TEST"));
    assert.ok(ids.includes("D_TEST_REFUNDED"));
  });

  it("leaves a paying customer's live licence alone", () => {
    assert.ok(!ids.includes("A_LIVE"));
  });

  it("lists each once, in order", () => {
    assert.deepEqual(ids, ["B_LIVE_REFUNDED", "C_TEST", "D_TEST_REFUNDED"]);
  });
});
