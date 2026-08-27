// Tests for the phase-0 probe kit.
//
// These exist because of a specific, repeated failure. Three separate epoch
// bugs shipped in this file and every one was caught by a human running a probe
// against a real store and noticing the answer was absurd — never by the author:
//
//   1. `MAX(date)` on Messages THREW (nanoseconds since 2001 exceed
//      Number.MAX_SAFE_INTEGER). The throw was swallowed and seven columns
//      across 97,414 messages reported "no dates present".
//   2. Safari's `visit_time` was read as nanoseconds, because dividing seconds
//      by 1e9 lands on the 2001 anchor and "2001" passed a window whose lower
//      bound was 2001.
//   3. Narrowing that window to roughly `now` then rejected Calendar's
//      `start_date`, which reads as 2030 — because a calendar is mostly a record
//      of things that have not happened yet.
//
// Every one is a table row below. The pattern they share is that the wrong
// answer LOOKED PLAUSIBLE: a date, a count, an empty column. That is exactly the
// class of bug a probe cannot self-report, so it has to be asserted here.
//
// `node --test`, no framework: the kit is dependency-free on purpose and its
// tests should not be the thing that changes that.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import {
  aggNumericAsText,
  APPLE_EPOCH_OFFSET,
  detectEpoch,
  dumpSchema,
  escapeLike,
  fileFacts,
  findIdBridge,
  looksLikeDateColumn,
  maskIdentity,
  maskUrl,
  maxNumericAsText,
  openStore,
  parseArgs,
  sane,
  tableTools,
  toFileUri,
} from "./probe-kit.mjs";

const scratch = mkdtempSync(join(tmpdir(), "probe-kit-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Seconds-since-2001 for a given UTC year, for building epoch fixtures. */
const appleSecondsFor = (year) => Math.round(Date.UTC(year, 5, 1) / 1000) - APPLE_EPOCH_OFFSET;

describe("detectEpoch", () => {
  // Each row is a real column from a real store, or a real failure mode.
  const cases = [
    // Bug 2: Safari's visit_time. Read as nanoseconds it lands on the anchor.
    ["Safari visit_time — apple seconds, past", appleSecondsFor(2024), "apple-seconds"],
    // Bug 3: Calendar start_date. A calendar holds FUTURE events.
    ["Calendar start_date — apple seconds, future", appleSecondsFor(2030), "apple-seconds"],
    ["Calendar, an old imported event", appleSecondsFor(2003), "apple-seconds"],
    // Bug 1: Messages stores nanoseconds since 2001.
    ["Messages date — apple nanoseconds", appleSecondsFor(2026) * 1e9, "apple-nanoseconds"],
    ["plain Unix seconds", Math.round(Date.UTC(2026, 5, 1) / 1000), "unix-seconds"],
    ["plain Unix milliseconds", Date.UTC(2026, 5, 1), "unix-milliseconds"],
    // A bitmask, not a date. Must NOT be coerced into looking like one.
    ["a small integer that is not a date", 5, "unknown"],
  ];

  for (const [label, value, expected] of cases) {
    it(`reads ${label} as ${expected}`, () => {
      assert.equal(detectEpoch(value).epoch, expected);
    });
  }

  it("never picks a reading that lands on the 2001 anchor", () => {
    // The degenerate case: any value divided into near-nothing sits on the
    // anchor and renders as a perfectly plausible "2001".
    const onAnchor = detectEpoch(appleSecondsFor(2024)).considered.find(
      (c) => c.epoch === "apple-nanoseconds",
    );
    assert.equal(onAnchor.year, 2001);
    assert.equal(onAnchor.plausible, false, "2001-on-the-anchor must be rejected");
  });

  it("keeps the rejected readings so a wrong pick is visible", () => {
    const { considered } = detectEpoch(appleSecondsFor(2024));
    assert.deepEqual(
      considered.map((c) => c.epoch),
      ["apple-nanoseconds", "apple-seconds", "unix-seconds", "unix-milliseconds"],
    );
    assert.ok(considered.every((c) => "year" in c && "plausible" in c));
  });

  it("prefers the plausible reading closest to now", () => {
    // A genuine Unix timestamp is ALSO a valid apple-seconds date, 31 years late.
    // Both are in-window, so first-match would get it wrong.
    const unix = Math.round(Date.UTC(2026, 5, 1) / 1000);
    const viable = detectEpoch(unix).considered.filter((c) => c.plausible);
    assert.ok(viable.length > 1, "this case is only interesting if it is ambiguous");
    assert.equal(detectEpoch(unix).epoch, "unix-seconds");
  });

  for (const empty of [null, undefined, 0, ""]) {
    it(`reports "no dates present" for ${JSON.stringify(empty)}`, () => {
      assert.equal(detectEpoch(empty).tested, false);
    });
  }
});

describe("sane", () => {
  const anchor = new Date(APPLE_EPOCH_OFFSET * 1000);
  it("rejects the 2001 anchor for an Apple-offset reading", () => {
    assert.equal(sane(anchor, APPLE_EPOCH_OFFSET), false);
  });
  it("accepts the same instant for a Unix-offset reading", () => {
    // 2001-01-01 is a legitimate Unix-epoch date; only the anchored readings
    // can produce it degenerately.
    assert.equal(sane(anchor, 0), true);
  });
  it("accepts future dates — calendars hold them", () => {
    assert.equal(sane(new Date(Date.UTC(2040, 0, 1)), APPLE_EPOCH_OFFSET), true);
  });
  it("rejects out-of-window years", () => {
    assert.equal(sane(new Date(Date.UTC(1970, 0, 1)), 0), false);
    assert.equal(sane(new Date(Date.UTC(2200, 0, 1)), 0), false);
  });
  it("rejects a non-Date and an invalid Date", () => {
    assert.equal(sane("2026-01-01", 0), false);
    assert.equal(sane(new Date(Number.NaN), 0), false);
  });
});

describe("looksLikeDateColumn", () => {
  // The traps: substring matching finds "end" inside calENDar_id and
  // self_attENDee_id, and pairs start_tz (a timezone STRING) with start_date.
  const cases = [
    ["start_date", "REAL", true],
    ["end_date", "REAL", true],
    ["last_modified", "REAL", true],
    ["creation_date", "TIMESTAMP", true],
    ["visit_time", "REAL", true],
    ["date", "INTEGER", true],
    ["calendar_id", "INTEGER", false],
    ["self_attendee_id", "INTEGER", false],
    ["start_tz", "TEXT", false],
    // Core Data: no underscores anywhere, so the snake_case rule alone finds
    // NOTHING in a Notes, Contacts or Maps store.
    ["ZCREATIONDATE", "TIMESTAMP", true],
    ["ZLASTVISITEDDATE", "TIMESTAMP", true],
    ["ZSTARTTIME", "REAL", true],
    // The CamelCase version of the calENDar_id trap: "update" and "validated"
    // both CONTAIN "date". Suffix matching is what keeps them out.
    ["ZUPDATECOUNT", "INTEGER", false],
    ["ZVALIDATED", "INTEGER", false],
    ["ZMANDATEID", "INTEGER", false],
    // Still a string, still not a date, now in Core Data spelling.
    ["ZSTARTTIMEZONE", "VARCHAR", false],
    ["modified_properties", "BLOB", false],
    ["summary", "VARCHAR", false],
  ];
  for (const [name, type, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${name} (${type})`, () => {
      assert.equal(looksLikeDateColumn(name, type), expected);
    });
  }
});

describe("escapeLike", () => {
  it("leaves an ordinary needle alone", () => {
    assert.equal(escapeLike("dinner"), "dinner");
  });
  it("escapes the wildcards that would silently widen a search", () => {
    assert.equal(escapeLike("100%"), "100\\%");
    assert.equal(escapeLike("a_b"), "a\\_b");
  });
  it("escapes the escape character first, so it is not doubled twice", () => {
    assert.equal(escapeLike("c\\d"), "c\\\\d");
    assert.equal(escapeLike("\\%"), "\\\\\\%");
  });
});

describe("redaction", () => {
  it("drops the host entirely from a URL", () => {
    const masked = maskUrl("https://clinic.example.com/patients/12345?token=abc");
    assert.ok(!masked.includes("clinic"), "host must not survive");
    assert.ok(!masked.includes("12345"), "path must not survive");
    assert.equal(masked, `https://<host:${"clinic.example.com".length}>/<2 segments>`);
  });
  it("handles a bare host and a non-URL", () => {
    assert.equal(maskUrl("https://example.com"), "https://<host:11>/");
    assert.ok(maskUrl("not a url").endsWith("no scheme>"));
  });
  it("removes phone numbers, emails and uuids from an identifier", () => {
    const masked = maskIdentity("iMessage;-;+15551234567");
    assert.ok(!/1555/.test(masked), "phone digits must not survive");
    const email = maskIdentity("iMessage;-;someone@example.com");
    assert.ok(!email.includes("someone"), "email local part must not survive");
    assert.equal(
      maskIdentity("x-apple-reminder://B1E2C3D4-1111-2222-3333-444455556666"),
      "x-apple-reminder://<uuid>",
    );
  });
  it("flattens any digit that survives the earlier passes", () => {
    assert.ok(!/[1-9]/.test(maskIdentity("acct-4821")));
  });
});

describe("toFileUri", () => {
  it("encodes the space in Mail's 'Envelope Index'", () => {
    assert.ok(toFileUri("/a/Envelope Index", "mode=ro").includes("Envelope%20Index"));
  });
  it("encodes ? and # so they are not read as URI syntax", () => {
    const uri = toFileUri("/a/we?rd#name", "mode=ro");
    assert.ok(uri.includes("%3f"), uri);
    assert.ok(uri.includes("%23"), uri);
    assert.ok(uri.endsWith("?mode=ro"));
  });
});

describe("parseArgs", () => {
  it("defaults the term and leaves flags off", () => {
    const a = parseArgs([]);
    assert.deepEqual([a.json, a.launch, a.write, a.term], [false, false, false, "a"]);
  });
  it("reads flags and valued options", () => {
    const a = parseArgs(["--json", "--launch", "--write", "--term=dinner"]);
    assert.deepEqual([a.json, a.launch, a.write, a.term], [true, true, true, "dinner"]);
    assert.equal(a.valueOf("days", "90"), "90");
    assert.equal(parseArgs(["--days=30"]).valueOf("days", "90"), "30");
  });
});

describe("file lane", () => {
  // A store shaped like the real ones: a Core Data-ish table with a TEXT id, a
  // huge INTEGER date, and an index — so ordering, overflow and the bridge scan
  // are all exercised against real SQLite rather than a mock.
  const dbPath = join(scratch, "store.sqlite");
  const NANOS = BigInt(appleSecondsFor(2026)) * 1_000_000_000n;

  {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE item (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid VARCHAR,
      label TEXT,
      date INTEGER,
      count INTEGER
    )`);
    db.exec(`CREATE INDEX item_by_date ON item(date)`);
    db.exec(`CREATE TABLE other (ref VARCHAR)`);
    const ins = db.prepare("INSERT INTO item (uuid, label, date, count) VALUES (?, ?, ?, ?)");
    ins.run("AAAA1111-2222-3333-4444-555566667777", "first", NANOS, 3);
    ins.run("BBBB1111-2222-3333-4444-555566667777", "second", NANOS - 1_000_000_000n, 4);
    db.prepare("INSERT INTO other (ref) VALUES (?)").run("AAAA1111-2222-3333-4444-555566667777");
    db.close();
  }

  it("opens read-only and refuses writes", () => {
    const opened = openStore(dbPath);
    assert.ok(opened.db, opened.error);
    assert.equal(opened.mode, "ro");
    assert.equal(opened.walBlind, false);
    assert.throws(() => opened.db.exec("INSERT INTO item (label) VALUES ('nope')"));
    opened.db.close();
  });

  it("reports an error rather than throwing on a missing file", () => {
    const missing = openStore(join(scratch, "nope.sqlite"));
    assert.equal(missing.db, null);
    assert.ok(missing.error);
  });

  it("dumps schema in replayable order, tables before indexes", () => {
    const opened = openStore(dbPath);
    const { ddlRows, tables, fingerprint } = dumpSchema(opened.db);
    const types = ddlRows.map((r) => r.type);
    assert.equal(types.lastIndexOf("table") < types.indexOf("index"), true, types.join(","));
    assert.deepEqual(tables.toSorted(), ["item", "other"]);
    // AUTOINCREMENT creates sqlite_sequence implicitly; it cannot be declared,
    // so a dump containing it would not replay.
    assert.ok(!tables.includes("sqlite_sequence"));
    assert.match(fingerprint, /^[0-9a-f]{12}$/);
    opened.db.close();
  });

  it("REGRESSION: reads a date too large for a JS number", () => {
    // The Messages bug. A plain SELECT MAX(date) throws in node:sqlite, and a
    // swallowed throw is indistinguishable from an empty column.
    const opened = openStore(dbPath);
    assert.throws(
      () => opened.db.prepare("SELECT MAX(date) AS m FROM item").get(),
      "precondition: node:sqlite must still throw on this, or the bug is moot",
    );
    const max = maxNumericAsText(opened.db, "item", "date");
    assert.equal(max.raw, String(NANOS));
    assert.equal(max.digits, String(NANOS).length);
    assert.equal(max.exceedsSafeInteger, true);
    assert.equal(detectEpoch(max.value).epoch, "apple-nanoseconds");
    opened.db.close();
  });

  it("aggregates with MIN as well, for a far-future MAX", () => {
    const opened = openStore(dbPath);
    const min = aggNumericAsText(opened.db, "item", "date", "MIN");
    assert.equal(min.raw, String(NANOS - 1_000_000_000n));
    opened.db.close();
  });

  it("finds the id bridge and ignores non-TEXT columns", () => {
    const opened = openStore(dbPath);
    const { columnInfo } = tableTools(opened.db);
    const found = findIdBridge(opened.db, ["item", "other"], columnInfo, [
      { form: "full id", value: "AAAA1111-2222-3333-4444-555566667777" },
    ]);
    assert.equal(found.found, true);
    assert.deepEqual(found.hits.map((h) => `${h.table}.${h.column}`).toSorted(), [
      "item.uuid",
      "other.ref",
    ]);
    opened.db.close();
  });

  it("reports found:false when nothing matches, and not-tested when there is no needle", () => {
    const opened = openStore(dbPath);
    const { columnInfo } = tableTools(opened.db);
    assert.equal(
      findIdBridge(opened.db, ["item"], columnInfo, [{ form: "x", value: "absent" }]).found,
      false,
    );
    assert.equal(
      findIdBridge(opened.db, ["item"], columnInfo, [{ form: "x", value: null }]).tested,
      false,
    );
    opened.db.close();
  });

  it("swallows query errors into safe defaults", () => {
    const opened = openStore(dbPath);
    const { columnInfo, countOf, one, all } = tableTools(opened.db);
    assert.deepEqual(columnInfo("no_such_table"), []);
    assert.equal(countOf("no_such_table"), null);
    assert.equal(one("SELECT * FROM no_such_table"), null);
    assert.deepEqual(all("SELECT * FROM no_such_table"), []);
    assert.equal(countOf("item"), 2);
    opened.db.close();
  });
});

describe("fileFacts", () => {
  it("separates exists from readable — the whole shape of a TCC failure", () => {
    const readable = join(scratch, "readable.txt");
    writeFileSync(readable, "hello");
    assert.deepEqual(
      (({ exists, readable: r, sizeBytes }) => ({ exists, r, sizeBytes }))(fileFacts(readable)),
      { exists: true, r: true, sizeBytes: 5 },
    );

    const absent = fileFacts(join(scratch, "absent.txt"));
    assert.equal(absent.exists, false);
    assert.equal(absent.readable, false);
    assert.equal(absent.sizeBytes, null);
  });

  it("reports exists=true, readable=false for an unreadable file", function () {
    // The TCC shape: stat succeeds, open does not. Skipped as root, which can
    // read anything regardless of mode.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return;
    }
    const locked = join(scratch, "locked.txt");
    writeFileSync(locked, "secret");
    chmodSync(locked, 0o000);
    const facts = fileFacts(locked);
    assert.equal(facts.exists, true, "stat must still succeed");
    assert.equal(facts.readable, false, "access must fail");
    chmodSync(locked, 0o600);
  });

  it("treats a listable directory as readable", () => {
    // `readable` opens the file rather than calling access(2), because on a
    // TCC-protected store access(2) can succeed where open fails — measured on
    // Contacts. macOS refuses to open a directory for reading, so the EISDIR
    // fallback has to hold: Reminders' store path IS a directory.
    assert.equal(fileFacts(scratch).readable, true);
  });
});
