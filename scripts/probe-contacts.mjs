#!/usr/bin/env node
// Phase 0 spike for Apple Contacts.
//
// Contacts is being probed as a DEPENDENCY, not because anyone asked for a
// contacts server. `docs/messages.md` settled that Messages is buildable; what
// it did not settle is whether the output would be READABLE. chat.db stores a
// correspondent as `handle.id` — `+15551234567` or an email — and nothing else.
// A Messages server without a resolver answers
//
//     "+15551234567 said ..."
//
// which is a technically complete answer that nobody can use. Contacts is the
// only local store that turns that back into a name, so the question "should
// Messages ship" now depends on a number nobody has measured.
//
// THE NUMBER: what fraction of the handles in chat.db resolve to a contact.
// That is this probe's reason to exist, and it is deliberately the same shape as
// the finding that reframed Safari — 60.7% of open tabs resolved to a history
// row, which turned "enrich a tab from history" from a feature into a feature
// with an error case. If handle resolution lands at 95% the resolver is a
// detail; if it lands at 50% then "unknown sender" is a first-class output state
// and the tool descriptions have to say so.
//
// The questions, in order:
//
//     1. IS ONE FILE ENOUGH? Contacts keeps a database at the top of
//        ~/Library/Application Support/AddressBook AND one per account under
//        Sources/<UUID>/. Whether the top-level file aggregates the sources or
//        is merely the local account decides whether a server opens one store or
//        N — and N is not known ahead of time, which is a different shape of
//        problem from every surface probed so far.
//     2. WHAT SHAPE ARE THE PHONE NUMBERS? Contacts stores what the user typed:
//        `(555) 123-4567`, `06 12 34 56 78`, `+1 555 123 4567`. chat.db stores
//        E.164. So the join is not string equality, and the interesting question
//        is which NORMALIZED column already exists — Apple has to solve this too,
//        for search and for incoming-call matching, so the answer is probably in
//        the schema rather than in code we would have to write.
//     3. WHAT ACTUALLY RESOLVES? Measured against real handles, under several
//        normalizations, reported as rates. Including the two failure modes that
//        matter: handles that resolve to NOTHING, and handles that resolve to
//        MORE THAN ONE contact, which suffix matching produces and which is
//        worse than no answer because it is silently wrong.
//     4. IS THERE AN APPLE EVENTS LANE? Contacts is scriptable, unlike Messages.
//        If the dictionary is complete and fast enough this surface could follow
//        Reminders rather than Calendar — which would matter, because it would be
//        the first read lane that survives a schema drift.
//
// Dependency-free (node builtins + scripts/lib/probe-kit.mjs). Databases are
// opened read-only and NEVER written to.
//
// OUTPUT IS REDACTED ON PURPOSE: counts, timings, lengths, shapes, column names
// and DDL only. NO NAMES, no phone numbers, no email addresses, no postal
// addresses, no birthdays, no notes — and, in the cross-store section, no
// handles either. This store is a list of everyone the user knows; the report is
// the kind of thing that gets pasted into an issue. Phone numbers are described
// by a SHAPE CLASS derived from the value (`e164`, `digits`, `formatted`) and
// the value itself never leaves the process. The Apple Events scripts below
// return counts and string LENGTHS only, never a field.
//
//   node scripts/probe-contacts.mjs                # human-readable report
//   node scripts/probe-contacts.mjs --json         # the raw document
//   node scripts/probe-contacts.mjs --launch       # allow launching Contacts
//   node scripts/probe-contacts.mjs --write        # also write the schema fixture

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  appleEventsLane,
  detectEpoch,
  dumpSchema,
  fileFacts,
  findIdBridge,
  isTextType,
  listable,
  macosVersion,
  maxNumericAsText,
  openStore,
  parseArgs,
  safe,
  tableTools,
  timed,
  uuidOf,
  writeFixture,
  yn,
} from "./lib/probe-kit.mjs";

const args = parseArgs(process.argv.slice(2));
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const AB_DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const AB_ROOT_DB = join(AB_DIR, "AddressBook-v22.abcddb");
const AB_SOURCES = join(AB_DIR, "Sources");
// Exists on this machine (docs/surfaces.md), contents unknown. Reported, not assumed.
const GROUP_CONTAINER = join(homedir(), "Library", "Group Containers", "group.com.apple.contacts");
// The other half of the cross-store question. Read-only, and only handles are
// touched — never a message, never a chat name.
const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");

const tilde = (p) => p.replace(homedir(), "~");

const doc = {
  probeVersion: 1,
  ranAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  macos: macosVersion(),
  sqlite: null,
  findings: {},
  verdict: {},
  notes: [],
};

// ─── redaction helpers, specific to this surface ─────────────────────────────

/**
 * A phone number reduced to a SHAPE, never a value.
 *
 * The classes are the ones that decide the join strategy, which is the only
 * reason the probe looks at a number at all:
 *
 *   e164      +15551234567     already normalized; joins directly to chat.db
 *   digits    5551234567       normalized but no country code
 *   formatted (555) 123-4567   as typed; needs stripping before anything works
 *   short     911, 38600       shortcodes — never resolvable, and counting them
 *                              separately keeps them from depressing the rate
 *   other                      anything else, so the classes stay honest
 */
const phoneShape = (value) => {
  const s = String(value ?? "").trim();
  if (!s) return "empty";
  const digits = s.replace(/\D/g, "");
  if (!digits) return "other";
  if (digits.length <= 6) return "short";
  if (/^\+\d{7,15}$/.test(s)) return "e164";
  if (/^\d{7,15}$/.test(s)) return "digits";
  return "formatted";
};

/** Digits only. The lowest common denominator every strategy below starts from. */
const digitsOf = (value) => String(value ?? "").replace(/\D/g, "");

/**
 * The suffix key, which is how phone matching is done everywhere in practice.
 *
 * A stored `06 12 34 56 78` and a handle `+33612345678` share their last nine
 * digits and nothing else — no prefix rule connects them without knowing the
 * user's country, which this probe deliberately does not guess. The cost is
 * COLLISIONS, and measuring those is the point: a suffix short enough to always
 * match is also short enough to match the wrong person.
 */
const suffix = (value, n) => {
  const d = digitsOf(value);
  return d.length >= n ? d.slice(-n) : null;
};

// ─── Lane 1: Apple Events ────────────────────────────────────────────────────
// Every script returns COUNTS AND LENGTHS ONLY. Not a name, not a number, not an
// email — a probe that prints the user's address book would be a worse outcome
// than not running at all.

/**
 * Does the dictionary answer, and how fast?
 *
 * Modelled on the Messages read-attempt table rather than on a single call,
 * because Messages taught that "scriptable" and "answers a script" are different
 * claims: it reports itself running via NSRunningApplication and still answers
 * "Application isn't running" to every read. Each verb is tried on its own so a
 * partial dictionary reads as partial rather than as broken.
 */
const READ_ATTEMPTS = `
function run(argv) {
  var C = Application("Contacts");
  var out = {};
  function attempt(name, fn) {
    var started = new Date().getTime();
    try {
      var value = fn();
      out[name] = { ok: true, ms: new Date().getTime() - started, value: value };
    } catch (e) {
      out[name] = { ok: false, ms: new Date().getTime() - started, error: String(e.message || e) };
    }
  }
  // Counts and lengths only. Nothing here may return a field value.
  attempt("count", function () { return C.people().length; });
  attempt("ids", function () { return C.people.id().length; });
  attempt("namesLength", function () {
    var n = C.people.name();
    var total = 0;
    for (var i = 0; i < n.length; i++) total += String(n[i] || "").length;
    return { rows: n.length, totalChars: total };
  });
  attempt("phonesBulk", function () {
    var v = C.people.phones.value();
    var rows = 0;
    for (var i = 0; i < v.length; i++) rows += (v[i] || []).length;
    return { people: v.length, phoneRows: rows };
  });
  attempt("myCard", function () {
    var me = C.myCard();
    return { present: me !== null && me !== undefined };
  });
  return JSON.stringify(out);
}
`;

/** One real person id, so the id-bridge scan has a needle. Not a name. */
const SAMPLE_ID = `
function run(argv) {
  var C = Application("Contacts");
  var ids = C.people.id();
  if (!ids.length) return JSON.stringify({ id: null });
  return JSON.stringify({ id: String(ids[0]), total: ids.length });
}
`;

const aeLane = appleEventsLane("com.apple.AddressBook", "Contacts", args.launch);
doc.findings.appleEventsLane = aeLane;

if (aeLane.available) {
  doc.findings.appleEventsReads = timed("reads", READ_ATTEMPTS, {}, 120_000);
  doc.findings.appleEventsSample = timed("sample", SAMPLE_ID, {}, 60_000);
} else {
  doc.findings.appleEventsReads = { ok: false, skipped: true, reason: aeLane.reason };
  doc.findings.appleEventsSample = { ok: false, skipped: true, reason: aeLane.reason };
}

// ─── Lane 2: the file lane ───────────────────────────────────────────────────

/**
 * Q1. One store, or one per account?
 *
 * `exists` and `readable` are kept apart here for the same reason every other
 * probe keeps them apart: `stat` succeeds on a TCC-protected file, so "absent"
 * and "denied" look identical to anything that only asks whether a path is
 * there. Conflating them is what sent Calendar toward EventKit for a week.
 */
/** Real paths, kept out of the report. `doc` never carries one. */
const sourcePaths = [];

doc.findings.layout = safe(() => {
  const sources = [];
  if (listable(AB_SOURCES)) {
    for (const entry of safe(
      () => readdirSync(AB_SOURCES, { withFileTypes: true }),
      () => [],
    )) {
      if (!entry.isDirectory()) continue;
      const dbPath = join(AB_SOURCES, entry.name, "AddressBook-v22.abcddb");
      const { path: _drop, ...facts } = fileFacts(dbPath);
      if (!facts.exists) continue;
      sourcePaths.push(dbPath);
      // The directory name is an account UUID. Not a secret, but not needed
      // either, so only its shape is recorded.
      sources.push({ source: uuidOf(entry.name) ? "<uuid>" : "<named>", ...facts });
    }
  }
  return {
    dir: tilde(AB_DIR),
    dirListable: listable(AB_DIR),
    root: { ...fileFacts(AB_ROOT_DB), path: tilde(AB_ROOT_DB) },
    sourcesListable: listable(AB_SOURCES),
    sourceCount: sources.length,
    sources,
    groupContainerExists: listable(GROUP_CONTAINER) || fileFacts(GROUP_CONTAINER).exists,
  };
});

const opened = doc.findings.layout?.root?.readable ? openStore(AB_ROOT_DB) : null;
let ddlRows = null;

if (opened?.db) {
  const db = opened.db;
  doc.sqlite = opened.sqlite;
  const { columnInfo, countOf, one, all } = tableTools(db);

  doc.findings.open = { ok: true, mode: opened.mode, ms: opened.openMs, walBlind: opened.walBlind };

  const schema = dumpSchema(db);
  ddlRows = schema.ddlRows;
  doc.findings.schema = {
    fingerprint: schema.fingerprint,
    objectCount: schema.objectCount,
    tables: schema.tables,
    views: schema.views,
  };

  const tables = schema.tables;
  const hasTable = (t) => tables.includes(t);
  const colsOf = (t) => columnInfo(t).map((c) => c.name);

  /**
   * Which table is which, discovered rather than assumed.
   *
   * The Calendar probe's `linkColumn` bug is the reason: it named two columns as
   * foreign keys because their values happened to fall inside another table's
   * rowid range, and the fix was to stop inferring from shape alone. Here the
   * risk is the mirror image — hardcoding `ZABCDPHONENUMBER` would work on this
   * machine and break silently on any macOS that renames it. So: match on the
   * name, then confirm by looking at what the columns hold.
   */
  const findTable = (re) => tables.filter((t) => re.test(t));
  doc.findings.entities = {
    record: findTable(/ABCDRECORD$/i),
    phone: findTable(/PHONE/i),
    email: findTable(/EMAIL/i),
    postal: findTable(/POSTAL|ADDRESS$/i),
    // Apple has to normalize numbers for search and for caller ID, so a
    // normalized index table probably exists. Whether it does decides how much
    // work the resolver has to do itself.
    index: findTable(/INDEX/i),
    note: findTable(/NOTE/i),
  };

  const RECORD = doc.findings.entities.record[0] ?? null;
  const PHONE = doc.findings.entities.phone[0] ?? null;
  const EMAIL = doc.findings.entities.email[0] ?? null;

  doc.findings.tableCounts = Object.fromEntries(
    tables.filter((t) => /^Z[A-Z]/.test(t)).map((t) => [t, countOf(t)]),
  );

  /** Q2. What do the phone rows actually look like? Shapes only. */
  doc.findings.phoneShapes = safe(() => {
    if (!PHONE) return { tested: false, reason: "no phone table found" };
    const cols = columnInfo(PHONE);
    const textCols = cols.filter((c) => isTextType(c.type)).map((c) => c.name);
    // Every text column is profiled, because the useful one is whichever holds a
    // normalized form and its name is not guessable across macOS releases.
    const profile = {};
    for (const col of textCols) {
      const rows = all(
        `SELECT "${col}" AS v FROM "${PHONE}" WHERE "${col}" IS NOT NULL AND "${col}" <> '' LIMIT 400`,
      );
      if (!rows.length) {
        profile[col] = { populated: 0 };
        continue;
      }
      const shapes = {};
      let totalLen = 0;
      for (const r of rows) {
        const s = phoneShape(r.v);
        shapes[s] = (shapes[s] ?? 0) + 1;
        totalLen += String(r.v).length;
      }
      profile[col] = {
        populated: rows.length,
        avgLength: Math.round(totalLen / rows.length),
        shapes,
      };
    }
    return {
      tested: true,
      table: PHONE,
      rows: countOf(PHONE),
      columns: cols.map((c) => `${c.name}:${c.type}`),
      profile,
    };
  });

  doc.findings.emailShape = safe(() => {
    if (!EMAIL) return { tested: false, reason: "no email table found" };
    const cols = columnInfo(EMAIL);
    const addrCol = cols.find((c) => isTextType(c.type) && /ADDRESS|VALUE/i.test(c.name))?.name;
    return {
      tested: true,
      table: EMAIL,
      rows: countOf(EMAIL),
      columns: cols.map((c) => `${c.name}:${c.type}`),
      addressColumn: addrCol ?? null,
    };
  });

  /** Q2b. The epoch, which is Core Data seconds everywhere except Messages. */
  doc.findings.epoch = safe(() => {
    if (!RECORD) return { tested: false, reason: "no record table found" };
    const dateCols = colsOf(RECORD).filter((c) => /DATE|MODIF|CREAT/i.test(c));
    const out = {};
    for (const col of dateCols) {
      const max = maxNumericAsText(db, RECORD, col);
      out[col] = max === null ? { tested: false, reason: "no rows" } : detectEpoch(max);
    }
    return { tested: true, table: RECORD, columns: out };
  });

  /** Q2c. Is there a "me" card, and can it be found from the file lane alone? */
  doc.findings.meCard = safe(() => {
    if (!RECORD) return { tested: false, reason: "no record table found" };
    const flagCols = colsOf(RECORD).filter((c) => /\bME\b|ISME|OWNER/i.test(c));
    const counts = {};
    for (const col of flagCols) {
      counts[col] = one(`SELECT COUNT(*) AS c FROM "${RECORD}" WHERE "${col}" = 1`)?.c ?? null;
    }
    return { tested: true, candidateColumns: flagCols, counts };
  });

  /** Q2d. Duplicates across accounts, which decide whether one handle → one name. */
  doc.findings.linking = safe(() => {
    if (!RECORD) return { tested: false, reason: "no record table found" };
    const cols = colsOf(RECORD);
    return {
      tested: true,
      records: countOf(RECORD),
      // Contacts shows ONE unified card for records linked across accounts. If a
      // link column exists, the resolver can collapse them; if not, a person in
      // both iCloud and Google resolves to two names and the tool has to say so.
      linkColumns: cols.filter((c) => /LINK|UNIFI|MERGE/i.test(c)),
      containerColumns: cols.filter((c) => /CONTAINER|SOURCE|ACCOUNT|STORE/i.test(c)),
    };
  });

  /** Q4b. The id bridge, for whichever lane ends up authoritative. */
  doc.findings.idBridge = safe(() => {
    const live = doc.findings.appleEventsSample?.id ?? null;
    if (!live) return { tested: false, reason: "no live person id (Apple Events lane unavailable)" };
    return findIdBridge(db, tables, columnInfo, [
      { label: "person.id", value: String(live) },
      { label: "person.id uuid", value: uuidOf(live) },
    ]);
  });

  // ─── Q3. THE NUMBER ────────────────────────────────────────────────────────
  /**
   * Cross-store: what fraction of real Messages handles resolve to a contact?
   *
   * This reaches into another surface's store, which no other probe does. It is
   * justified because the question is not about either store on its own — it is
   * about whether they compose, and that cannot be answered from either side.
   * Both are opened read-only. NOTHING from either store is printed: handles are
   * counted and classified, contacts are counted, and only rates come out.
   *
   * Five strategies, compared rather than chosen, because the right one is a
   * measurement and not a preference:
   *
   *   exact      string equality — the naive join, expected to do badly
   *   digits     both sides stripped to digits
   *   last-10    suffix match, national-number length
   *   last-9     suffix match, one shorter
   *   last-7     suffix match, the classic — highest hit rate, worst collisions
   *
   * The collision count is reported beside every hit rate. A strategy that
   * resolves 99% of handles by matching seven digits is not better than one that
   * resolves 90% cleanly; it is a strategy that puts the wrong name on somebody's
   * messages, which is the single worst output this surface could produce.
   */
  doc.findings.resolution = safe(() => {
    if (!PHONE) return { tested: false, reason: "no phone table found" };
    const chat = fileFacts(CHAT_DB);
    if (!chat.exists) return { tested: false, reason: "chat.db not present" };
    if (!chat.readable) return { tested: false, reason: "chat.db not readable (Full Disk Access)" };

    const chatOpened = openStore(CHAT_DB);
    if (!chatOpened.db) return { tested: false, reason: `chat.db did not open: ${chatOpened.error}` };

    try {
      const chatTools = tableTools(chatOpened.db);
      const handles = chatTools.all(
        `SELECT DISTINCT id AS v FROM handle WHERE id IS NOT NULL AND id <> ''`,
      );
      if (!handles.length) return { tested: false, reason: "no handles in chat.db" };

      // Partition first. An SMS shortcode or a no-reply address can never resolve
      // and counting it as a miss would understate a resolver that works fine.
      const emails = [];
      const phones = [];
      const shortcodes = [];
      for (const h of handles) {
        const v = String(h.v);
        if (v.includes("@")) emails.push(v);
        else if (phoneShape(v) === "short") shortcodes.push(v);
        else phones.push(v);
      }

      // Build the contact side once, keyed every way at once.
      const phoneCols = columnInfo(PHONE)
        .filter((c) => isTextType(c.type))
        .map((c) => c.name);
      const valueCol =
        phoneCols.find((c) => /FULLNUMBER/i.test(c)) ??
        phoneCols.find((c) => /NUMBER|VALUE/i.test(c)) ??
        phoneCols[0];
      if (!valueCol) return { tested: false, reason: "no text column on the phone table" };

      const stored = all(
        `SELECT "${valueCol}" AS v FROM "${PHONE}" WHERE "${valueCol}" IS NOT NULL AND "${valueCol}" <> ''`,
      );

      const index = { exact: new Map(), digits: new Map(), s10: new Map(), s9: new Map(), s7: new Map() };
      const add = (map, key) => {
        if (!key) return;
        map.set(key, (map.get(key) ?? 0) + 1);
      };
      for (const row of stored) {
        const v = String(row.v);
        add(index.exact, v);
        add(index.digits, digitsOf(v));
        add(index.s10, suffix(v, 10));
        add(index.s9, suffix(v, 9));
        add(index.s7, suffix(v, 7));
      }

      const strategies = {
        exact: (v) => index.exact.get(v),
        digits: (v) => index.digits.get(digitsOf(v)),
        "last-10": (v) => index.s10.get(suffix(v, 10)),
        "last-9": (v) => index.s9.get(suffix(v, 9)),
        "last-7": (v) => index.s7.get(suffix(v, 7)),
      };

      const phoneResults = {};
      for (const [name, lookup] of Object.entries(strategies)) {
        let hit = 0;
        let ambiguous = 0;
        for (const v of phones) {
          const n = lookup(v) ?? 0;
          if (n === 1) hit += 1;
          else if (n > 1) ambiguous += 1;
        }
        phoneResults[name] = {
          resolved: hit,
          ambiguous,
          unresolved: phones.length - hit - ambiguous,
          rate: phones.length ? Number(((hit / phones.length) * 100).toFixed(1)) : null,
        };
      }

      // Email is the easy half and worth reporting separately, because a rate
      // that averages the two hides which one is the problem.
      let emailResolved = 0;
      let emailAmbiguous = 0;
      if (EMAIL) {
        const addrCol = columnInfo(EMAIL).find(
          (c) => isTextType(c.type) && /ADDRESS|VALUE/i.test(c.name),
        )?.name;
        if (addrCol) {
          const emailIndex = new Map();
          for (const row of all(
            `SELECT "${addrCol}" AS v FROM "${EMAIL}" WHERE "${addrCol}" IS NOT NULL AND "${addrCol}" <> ''`,
          )) {
            const key = String(row.v).toLowerCase();
            emailIndex.set(key, (emailIndex.get(key) ?? 0) + 1);
          }
          for (const v of emails) {
            const n = emailIndex.get(v.toLowerCase()) ?? 0;
            if (n === 1) emailResolved += 1;
            else if (n > 1) emailAmbiguous += 1;
          }
        }
      }

      return {
        tested: true,
        // Counts only — not one handle, not one number.
        handles: handles.length,
        phoneHandles: phones.length,
        emailHandles: emails.length,
        shortcodeHandles: shortcodes.length,
        storedNumbers: stored.length,
        valueColumn: valueCol,
        phone: phoneResults,
        email: {
          resolved: emailResolved,
          ambiguous: emailAmbiguous,
          unresolved: emails.length - emailResolved - emailAmbiguous,
          rate: emails.length ? Number(((emailResolved / emails.length) * 100).toFixed(1)) : null,
        },
      };
    } finally {
      safe(() => chatOpened.db.close());
    }
  });

  /** Q1b. Does the root database aggregate the sources, or is it one account? */
  doc.findings.aggregation = safe(() => {
    if (!RECORD) return { tested: false, reason: "no record table found" };
    const rootCount = countOf(RECORD);
    const live = doc.findings.appleEventsReads?.count?.value ?? null;

    // Each source opened on its own. They are small, and the sum is the only way
    // to tell an aggregate root database from a root database that is merely the
    // local account sitting beside the accounts that hold everything.
    const perSource = [];
    let sourceTotal = 0;
    for (const path of sourcePaths) {
      const o = openStore(path);
      if (!o.db) {
        perSource.push({ opened: false, records: null });
        continue;
      }
      const n = safe(
        () => o.db.prepare(`SELECT COUNT(*) AS c FROM "${RECORD}"`).get().c,
        () => null,
      );
      if (typeof n === "number") sourceTotal += n;
      perSource.push({ opened: true, records: typeof n === "number" ? n : null });
      safe(() => o.db.close());
    }

    return {
      tested: true,
      rootRecords: rootCount,
      appleEventsPeople: live,
      sourceRecords: perSource,
      sourceTotal,
      // The comparison that answers it. Equal means the root file is the whole
      // address book and a server opens one store; short means the sources have
      // to be unioned, and the count of them is not known ahead of time.
      // Three numbers, and the disagreements between them are the finding.
      // Apple Events is the only INDEPENDENT count — it is what Contacts.app
      // itself shows — so it is the yardstick rather than one more reading.
      verdict:
        live === null
          ? sourcePaths.length === 0
            ? "no per-account sources: the root database is the whole address book"
            : `unknown — Apple Events lane unavailable, so there is no independent count to compare ${rootCount} root against ${sourceTotal} across ${sourcePaths.length} sources`
          : rootCount === live
            ? "root database matches the live count: one store is enough"
            : rootCount < live
              ? `root database is SHORT by ${live - rootCount}: the ${sourcePaths.length} sources must be unioned (they hold ${sourceTotal})`
              : `root database has ${rootCount - live} MORE than the live count: duplicates, soft-deleted rows, or both`,
      perSourceProbed: perSource.length,
    };
  });

  safe(() => db.close());
} else {
  doc.findings.open = { ok: false, error: opened?.error ?? null };
  doc.notes.push(
    doc.findings.layout?.root?.exists && !doc.findings.layout?.root?.readable
      ? "The store exists but cannot be read. That is Full Disk Access, not a missing file — grant it and re-run."
      : doc.findings.layout?.root?.exists
        ? "The store exists but did not open."
        : "No AddressBook database at the expected path.",
  );
}

// ─── verdict ─────────────────────────────────────────────────────────────────

const res = doc.findings.resolution ?? {};
const best = res.tested
  ? Object.entries(res.phone)
      // The best strategy is the one that resolves most WITHOUT ambiguity, not
      // the one with the highest raw hit rate.
      .map(([name, r]) => ({ name, ...r }))
      .toSorted((a, b) => b.resolved - a.resolved || a.ambiguous - b.ambiguous)[0]
  : null;

doc.verdict = {
  storeReadable: Boolean(opened?.db),
  fingerprint: doc.findings.schema?.fingerprint ?? null,
  appleEventsUsable: doc.findings.appleEventsReads?.ok ?? false,
  aggregation: doc.findings.aggregation?.verdict ?? "not tested",
  bestPhoneStrategy: best?.name ?? null,
  bestPhoneRate: best?.rate ?? null,
  bestPhoneAmbiguous: best?.ambiguous ?? null,
  emailRate: res.email?.rate ?? null,
  // The decision this probe exists to inform.
  messagesReadable:
    best === null
      ? "unknown — resolution not measured"
      : best.rate >= 90
        ? "yes — a resolver makes Messages output readable"
        : best.rate >= 60
          ? "partly — 'unknown sender' has to be a first-class output state"
          : "no — most handles will not resolve; reconsider what a Messages server can claim",
};

// ─── report ──────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const L = [];
  L.push("");
  L.push("APPLE CONTACTS — phase 0");
  L.push(`  macOS ${doc.macos}   node ${doc.node}   sqlite ${doc.sqlite ?? "?"}`);
  L.push("");
  L.push("LAYOUT — one store, or one per account?");
  const lay = doc.findings.layout ?? {};
  L.push(`  directory             ${lay.dir}  (listable ${yn(lay.dirListable)})`);
  L.push(
    `  root database         exists ${yn(lay.root?.exists)} / readable ${yn(lay.root?.readable)}` +
      `   (${lay.root?.sizeBytes ?? "?"} B, wal ${lay.root?.walSizeBytes ?? 0} B)`,
  );
  L.push(`  per-account sources   ${lay.sourceCount ?? "?"}  (listable ${yn(lay.sourcesListable)})`);
  const agg = doc.findings.aggregation ?? {};
  if (agg.tested) {
    L.push(
      `  records               root ${agg.rootRecords ?? "?"}   sources ${agg.sourceTotal ?? "?"}   live ${agg.appleEventsPeople ?? "?"}`,
    );
  }
  L.push(`  group container       ${yn(lay.groupContainerExists)}`);
  L.push(`  aggregation           ${doc.findings.aggregation?.verdict ?? "not tested"}`);
  L.push("");
  L.push("APPLE EVENTS — the lane Messages does not have");
  if (doc.findings.appleEventsReads?.skipped) {
    L.push(`  skipped               ${doc.findings.appleEventsReads.reason}`);
  } else if (doc.findings.appleEventsReads?.ok) {
    for (const [name, r] of Object.entries(doc.findings.appleEventsReads)) {
      if (typeof r !== "object" || r === null || !("ok" in r)) continue;
      L.push(
        `  ${name.padEnd(20)}  ${r.ok ? `ok  ${String(r.ms).padStart(6)} ms` : `FAILED  ${r.error}`}`,
      );
    }
  } else {
    L.push(`  failed                ${doc.findings.appleEventsReads?.error ?? "?"}`);
  }
  L.push("");

  if (opened?.db) {
    L.push("FILE LANE");
    L.push(`  opened                ${doc.findings.open.mode} in ${doc.findings.open.ms} ms`);
    L.push(`  schema fingerprint    ${doc.findings.schema.fingerprint}`);
    L.push(
      `  objects               ${doc.findings.schema.objectCount} (${doc.findings.schema.tables.length} tables)`,
    );
    const ent = doc.findings.entities ?? {};
    for (const [role, names] of Object.entries(ent)) {
      L.push(`  ${role.padEnd(20)}  ${names.join(", ") || "none found"}`);
    }
    L.push("");
    L.push("PHONE NUMBER SHAPES — what the join has to cope with");
    const ph = doc.findings.phoneShapes ?? {};
    if (ph.tested) {
      L.push(`  table                 ${ph.table}  (${ph.rows} rows)`);
      for (const [col, p] of Object.entries(ph.profile)) {
        if (!p.populated) continue;
        const shapes = Object.entries(p.shapes)
          .toSorted((a, b) => b[1] - a[1])
          .map(([s, n]) => `${s} ${n}`)
          .join(", ");
        L.push(`  ${col.padEnd(20)}  avg ${String(p.avgLength).padStart(3)} chars   ${shapes}`);
      }
    } else {
      L.push(`  not tested            ${ph.reason}`);
    }
    L.push("");
    L.push("RESOLUTION — the number this probe exists for");
    if (res.tested) {
      L.push(
        `  chat.db handles       ${res.handles}   (${res.phoneHandles} phone, ${res.emailHandles} email, ${res.shortcodeHandles} shortcode)`,
      );
      L.push(`  stored numbers        ${res.storedNumbers}  from ${res.valueColumn}`);
      L.push("");
      L.push("     strategy    resolved   ambiguous   unresolved     rate");
      for (const [name, r] of Object.entries(res.phone)) {
        L.push(
          `     ${name.padEnd(10)}  ${String(r.resolved).padStart(8)}  ${String(r.ambiguous).padStart(10)}  ${String(r.unresolved).padStart(11)}  ${String(r.rate ?? "—").padStart(7)}%`,
        );
      }
      L.push(
        `     email       ${String(res.email.resolved).padStart(8)}  ${String(res.email.ambiguous).padStart(10)}  ${String(res.email.unresolved).padStart(11)}  ${String(res.email.rate ?? "—").padStart(7)}%`,
      );
      L.push("");
      L.push("  Ambiguous is not a smaller kind of hit. A handle matching two");
      L.push("  contacts puts the wrong name on someone's messages.");
    } else {
      L.push(`  not tested            ${res.reason}`);
    }
    L.push("");
    L.push("OTHER FINDINGS");
    const ep = doc.findings.epoch ?? {};
    if (ep.tested) {
      for (const [col, e] of Object.entries(ep.columns)) {
        L.push(
          `  ${col.padEnd(20)}  ${e.epoch ?? e.reason}${e.latestYear ? `  (latest ${e.latestYear})` : ""}`,
        );
      }
    }
    const me = doc.findings.meCard ?? {};
    if (me.tested) {
      L.push(`  me-card columns       ${me.candidateColumns.join(", ") || "none found"}`);
      for (const [col, c] of Object.entries(me.counts)) L.push(`  ${col.padEnd(20)}  ${c} rows`);
    }
    const link = doc.findings.linking ?? {};
    if (link.tested) {
      L.push(`  records               ${link.records}`);
      L.push(`  link columns          ${link.linkColumns.join(", ") || "none found"}`);
      L.push(`  container columns     ${link.containerColumns.join(", ") || "none found"}`);
    }
    const bridge = doc.findings.idBridge ?? {};
    if (bridge.tested === false) L.push(`  id bridge             not tested — ${bridge.reason}`);
  }

  L.push("");
  L.push("VERDICT");
  L.push(`  aggregation  : ${doc.verdict.aggregation}`);
  L.push(
    `  best strategy: ${doc.verdict.bestPhoneStrategy ?? "—"}` +
      `${doc.verdict.bestPhoneRate === null ? "" : `  ${doc.verdict.bestPhoneRate}% clean, ${doc.verdict.bestPhoneAmbiguous} ambiguous`}`,
  );
  L.push(`  email        : ${doc.verdict.emailRate === null ? "—" : `${doc.verdict.emailRate}%`}`);
  L.push(`  Messages     : ${doc.verdict.messagesReadable}`);
  for (const n of doc.notes) L.push(`  note: ${n}`);
  L.push("");
  L.push("Full document: re-run with --json");
  console.log(L.join("\n"));
}

if (args.write) {
  writeFixture({
    root: ROOT,
    pkg: "contacts",
    file: "contacts-store.sql",
    ddlRows,
    macos: doc.macos,
    fingerprint: doc.findings.schema?.fingerprint,
    tool: "scripts/probe-contacts.mjs",
  });
}
