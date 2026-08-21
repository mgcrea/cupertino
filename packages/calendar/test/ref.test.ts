import { describe, expect, it } from "vitest";

import { PreconditionError } from "../src/client/errors.js";
import { decodeRef, encodeRef, seriesRefOf, uuidOf } from "../src/client/ref.js";

const CAL = "8A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";
const EVENT = "1F2E3D4C-5B6A-7988-A7B6-C5D4E3F21100";

describe("encodeRef / decodeRef", () => {
  it("round-trips a plain event", () => {
    const got = decodeRef(encodeRef(CAL, EVENT));
    expect(got.calendarUid).toBe(CAL);
    expect(got.eventUid).toBe(EVENT);
    expect(got.occurrenceStart).toBeNull();
    expect(got.isOccurrence).toBe(false);
  });

  it("round-trips one occurrence to the second", () => {
    const when = new Date(2026, 7, 21, 9, 0, 0);
    const got = decodeRef(encodeRef(CAL, EVENT, when));
    expect(got.isOccurrence).toBe(true);
    expect(got.occurrenceStart?.getTime()).toBe(when.getTime());
  });

  it("points an occurrence back at its series", () => {
    const ref = decodeRef(encodeRef(CAL, EVENT, new Date(2026, 7, 21, 9, 0, 0)));
    expect(seriesRefOf(ref)).toBe(encodeRef(CAL, EVENT));
  });

  /**
   * THE PORTABILITY CASE. docs/calendar.md measured the id bridge on iCloud,
   * where every uid is a bare UUID — but that is a property of the account, not
   * of Calendar. Requiring a UUID would work on the machine this was written on
   * and fail on anyone syncing Google or Exchange.
   */
  it.each([
    ["Google", "abc123def456@google.com"],
    ["Exchange", "040000008200E00074C5B7101A82E00800000000B0F5D6"],
    ["CalDAV path-ish", "20260821T090000-1234@fastmail.com"],
    ["bare word", "event-1"],
  ])("carries a %s uid through verbatim", (_kind, uid) => {
    expect(decodeRef(encodeRef(CAL, uid)).eventUid).toBe(uid);
  });

  /** `@` is unusable as a separator precisely because of the Google case above. */
  it("does not treat @ as a field separator", () => {
    const uid = "abc@google.com";
    const ref = decodeRef(encodeRef(CAL, uid, new Date(2026, 7, 21, 9, 0, 0)));
    expect(ref.eventUid).toBe(uid);
    expect(ref.isOccurrence).toBe(true);
  });

  it("keeps a uid containing a separator character intact as the greedy tail", () => {
    const uid = "weird/uid/with/slashes";
    expect(decodeRef(encodeRef(CAL, uid)).eventUid).toBe(uid);
  });
});

describe("decodeRef rejections", () => {
  it("tells a caller when the ref belongs to another surface", () => {
    // A different mistake from inventing a string, and worth its own message:
    // the caller has a real ref, just not for this server.
    expect(() => decodeRef(`r1:x-apple-reminder://${EVENT}`)).toThrow(/another surface/);
  });

  it.each([["nonsense"], [""], ["c1:only-one/part"], ["c1:cal/-/"]])("refuses %s", (raw) => {
    expect(() => decodeRef(raw)).toThrow(PreconditionError);
  });

  it("refuses an occurrence stamp that is not one", () => {
    expect(() => decodeRef(`c1:${CAL}/not-a-date/${EVENT}`)).toThrow(/occurrence start/);
  });
});

describe("uuidOf", () => {
  it("finds a uuid when there is one", () => {
    expect(uuidOf(`x-apple-eventkit://${EVENT}`)).toBe(EVENT.toUpperCase());
  });

  /** Null is a legitimate value: the event is still addressable, just not joinable. */
  it("returns null rather than throwing when there is not", () => {
    expect(uuidOf("abc@google.com")).toBeNull();
  });
});
