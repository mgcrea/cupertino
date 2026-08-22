import { describe, expect, it } from "vitest";

import {
  decodeChatRef,
  decodeMessageRef,
  encodeChatRef,
  encodeMessageRef,
  InvalidMessageRefError,
} from "../src/client/ref.js";

describe("message refs", () => {
  it("round-trips", () => {
    expect(decodeMessageRef(encodeMessageRef("ABC-123"))).toBe("ABC-123");
  });

  /**
   * Chat guids are not UUIDs. A measured one is `iMessage;-;+15551234567`, which
   * carries semicolons and a phone number — so the tail is greedy and nothing
   * inside it is parsed.
   */
  it("survives a guid full of punctuation", () => {
    const guid = "iMessage;-;+15551234567";
    expect(decodeChatRef(encodeChatRef(guid))).toBe(guid);
  });

  it("keeps message and chat refs apart", () => {
    expect(() => decodeMessageRef(encodeChatRef("x"))).toThrow(InvalidMessageRefError);
    expect(() => decodeChatRef(encodeMessageRef("x"))).toThrow(InvalidMessageRefError);
  });

  /** A ref from the wrong surface gets told which one, not a bare parse error. */
  it("recognises refs belonging to other surfaces", () => {
    expect(() => decodeMessageRef("c1:cal/-/uid")).toThrow(/Calendar/);
    expect(() => decodeMessageRef("r1:123")).toThrow(/Reminders/);
    expect(() => decodeMessageRef("k1:acct/1")).toThrow(/Contacts/);
    expect(() => decodeMessageRef("mc1:abc")).toThrow(/CHAT ref/);
    expect(() => decodeChatRef("m1:abc")).toThrow(/MESSAGE ref/);
  });

  it("rejects empty and malformed refs", () => {
    for (const bad of ["", "m1:", "abc", "1:abc"]) {
      expect(() => decodeMessageRef(bad)).toThrow(InvalidMessageRefError);
    }
  });
});
