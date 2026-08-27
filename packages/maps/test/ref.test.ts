import { describe, expect, it } from "vitest";

import {
  decodeCollectionRef,
  decodePlaceRef,
  encodeCollectionRef,
  encodePlaceRef,
  InvalidMapsRefError,
} from "../src/client/ref.js";

describe("place refs", () => {
  it("round-trips every kind", () => {
    for (const kind of ["favorite", "collection-item", "history"] as const) {
      expect(decodePlaceRef(encodePlaceRef(kind, 42))).toEqual({ kind, id: 42 });
    }
  });

  /*
   * The kind is IN the ref rather than inferred at resolution time. The same
   * café can be a favourite and a collection entry, in different tables with
   * different row ids, so a ref that carried only a number could not say which
   * of the two a caller meant.
   */
  it("keeps the kinds apart", () => {
    expect(encodePlaceRef("favorite", 1)).not.toBe(encodePlaceRef("history", 1));
  });

  it("forgives whitespace around a pasted ref, and nothing inside it", () => {
    expect(decodePlaceRef("  p1:f:7\n")).toEqual({ kind: "favorite", id: 7 });
    expect(() => decodePlaceRef("p1: f:7")).toThrow(InvalidMapsRefError);
  });

  it("rejects a hand-built ref rather than guessing at it", () => {
    for (const bad of ["", "7", "p1:", "p1:f:", "p1:x:7", "p1:f:abc", "p2:f:7"]) {
      expect(() => decodePlaceRef(bad)).toThrow(InvalidMapsRefError);
    }
  });

  /*
   * A ref that decodes under two surfaces is worse than one that decodes under
   * none. The message names the surface it actually belongs to, because the
   * caller is usually a model and one that is told retries correctly.
   */
  it("names the surface a foreign ref came from", () => {
    const cases: [string, string][] = [
      ["c1:x", "Calendar"],
      ["r1:x", "Reminders"],
      ["k1:x", "Contacts"],
      ["n1:x", "Notes"],
      ["m1:x", "Messages"],
      ["mc1:x", "Messages chat"],
      ["s1:https://x", "Safari"],
      ["sb1:x", "Safari bookmark"],
    ];
    for (const [ref, surface] of cases) {
      expect(() => decodePlaceRef(ref)).toThrow(new RegExp(surface));
    }
  });

  it("tells a place ref and a collection ref apart in both directions", () => {
    expect(() => decodePlaceRef("pc1:3")).toThrow(/COLLECTION ref/);
    expect(() => decodeCollectionRef("p1:f:3")).toThrow(/PLACE ref/);
  });
});

describe("collection refs", () => {
  it("round-trips", () => {
    expect(decodeCollectionRef(encodeCollectionRef(9))).toBe(9);
  });

  it("rejects anything that is not a number", () => {
    for (const bad of ["pc1:", "pc1:abc", "pc1:1.5", "3"]) {
      expect(() => decodeCollectionRef(bad)).toThrow(InvalidMapsRefError);
    }
  });
});
