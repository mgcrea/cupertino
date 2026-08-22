import type { DatabaseSync } from "node:sqlite";

import {
  columnsOf,
  CORE_DATA_EPOCH_OFFSET,
  escapeLike,
  fingerprintSchema,
  openReadOnly,
  SchemaDriftError,
  type Logger,
  type ReadOnlyMode,
} from "@mgcrea/mcp-apple-core";

import { digitsOf, emailKey, suffixKey, SUFFIX_DIGITS } from "./phone.js";

/**
 * Contacts' file lane.
 *
 * Reads only, and there is no Apple Events lane at all — not even a fallback.
 * `docs/contacts.md` measured the dictionary as fast (63 ms for every id, 52 ms
 * for every phone number) and still ruled it out for reads, because the thing
 * this surface exists to do is join 970 stored numbers against a set of handles
 * by suffix, and no amount of round trips gets a keyed index out of `osascript`.
 * The consequence is worth stating: **a read-only surface needs no Automation
 * grant**, so this server never prompts for one.
 *
 * ## Two things measured here that are not obvious from the schema
 *
 * **The store is plural.** See `locate.ts`. Every method on `ContactsIndex` fans
 * out over shards and merges.
 *
 * **`ZABCDRECORD` is not a table of contacts.** It is a Core Data single-table
 * inheritance root, and groups, containers and an info row live in it alongside
 * people — 425 rows for 420 contacts on the probed machine. `Z_ENT` is the only
 * discriminator, and it is resolved through `Z_PRIMARYKEY` BY NAME rather than
 * hardcoded, because Core Data assigns those numbers per model version.
 */

/** Tables the lane cannot work without. */
const REQUIRED = ["ZABCDRECORD"] as const;

/** The schema this was written against. Named in the drift error, not enforced. */
const PROBED_FINGERPRINT = "4f2871e93f6b";
const PROBED_MACOS = "26.6";

/**
 * Entity names that mean "a person".
 *
 * `ABCDSubscribedContact` inherits from `ABCDContact` and is included: a contact
 * arriving from a subscribed source is still someone whose name should appear
 * beside their messages. Groups (`ABCDGroup`, `ABCDSmartGroup`) and the
 * bookkeeping entities (`ABCDInfo`, `CNCDContainer`) are not people.
 */
const CONTACT_ENTITIES = /^(ABCD)?(Subscribed)?Contact$/i;

export type StoreCapabilities = {
  fingerprint: string;
  recordColumns: Set<string>;
  phoneColumns: Set<string>;
  emailColumns: Set<string>;
  /** `Z_ENT` values that mean a person. Empty means the filter could not be built. */
  contactEntities: number[];
  hasPhones: boolean;
  hasEmails: boolean;
  hasNotes: boolean;
  epochOffset: number;
};

export type IndexContact = {
  recordPk: number;
  /** Stable across runs; the ref is built from it. */
  uniqueId: string | null;
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  organization: string | null;
  jobTitle: string | null;
  /** Assembled below — never a raw column, because no single column holds it. */
  displayName: string;
  /** Which store this came from, so a duplicate across accounts is explicable. */
  source: string;
  linkId: number | null;
  isMe: boolean;
};

export type ContactPhone = { recordPk: number; value: string; label: string | null };
export type ContactEmail = { recordPk: number; value: string; label: string | null };

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * A name to show, assembled from whatever the record actually carries.
 *
 * Falls through deliberately: plenty of real contacts are an organisation with
 * no person name (a garage, a doctor's office), and plenty are a first name
 * alone. Returning an empty string would put a blank where a sender should be,
 * so the last resort is explicit.
 */
export const displayNameOf = (c: {
  firstName: string | null;
  lastName: string | null;
  nickname: string | null;
  organization: string | null;
}): string => {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.nickname || c.organization || "(no name)";
};

/**
 * Add one key to one bucket. A null key is skipped, never stored as `""` — a
 * number too short to make a key must not become a key that matches everything.
 */
const remember = (map: Map<string, Set<string>>, key: string | null, id: string): void => {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.add(id);
  else map.set(key, new Set([id]));
};

/** One opened database, with what was learned about it. */
export type Shard = {
  db: DatabaseSync;
  mode: string;
  caps: StoreCapabilities;
  path: string;
  label: string;
  contacts: number;
};

export class ContactsIndex {
  readonly shards: readonly Shard[];

  constructor(shards: readonly Shard[]) {
    this.shards = shards;
  }

  /** Every shard's fingerprint. More than one distinct value is worth showing. */
  get fingerprints(): string[] {
    return [...new Set(this.shards.map((s) => s.caps.fingerprint))];
  }

  get totalContacts(): number {
    return this.shards.reduce((n, s) => n + s.contacts, 0);
  }

  /**
   * Project a column, or a typed NULL when this store does not have it.
   *
   * Same guard as the other surfaces: the schema is reverse-engineered and
   * unversioned, so an Apple rename costs one field rather than the lane.
   */
  static #col(present: Set<string>, table: string, name: string, alias: string): string {
    return present.has(name) ? `${table}."${name}" AS ${alias}` : `NULL AS ${alias}`;
  }

  static #entFilter(caps: StoreCapabilities, alias: string): string {
    if (!caps.contactEntities.length) return "";
    return `WHERE ${alias}."Z_ENT" IN (${caps.contactEntities.join(", ")})`;
  }

  #contactsFrom(shard: Shard, where: string, params: unknown[], limit: number): IndexContact[] {
    const c = shard.caps.recordColumns;
    const col = ContactsIndex.#col;
    const ent = ContactsIndex.#entFilter(shard.caps, "r");
    const extra = where ? `${ent ? "AND" : "WHERE"} ${where}` : "";
    const sql = `
      SELECT r."Z_PK" AS recordPk,
             ${col(c, "r", "ZUNIQUEID", "uniqueId")},
             ${col(c, "r", "ZFIRSTNAME", "firstName")},
             ${col(c, "r", "ZLASTNAME", "lastName")},
             ${col(c, "r", "ZNICKNAME", "nickname")},
             ${col(c, "r", "ZORGANIZATION", "organization")},
             ${col(c, "r", "ZJOBTITLE", "jobTitle")},
             ${col(c, "r", "ZLINKID", "linkId")},
             ${col(c, "r", "ZCONTAINERWHERECONTACTISME", "isMe")}
        FROM "ZABCDRECORD" r
        ${ent} ${extra}
       ORDER BY r."ZLASTNAME" ASC, r."ZFIRSTNAME" ASC
       LIMIT ${Math.max(1, Math.trunc(limit))}`;
    const rows = shard.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((r) => {
      const parts = {
        firstName: text(r.firstName),
        lastName: text(r.lastName),
        nickname: text(r.nickname),
        organization: text(r.organization),
      };
      return {
        recordPk: Number(r.recordPk),
        uniqueId: text(r.uniqueId),
        ...parts,
        jobTitle: text(r.jobTitle),
        displayName: displayNameOf(parts),
        source: shard.label,
        linkId: num(r.linkId),
        isMe: num(r.isMe) !== null,
      };
    });
  }

  /** Every contact, across every shard. */
  list(limit: number): IndexContact[] {
    return this.shards.flatMap((s) => this.#contactsFrom(s, "", [], limit)).slice(0, limit);
  }

  /**
   * Name search.
   *
   * `LIKE ? ESCAPE '\'` with core's `escapeLike`, so a contact called "100%
   * Design" can be searched for literally instead of matching everyone.
   */
  search(query: string, limit: number): IndexContact[] {
    const needle = `%${escapeLike(query)}%`;
    const out: IndexContact[] = [];
    for (const shard of this.shards) {
      const c = shard.caps.recordColumns;
      const fields = ["ZFIRSTNAME", "ZLASTNAME", "ZNICKNAME", "ORGANIZATION", "ZORGANIZATION"]
        .filter((f) => c.has(f))
        .map((f) => `r."${f}" LIKE ? ESCAPE '\\'`);
      if (!fields.length) continue;
      out.push(
        ...this.#contactsFrom(
          shard,
          `(${fields.join(" OR ")})`,
          fields.map(() => needle),
          limit,
        ),
      );
    }
    return out.slice(0, limit);
  }

  byPk(shardLabel: string, recordPk: number): IndexContact | null {
    const shard = this.shards.find((s) => s.label === shardLabel);
    if (!shard) return null;
    return this.#contactsFrom(shard, `r."Z_PK" = ?`, [recordPk], 1)[0] ?? null;
  }

  #childRows(
    shard: Shard,
    table: string,
    caps: Set<string>,
    valueColumns: readonly string[],
    recordPks?: readonly number[],
  ): { recordPk: number; value: string; label: string | null }[] {
    if (!caps.size) return [];
    const valueCol = valueColumns.find((v) => caps.has(v));
    if (!valueCol || !caps.has("ZOWNER")) return [];
    const scope = recordPks?.length
      ? `AND x."ZOWNER" IN (${recordPks.map(() => "?").join(", ")})`
      : "";
    const sql = `
      SELECT x."ZOWNER" AS recordPk,
             x."${valueCol}" AS value,
             ${caps.has("ZLABEL") ? `x."ZLABEL"` : "NULL"} AS label
        FROM "${table}" x
       WHERE x."${valueCol}" IS NOT NULL AND x."${valueCol}" <> '' ${scope}`;
    const rows = shard.db.prepare(sql).all(...((recordPks ?? []) as never[])) as Record<
      string,
      unknown
    >[];
    return rows.flatMap((r) => {
      const value = text(r.value);
      const recordPk = num(r.recordPk);
      if (!value || recordPk === null) return [];
      return [{ recordPk, value, label: text(r.label) }];
    });
  }

  phonesFor(shardLabel: string, recordPks: readonly number[]): ContactPhone[] {
    const shard = this.shards.find((s) => s.label === shardLabel);
    if (!shard) return [];
    return this.#childRows(
      shard,
      "ZABCDPHONENUMBER",
      shard.caps.phoneColumns,
      ["ZFULLNUMBER"],
      recordPks,
    );
  }

  emailsFor(shardLabel: string, recordPks: readonly number[]): ContactEmail[] {
    const shard = this.shards.find((s) => s.label === shardLabel);
    if (!shard) return [];
    return this.#childRows(
      shard,
      "ZABCDEMAILADDRESS",
      shard.caps.emailColumns,
      ["ZADDRESS", "ZADDRESSNORMALIZED"],
      recordPks,
    );
  }

  /**
   * The resolver index: every phone suffix and every email, keyed to a contact.
   *
   * Built in one pass over every shard because a handle does not know which
   * account its owner lives in. A key mapping to more than one DISTINCT contact
   * is kept as such — see `resolve.ts`, which reports ambiguity rather than
   * picking. `docs/contacts.md` measured six such collisions at nine digits, and
   * twenty-eight at four.
   */
  buildLookup(suffixDigits: number = SUFFIX_DIGITS): HandleLookup {
    const byPhone = new Map<string, Set<string>>();
    const byEmail = new Map<string, Set<string>>();
    const contacts = new Map<string, IndexContact>();

    for (const shard of this.shards) {
      const people = this.#contactsFrom(shard, "", [], Number.MAX_SAFE_INTEGER);
      const byPk = new Map(people.map((p) => [p.recordPk, p]));
      for (const p of people) contacts.set(`${shard.label}:${p.recordPk}`, p);

      for (const row of this.#childRows(shard, "ZABCDPHONENUMBER", shard.caps.phoneColumns, [
        "ZFULLNUMBER",
      ])) {
        if (!byPk.has(row.recordPk)) continue;
        remember(byPhone, suffixKey(row.value, suffixDigits), `${shard.label}:${row.recordPk}`);
      }
      for (const row of this.#childRows(shard, "ZABCDEMAILADDRESS", shard.caps.emailColumns, [
        "ZADDRESS",
        "ZADDRESSNORMALIZED",
      ])) {
        if (!byPk.has(row.recordPk)) continue;
        remember(byEmail, emailKey(row.value), `${shard.label}:${row.recordPk}`);
      }
    }

    // The key length travels WITH the index. Indexing at nine and querying at
    // seven would match nothing and look exactly like an empty address book.
    return { byPhone, byEmail, contacts, suffixDigits };
  }

  close(): void {
    for (const s of this.shards) {
      try {
        s.db.close();
      } catch {
        // Closing a database that already failed is not worth reporting.
      }
    }
  }
}

export type HandleLookup = {
  /** Phone suffix → the contacts carrying it. Key length is `suffixDigits`. */
  byPhone: Map<string, Set<string>>;
  /** Case-folded address → the contacts carrying it. */
  byEmail: Map<string, Set<string>>;
  /** `"<shard>:<pk>"` → the contact. */
  contacts: Map<string, IndexContact>;
  /** How the phone keys were built. Queries MUST use the same length. */
  suffixDigits: number;
};

export const introspect = (db: DatabaseSync): StoreCapabilities => {
  const recordColumns = new Set(columnsOf(db, "ZABCDRECORD"));

  for (const t of REQUIRED) {
    if (recordColumns.size === 0) {
      throw new SchemaDriftError(
        `This Contacts store has no ${t} table. It was probed on macOS ${PROBED_MACOS} with ` +
          `schema fingerprint ${PROBED_FINGERPRINT} (a PROBE fingerprint — compare it against ` +
          `another probe run, not against the one diagnostics reports); re-run ` +
          `\`pnpm probe:contacts\` to see what changed.`,
      );
    }
  }

  // By name, never by number. Core Data assigns Z_ENT per model version.
  let contactEntities: number[] = [];
  try {
    const rows = db.prepare(`SELECT Z_ENT AS ent, Z_NAME AS name FROM Z_PRIMARYKEY`).all() as {
      ent: number;
      name: string;
    }[];
    contactEntities = rows.filter((r) => CONTACT_ENTITIES.test(r.name)).map((r) => Number(r.ent));
  } catch {
    // No Z_PRIMARYKEY means no filter. Reported through `contactEntities` being
    // empty rather than guessed at — an unfiltered count is visibly too high,
    // whereas a wrong hardcoded number silently returns the wrong people.
    contactEntities = [];
  }

  const phoneColumns = new Set(columnsOf(db, "ZABCDPHONENUMBER"));
  const emailColumns = new Set(columnsOf(db, "ZABCDEMAILADDRESS"));

  return {
    fingerprint: fingerprintSchema(db),
    recordColumns,
    phoneColumns,
    emailColumns,
    contactEntities,
    hasPhones: phoneColumns.size > 0,
    hasEmails: emailColumns.size > 0,
    hasNotes: columnsOf(db, "ZABCDNOTE").length > 0,
    // Measured as apple-seconds, but taken from core rather than written out
    // again: being 31 years out is the classic Core Data date bug.
    epochOffset: CORE_DATA_EPOCH_OFFSET,
  };
};

/** Count the people in one opened shard, with the entity filter applied. */
export const countContacts = (db: DatabaseSync, caps: StoreCapabilities): number => {
  const where = caps.contactEntities.length
    ? `WHERE "Z_ENT" IN (${caps.contactEntities.join(", ")})`
    : "";
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "ZABCDRECORD" ${where}`).get() as {
      c: number;
    };
    return Number(row.c ?? 0);
  } catch {
    return 0;
  }
};

export const openShard = (
  path: string,
  label: string,
  mode: ReadOnlyMode,
  logger?: Logger,
): Shard | null => {
  try {
    const {
      db,
      mode: used,
      validated,
    } = openReadOnly<StoreCapabilities>(path, mode, {
      label: "Contacts store",
      envVar: "APPLE_CONTACTS_INDEX_MODE",
      validate: introspect,
      fatal: (err) => err instanceof SchemaDriftError,
      onFallback: () =>
        logger?.debug?.(
          "opened a Contacts store with immutable=1, which skips the write-ahead log — " +
            "very recent edits may be missing until Contacts checkpoints.",
        ),
    });
    return { db, mode: used, caps: validated, path, label, contacts: countContacts(db, validated) };
  } catch (err) {
    if (err instanceof SchemaDriftError) throw err;
    // One unreadable shard is not a failed lane. The others still answer, and
    // the union is reported with the shard count so a short answer is visible.
    logger?.debug?.(`skipped Contacts store ${label}: ${String(err)}`);
    return null;
  }
};

export { digitsOf };
