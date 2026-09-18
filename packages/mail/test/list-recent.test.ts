import { describe, expect, it } from "vitest";

import { LIST_RECENT } from "../src/client/jxa/read.js";

/**
 * Listing a mailbox, run for real against a fake Mail.
 *
 * Written after the script shipped for months unable to list a mailbox holding
 * fewer messages than the caller's limit — every row came back with a null
 * subject, null sender and a `#null` ref, which no other tool could then take.
 *
 * **The bug was invisible because the stubs were kinder than Mail.** The batched
 * read goes through `slice(from, to)` on an Apple Events specifier, which is
 * INCLUSIVE of `to` and RAISES on an index past the end, where
 * `Array.prototype.slice` is exclusive and quietly returns short. A stub written
 * in the JavaScript meaning answers happily for exactly the range a real Mail
 * refuses. So the stub below raises, and every test here is really a test of
 * that one difference.
 */

type Message = { id: number; subject: string; sender: string; when: string };

const MESSAGES: Message[] = [
  { id: 300, subject: "Third", sender: "c@example.com", when: "2026-09-18T10:00:00Z" },
  { id: 200, subject: "Second", sender: "b@example.com", when: "2026-09-17T10:00:00Z" },
  { id: 100, subject: "First", sender: "a@example.com", when: "2026-09-16T10:00:00Z" },
];

const runScript = (params: Record<string, unknown>, messages: Message[] = MESSAGES) => {
  const state = { ranges: [] as [number, number][] };

  const mailbox = {
    name: () => "Drafts",
    messages: Object.assign(
      {
        /*
         * Apple Events range semantics, not JavaScript's. See the note above:
         * inclusive of `to`, and "Invalid index." for anything past the end.
         * Measured against a live Mail on macOS 27.0 — `jxa/read.ts` carries the
         * readings.
         */
        slice: (from: number, to: number) => {
          state.ranges.push([from, to]);
          if (to >= messages.length || from < 0) throw new Error("Invalid index.");
          const window = messages.slice(from, to + 1);
          return {
            subject: () => window.map((m) => m.subject),
            sender: () => window.map((m) => m.sender),
            dateReceived: () => window.map((m) => new Date(m.when)),
            readStatus: () => window.map(() => false),
            flaggedStatus: () => window.map(() => false),
            id: () => window.map((m) => m.id),
          };
        },
      },
      { length: messages.length },
    ),
  };

  const account = { id: () => "UUID", name: () => "Rgis", mailboxes: () => [mailbox] };
  const mail = { accounts: () => [account] };
  const Application = (name: string) => (name === "Mail" ? mail : { processes: {} });
  const ObjC = { import: () => undefined };
  const dollar: any = (() => undefined) as any;
  dollar.NSRunningApplication = { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) };
  dollar.NSThread = { sleepForTimeInterval: () => undefined };

  const factory = new Function("ObjC", "Application", "$", `${LIST_RECENT}\nreturn run;`);
  const run = factory(ObjC, Application, dollar) as (argv: string[]) => string;
  const envelope = JSON.parse(
    run([JSON.stringify({ accountUuid: "UUID", mailbox: "Drafts", limit: 20, ...params })]),
  );
  return { envelope, state };
};

describe("listing a mailbox", () => {
  /*
   * The case that was broken, and the one that matters most in practice: a
   * mailbox with fewer messages in it than the limit asks for. Drafts is almost
   * always one, which is why an agent that had just written a reply could not
   * find the draft again to revise it.
   */
  it("lists a mailbox holding fewer messages than the limit", () => {
    const { envelope } = runScript({ limit: 20 });
    expect(envelope.ok).toBe(true);
    expect(envelope.data.total).toBe(3);
    expect(envelope.data.messages).toHaveLength(3);
    expect(envelope.data.messages.map((m: { subject: string }) => m.subject)).toEqual([
      "Third",
      "Second",
      "First",
    ]);
  });

  /*
   * The id is not one field among several. Every other tool addresses a message
   * through the ref built from it, so a null id is a row nothing can act on —
   * which is what the whole mailbox came back as.
   */
  it("carries a real id on every row, because the ref is built from it", () => {
    const { envelope } = runScript({ limit: 20 });
    expect(envelope.data.messages.map((m: { id: number }) => m.id)).toEqual([300, 200, 100]);
  });

  /* The exact boundary: limit equal to the message count. */
  it("lists a mailbox whose message count is exactly the limit", () => {
    const { envelope } = runScript({ limit: 3 });
    expect(envelope.data.messages).toHaveLength(3);
    expect(envelope.data.messages[0].subject).toBe("Third");
  });

  it("lists a mailbox holding one message", () => {
    const { envelope } = runScript({ limit: 20 }, [MESSAGES[0] as Message]);
    expect(envelope.data.total).toBe(1);
    expect(envelope.data.messages).toHaveLength(1);
    expect(envelope.data.messages[0].subject).toBe("Third");
  });

  /* Below the end, the range is honoured and nothing extra is emitted. */
  it("returns exactly the limit when the mailbox holds more", () => {
    const { envelope, state } = runScript({ limit: 2 });
    expect(envelope.data.total).toBe(3);
    expect(envelope.data.messages).toHaveLength(2);
    expect(envelope.data.messages.map((m: { subject: string }) => m.subject)).toEqual([
      "Third",
      "Second",
    ]);
    // Inclusive: two messages are asked for as the range 0 thru 1.
    expect(state.ranges).toEqual([[0, 1]]);
  });

  it("answers an empty mailbox without asking Mail for a range at all", () => {
    const { envelope, state } = runScript({ limit: 20 }, []);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.messages).toEqual([]);
    expect(state.ranges).toEqual([]);
  });
});
