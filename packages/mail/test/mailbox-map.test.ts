import { describe, expect, it, vi } from "vitest";

import { MailboxMap, type MailAccount } from "../src/client/mailbox-map.js";
import type { OsascriptRunner } from "../src/client/osascript.js";

/**
 * The account list, cached so that a call does not wait on Mail for it.
 *
 * LIST_ACCOUNTS measured ~1 s on a live Mail with four accounts. With a plain
 * 60 s TTL that second came back on the first call after every pause of a
 * minute, which in agent use is most calls. An expired list is now served at
 * once and refreshed behind the call; only a list nobody has yet, or one a
 * caller explicitly invalidated, is waited for.
 */

const account = (name: string, mailboxes = ["INBOX"]): MailAccount => ({
  id: `${name}-uuid`,
  name,
  enabled: true,
  accountType: "imap",
  emailAddresses: [],
  fullName: null,
  directory: null,
  messageCaching: null,
  mailboxes,
});

/** A runner whose every answer is released by hand, so ordering is visible. */
const deferredRunner = () => {
  const pending: { resolve: (v: MailAccount[]) => void; reject: (e: Error) => void }[] = [];
  const runner: OsascriptRunner = {
    run: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve: resolve as (v: MailAccount[]) => void, reject });
        }),
    ) as OsascriptRunner["run"],
  };
  const answer = (accounts: MailAccount[]) => pending.shift()?.resolve(accounts);
  const fail = (message: string) => pending.shift()?.reject(new Error(message));
  return {
    runner,
    answer,
    fail,
    calls: () => (runner.run as ReturnType<typeof vi.fn>).mock.calls.length,
  };
};

const setup = () => {
  let now = 0;
  const mail = deferredRunner();
  const map = new MailboxMap({ runner: mail.runner, allowlist: [], ttlMs: 60_000, now: () => now });
  const advance = (ms: number) => {
    now += ms;
  };
  /** Prime the cache with a first list, which nothing could have served sooner. */
  const prime = async (accounts: MailAccount[]) => {
    const first = map.accounts();
    mail.answer(accounts);
    await first;
  };
  return { map, mail, advance, prime };
};

const names = (accounts: MailAccount[]) => accounts.map((a) => a.name);

describe("the account cache", () => {
  it("waits for the first list, since there is nothing to serve yet", async () => {
    const { map, mail } = setup();
    const first = map.accounts();
    expect(mail.calls()).toBe(1);
    mail.answer([account("iCloud")]);
    expect(names(await first)).toEqual(["iCloud"]);
  });

  it("serves an expired list at once and refreshes it behind the call", async () => {
    const { map, mail, advance, prime } = setup();
    await prime([account("iCloud")]);
    advance(61_000);

    // Resolves without the runner answering: the stale list came back.
    expect(names(await map.accounts())).toEqual(["iCloud"]);
    expect(mail.calls()).toBe(2);

    mail.answer([account("iCloud"), account("Google")]);
    await vi.waitFor(async () => expect(names(await map.accounts())).toEqual(["iCloud", "Google"]));
    expect(mail.calls()).toBe(2);
  });

  it("starts one refresh however many calls find the list expired", async () => {
    const { map, mail, advance, prime } = setup();
    await prime([account("iCloud")]);
    advance(61_000);

    await Promise.all([map.accounts(), map.accounts(), map.accounts()]);
    expect(mail.calls()).toBe(2);
  });

  it("keeps the stale list when the refresh fails, and tries again on a later call", async () => {
    const { map, mail, advance, prime } = setup();
    await prime([account("iCloud")]);
    advance(61_000);

    await map.accounts();
    mail.fail("Mail got an error: AppleEvent timed out. (-1712)");
    // Let the rejection settle: until it has, the failed read is still the
    // one in flight, and a call would rightly share it.
    await new Promise((r) => setTimeout(r, 0));

    expect(names(await map.accounts())).toEqual(["iCloud"]);
    expect(mail.calls()).toBe(3);
  });

  it("waits for a fresh list when one is forced", async () => {
    const { map, mail, prime } = setup();
    await prime([account("iCloud")]);

    const forced = map.accounts(true);
    mail.answer([account("Google")]);
    expect(names(await forced)).toEqual(["Google"]);
  });

  /*
   * invalidate() is what a write calls after it changes the list — creating a
   * mailbox. The caller after it must see the change, not the list before it.
   */
  it("waits after an invalidate, rather than serving what it invalidated", async () => {
    const { map, mail, prime } = setup();
    await prime([account("iCloud")]);
    map.invalidate();

    const next = map.accounts();
    mail.answer([account("iCloud", ["INBOX", "Projects"])]);
    expect((await next)[0]?.mailboxes).toEqual(["INBOX", "Projects"]);
  });

  /*
   * The cost of serving a stale list is an account added since. An unknown
   * name earns one fresh read before it is refused.
   */
  it("reads the list again before refusing an account it does not know", async () => {
    const { map, mail, prime } = setup();
    await prime([account("iCloud")]);

    const resolved = map.resolveAccount("Google");
    await vi.waitFor(() => expect(mail.calls()).toBe(2));
    mail.answer([account("iCloud"), account("Google")]);
    expect((await resolved).name).toBe("Google");
  });

  it("still refuses an account the fresh list does not have either", async () => {
    const { map, mail, prime } = setup();
    await prime([account("iCloud")]);

    const resolved = map.resolveAccount("Nope");
    await vi.waitFor(() => expect(mail.calls()).toBe(2));
    mail.answer([account("iCloud")]);
    await expect(resolved).rejects.toThrow(/No account "Nope"/);
  });
});
