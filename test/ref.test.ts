import { describe, expect, it } from "vitest";

import { PreconditionError } from "../src/client/errors.js";
import { decodeRef, encodeRef, groupRefsByMailbox, REF_VERSION } from "../src/client/ref.js";

const UUID = "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99";

describe("message refs", () => {
  it.each([
    ["INBOX"],
    ["Sent Messages"],
    ["[Gmail]/All Mail"],
    ["Deep/Nested/Folder"],
    ["Boîte de réception"],
    ['weird "quoted" name'],
    ["has#hash"],
  ])("round-trips mailbox %s", (mailbox) => {
    const ref = { accountUuid: UUID, mailbox, id: 198_577 };
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
  });

  it("carries the version prefix", () => {
    expect(encodeRef({ accountUuid: UUID, mailbox: "INBOX", id: 1 })).toMatch(
      new RegExp(`^${REF_VERSION}:`),
    );
  });

  it.each([
    ["", "empty"],
    ["198577", "a bare id"],
    ["m1:INBOX#1", "no account"],
    [`m1:${UUID}/INBOX`, "no id"],
    [`m1:${UUID}/INBOX#0`, "a zero id"],
    [`m1:${UUID}/INBOX#abc`, "a non-numeric id"],
    [`m9:${UUID}/INBOX#1`, "an unknown version"],
  ])("rejects %s (%s)", (raw) => {
    expect(() => decodeRef(raw)).toThrow(PreconditionError);
  });

  it("explains where refs come from rather than just failing", () => {
    expect(() => decodeRef("198577")).toThrow(/search and list tools/);
  });

  it("groups by mailbox so a batch costs one round-trip per mailbox", () => {
    const groups = groupRefsByMailbox([
      { accountUuid: UUID, mailbox: "INBOX", id: 1 },
      { accountUuid: UUID, mailbox: "INBOX", id: 2 },
      { accountUuid: UUID, mailbox: "Archive", id: 3 },
      { accountUuid: "OTHER", mailbox: "INBOX", id: 4 },
    ]);
    expect(groups.size).toBe(3);
    expect(groups.get(`${UUID}/INBOX`)?.map((r) => r.id)).toEqual([1, 2]);
  });
});
