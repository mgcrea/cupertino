import { describe, expect, it } from "vitest";

import { PreconditionError } from "../src/client/errors.js";
import { decodeRef, encodeRef, refFromPrimaryKey, REF_VERSION } from "../src/client/ref.js";

const ID = "x-coredata://B1FD1F1B-0000-0000-0000-000000000000/ICNote/p921";

describe("note refs", () => {
  it("round-trips", () => {
    expect(decodeRef(encodeRef(ID))).toEqual({ id: ID, primaryKey: 921 });
  });

  it("builds a ref from an index row without asking Notes", () => {
    expect(refFromPrimaryKey("STORE-UUID", 42)).toBe(
      `${REF_VERSION}:x-coredata://STORE-UUID/ICNote/p42`,
    );
  });

  it.each([
    ["not-a-ref", "no version prefix"],
    ["n1:nonsense", "not a core data id"],
    ["n1:x-coredata://store/ICFolder/p1", "wrong entity"],
    ["zz:" + ID, "unknown version"],
  ])("rejects %s", (raw) => {
    expect(() => decodeRef(raw)).toThrow(PreconditionError);
  });

  it("explains where refs come from rather than just failing", () => {
    expect(() => decodeRef("garbage")).toThrow(/search and list tools/);
  });
});
