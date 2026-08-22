import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SchemaDriftError } from "../src/client/errors.js";
import {
  ContactsIndex,
  countContacts,
  displayNameOf,
  introspect,
  type Shard,
} from "../src/client/store.js";

/**
 * Built from the DDL a real store handed `pnpm probe:contacts --write`.
 *
 * Schema only, never a row — which is what lets this suite run on a machine with
 * no Contacts permission and nobody's real address book in it. Every row below
 * is synthetic and written here.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "contacts-store.sql");

const ENT = { contact: 22, group: 19, info: 24, container: 25 } as const;

const db = (mutate?: (d: DatabaseSync) => void): DatabaseSync => {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(FIXTURE, "utf8"));
  // The entity map, as Core Data writes it. Names are what the code matches on.
  d.exec(`
    INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES
      (${ENT.group}, 'ABCDGroup', 18, 0),
      (${ENT.info}, 'ABCDInfo', 17, 0),
      (${ENT.contact}, 'ABCDContact', 17, 0),
      (23, 'ABCDSubscribedContact', 22, 0),
      (${ENT.container}, 'CNCDContainer', 17, 0)`);
  mutate?.(d);
  return d;
};

const addContact = (
  d: DatabaseSync,
  pk: number,
  first: string | null,
  last: string | null,
  extra: { org?: string; ent?: number; linkId?: number } = {},
): void => {
  d.prepare(
    `INSERT INTO ZABCDRECORD (Z_PK, Z_ENT, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION, ZLINKID, ZUNIQUEID)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pk,
    extra.ent ?? ENT.contact,
    first,
    last,
    extra.org ?? null,
    extra.linkId ?? null,
    `uid-${pk}`,
  );
};

const addPhone = (d: DatabaseSync, pk: number, owner: number, value: string): void => {
  d.prepare(
    `INSERT INTO ZABCDPHONENUMBER (Z_PK, Z_ENT, ZOWNER, ZFULLNUMBER, ZLABEL) VALUES (?, 15, ?, ?, '_$!<Mobile>!$_')`,
  ).run(pk, owner, value);
};

const shardOf = (d: DatabaseSync, label = "acct"): Shard => {
  const caps = introspect(d);
  return {
    db: d,
    mode: "ro",
    caps,
    path: `:memory:${label}`,
    label,
    contacts: countContacts(d, caps),
  };
};

describe("introspect", () => {
  it("reads the tables the resolver joins", () => {
    const caps = introspect(db());
    expect(caps.hasPhones).toBe(true);
    expect(caps.hasEmails).toBe(true);
    expect(caps.phoneColumns.has("ZFULLNUMBER")).toBe(true);
    expect(caps.phoneColumns.has("ZOWNER")).toBe(true);
    expect(caps.emailColumns.has("ZADDRESS")).toBe(true);
  });

  /**
   * Resolved by NAME through Z_PRIMARYKEY, never hardcoded — Core Data assigns
   * Z_ENT per model version, so today's 22 is not a constant.
   */
  it("finds the contact entities by name, including the subscribed subclass", () => {
    expect(introspect(db()).contactEntities.toSorted()).toEqual([22, 23]);
  });

  it("degrades to no filter rather than guessing when Z_PRIMARYKEY is gone", () => {
    const caps = introspect(db((d) => d.exec(`DROP TABLE Z_PRIMARYKEY`)));
    // An unfiltered count is visibly too high; a wrong hardcoded number would
    // silently return the wrong people.
    expect(caps.contactEntities).toEqual([]);
  });

  it("raises SchemaDriftError when the record table is gone", () => {
    expect(() => introspect(db((d) => d.exec(`DROP TABLE ZABCDRECORD`)))).toThrow(SchemaDriftError);
  });
});

describe("countContacts", () => {
  /**
   * THE BUG THIS PINS. ZABCDRECORD is a Core Data single-table inheritance root:
   * groups, containers and an info row live in it beside people. The probed
   * machine had 425 rows for 420 contacts, which read as four spare duplicates
   * until the entities were separated.
   */
  it("counts people, not rows — groups and containers are not contacts", () => {
    const d = db((x) => {
      addContact(x, 1, "Alice", "Adams");
      addContact(x, 2, "Bob", "Brown");
      addContact(x, 3, null, null, { ent: ENT.group });
      addContact(x, 4, null, null, { ent: ENT.info });
      addContact(x, 5, null, null, { ent: ENT.container });
    });
    const caps = introspect(d);
    expect(d.prepare(`SELECT COUNT(*) AS c FROM ZABCDRECORD`).get()).toEqual({ c: 5 });
    expect(countContacts(d, caps)).toBe(2);
  });
});

describe("ContactsIndex", () => {
  it("lists only contacts, and never a group", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => {
          addContact(x, 1, "Alice", "Adams");
          addContact(x, 2, null, null, { ent: ENT.group, org: "Family" });
        }),
      ),
    ]);
    expect(index.list(50).map((c) => c.displayName)).toEqual(["Alice Adams"]);
  });

  /**
   * The store is plural — that is the whole shape of this surface. A rowid is
   * unique only within one database, so both shards below number their people
   * from 1 and the union must keep them apart.
   */
  it("unions several stores and keeps colliding rowids distinct", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => addContact(x, 1, "Alice", "Adams")),
        "icloud",
      ),
      shardOf(
        db((x) => addContact(x, 1, "Bob", "Brown")),
        "google",
      ),
    ]);
    expect(index.totalContacts).toBe(2);
    const names = index.list(50).map((c) => `${c.source}:${c.recordPk}=${c.displayName}`);
    expect(names.toSorted()).toEqual(["google:1=Bob Brown", "icloud:1=Alice Adams"]);
  });

  it("searches names and organisations", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => {
          addContact(x, 1, "Alice", "Adams");
          addContact(x, 2, null, null, { org: "Acme Garage" });
        }),
      ),
    ]);
    expect(index.search("acme", 10).map((c) => c.displayName)).toEqual(["Acme Garage"]);
  });

  /** `escapeLike`, so a literal wildcard searches for itself. */
  it("does not let a percent sign match everyone", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => {
          addContact(x, 1, null, null, { org: "100% Design" });
          addContact(x, 2, "Bob", "Brown");
        }),
      ),
    ]);
    expect(index.search("100%", 10).map((c) => c.displayName)).toEqual(["100% Design"]);
  });

  it("builds a lookup keyed on the nine-digit suffix", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => {
          addContact(x, 1, "Alice", "Adams");
          // As typed, which is how 222 of 400 sampled numbers are stored.
          addPhone(x, 1, 1, "06 12 34 56 78");
        }),
      ),
    ]);
    const lookup = index.buildLookup();
    expect(lookup.suffixDigits).toBe(9);
    expect([...(lookup.byPhone.get("612345678") ?? [])]).toHaveLength(1);
  });

  /**
   * A phone row owned by a GROUP must not enter the lookup, or a resolve would
   * name a mailing list as the sender.
   */
  it("keeps a non-contact's phone number out of the lookup", () => {
    const index = new ContactsIndex([
      shardOf(
        db((x) => {
          addContact(x, 1, null, null, { ent: ENT.group, org: "Family" });
          addPhone(x, 1, 1, "+33612345678");
        }),
      ),
    ]);
    expect(index.buildLookup().byPhone.size).toBe(0);
  });
});

describe("displayNameOf", () => {
  it("falls through to nickname, then organisation, then a marker", () => {
    expect(
      displayNameOf({ firstName: "Alice", lastName: "Adams", nickname: null, organization: null }),
    ).toBe("Alice Adams");
    expect(
      displayNameOf({ firstName: "Alice", lastName: null, nickname: null, organization: null }),
    ).toBe("Alice");
    expect(
      displayNameOf({ firstName: null, lastName: null, nickname: "Ali", organization: "Acme" }),
    ).toBe("Ali");
    // A garage or a doctor's office is a real contact with no person name.
    expect(
      displayNameOf({ firstName: null, lastName: null, nickname: null, organization: "Acme" }),
    ).toBe("Acme");
    // Never an empty string, which would render as a blank sender.
    expect(
      displayNameOf({ firstName: null, lastName: null, nickname: null, organization: null }),
    ).toBe("(no name)");
  });
});
