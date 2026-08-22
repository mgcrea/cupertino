import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { locateStores, STORE_FILENAME } from "../src/client/locate.js";

const home = (build: (dir: string) => void): string => {
  const root = mkdtempSync(join(tmpdir(), "contacts-locate-"));
  build(root);
  return root;
};

const addressBook = (root: string): string =>
  join(root, "Library", "Application Support", "AddressBook");

const put = (path: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
};

describe("locateStores", () => {
  /**
   * The finding this whole file exists for. `docs/contacts.md`: the root store
   * held ONE contact and the account source held 420. A locator that returns
   * "the" store returns a database that is present, readable, correctly shaped
   * and empty — which fails no check and answers nothing.
   */
  it("finds the account sources, not just the obvious file", () => {
    const root = home((r) => {
      const ab = addressBook(r);
      put(join(ab, STORE_FILENAME));
      put(join(ab, "Sources", "1F2E3D4C-5B6A-7988-9A0B-1C2D3E4F5A6B", STORE_FILENAME));
      put(join(ab, "Sources", "9A8B7C6D-5E4F-3021-8899-AABBCCDDEEFF", STORE_FILENAME));
    });
    const found = locateStores({ home: root });
    expect(found.candidates).toHaveLength(3);
    expect(found.sourceCount).toBe(2);
    expect(found.candidates[0]?.label).toBe("root");
    expect(found.readable).toHaveLength(3);
    expect(found.reason).toBeNull();
  });

  it("labels each source by its directory so refs stay distinct", () => {
    const root = home((r) => {
      put(join(addressBook(r), "Sources", "acct-a", STORE_FILENAME));
      put(join(addressBook(r), "Sources", "acct-b", STORE_FILENAME));
    });
    expect(
      locateStores({ home: root })
        .candidates.map((c) => c.label)
        .toSorted(),
    ).toEqual(["acct-a", "acct-b"]);
  });

  it("reports a reason rather than an empty list when nothing is there", () => {
    const found = locateStores({ home: home(() => {}) });
    expect(found.candidates).toHaveLength(0);
    expect(found.reason).toMatch(/could not be listed|Has Contacts ever been set up/);
  });

  /**
   * The hint must name the Contacts pane, not Full Disk Access. Contacts sits
   * behind its own TCC service and, unlike Full Disk Access, macOS PROMPTS for
   * it — so the likely fix is a dismissed dialog, and asking for whole-disk
   * access would be asking for far more than this server needs.
   */
  it("points at the Contacts permission, never at Full Disk Access", () => {
    const found = locateStores({ storePath: "/nope/missing.abcddb" });
    expect(found.reason).toMatch(/points at nothing/);
    const denied = locateStores({ home: home(() => {}) });
    expect(denied.reason).toMatch(/Privacy & Security > Contacts/);
    // It names Full Disk Access only to rule it out. What it must never do is
    // send someone to that pane — this server needs an address book, not a disk.
    expect(denied.reason).toMatch(/not by Full Disk Access/);
    expect(denied.reason).not.toMatch(/Privacy & Security > Full Disk Access/);
  });

  it("treats an explicit path as a bypass with no union", () => {
    const root = home((r) => {
      put(join(addressBook(r), "Sources", "acct-a", STORE_FILENAME));
    });
    const explicit = join(addressBook(root), "Sources", "acct-a", STORE_FILENAME);
    const found = locateStores({ storePath: explicit });
    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]?.label).toBe("explicit");
  });
});
