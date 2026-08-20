import { describe, expect, it } from "vitest";

import { PreconditionError } from "../src/client/errors.js";
import { decodeRef, encodeRef, REF_VERSION, uuidOf } from "../src/client/ref.js";

const ID = "x-apple-reminder://5B3F1A6C-2D4E-4A9B-8C1D-7E0F2A3B4C5D";

describe("encodeRef / decodeRef", () => {
  it("round-trips an id", () => {
    expect(decodeRef(encodeRef(ID)).id).toBe(ID);
  });

  it("stamps the version prefix", () => {
    expect(encodeRef(ID)).toBe(`${REF_VERSION}:${ID}`);
  });

  it("extracts the uuid that bridges to the store", () => {
    expect(decodeRef(encodeRef(ID)).uuid).toBe("5B3F1A6C-2D4E-4A9B-8C1D-7E0F2A3B4C5D");
  });

  it("normalises the uuid to upper case for comparison", () => {
    expect(
      decodeRef(`${REF_VERSION}:x-apple-reminder://5b3f1a6c-2d4e-4a9b-8c1d-7e0f2a3b4c5d`).uuid,
    ).toBe("5B3F1A6C-2D4E-4A9B-8C1D-7E0F2A3B4C5D");
  });

  /**
   * The dictionary declares `id` as plain text, so its shape is observed rather
   * than documented. An id that carries no uuid must still resolve over Apple
   * Events — only the index-only fields become unavailable for it.
   */
  it("accepts an id with no uuid, reporting uuid as null", () => {
    const ref = decodeRef(`${REF_VERSION}:some-opaque-caldav-id`);
    expect(ref.id).toBe("some-opaque-caldav-id");
    expect(ref.uuid).toBeNull();
  });

  it("keeps an id containing colons intact", () => {
    const weird = "urn:x:1234";
    expect(decodeRef(encodeRef(weird)).id).toBe(weird);
  });
});

describe("decodeRef — rejection", () => {
  it("rejects a ref with no version prefix", () => {
    expect(() => decodeRef(ID)).toThrow(PreconditionError);
  });

  it("rejects a ref from another surface", () => {
    expect(() => decodeRef("n1:x-coredata://store/ICNote/p1")).toThrow(/Unknown reminder ref/);
  });

  it.each([["" as string], ["   "], [":"], ["r1:"]])("rejects %o", (raw) => {
    expect(() => decodeRef(raw)).toThrow(PreconditionError);
  });

  /** The message has to tell a model what to do instead, not just say no. */
  it("points at the tools that issue refs", () => {
    expect(() => decodeRef("nonsense")).toThrow(/search and list tools/);
  });
});

describe("uuidOf", () => {
  it("finds a uuid anywhere in the id", () => {
    expect(uuidOf(ID)).toBe("5B3F1A6C-2D4E-4A9B-8C1D-7E0F2A3B4C5D");
  });

  it("returns null when there is none", () => {
    expect(uuidOf("plain")).toBeNull();
  });
});
