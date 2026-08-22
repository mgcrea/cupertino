import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

/**
 * `k1:<account>/<recordPk>` — an opaque handle for one contact.
 *
 * ## Why the account rides along
 *
 * Because the store is plural. A record's `Z_PK` is a rowid, and rowids are only
 * unique WITHIN one database — the root store and each account store number
 * their rows from 1 independently. A bare pk would therefore resolve to a
 * different person depending on which store happened to be read first, which is
 * the kind of bug that produces a plausible wrong answer rather than an error.
 *
 * ## Why not `ZUNIQUEID`
 *
 * It exists and is stable, but it is not what the child tables join on —
 * `ZABCDPHONENUMBER.ZOWNER` points at `Z_PK`. Carrying the pk means a `get`
 * needs no extra lookup, and the account prefix supplies the uniqueness the pk
 * lacks. `uniqueId` is still returned on results for callers that want a
 * durable identity across a re-index.
 *
 * ## Why `k1`
 *
 * `c1:` is Calendar's and `r1:` is Reminders'; `k1` is free and the version
 * prefix keeps a future scheme change additive rather than a silent
 * reinterpretation of refs already sitting in a conversation.
 */

export const REF_VERSION = "k1";

export type ContactRef = { source: string; recordPk: number };

/**
 * An account label can contain almost anything — it is a directory name, and on
 * the probed machine a UUID — so the pk is anchored as the tail and the label is
 * whatever precedes the last `/`. Splitting on the FIRST separator would break
 * on any label containing one.
 */
const REF_PATTERN = /^k1:(.+)\/(\d+)$/;

export class InvalidContactRefError extends AppleAutomationError {
  override readonly name = "InvalidContactRefError";

  constructor(raw: string) {
    super(
      `"${raw}" is not a contact ref. Refs come from apple_contacts_search_contacts or ` +
        `apple_contacts_list_contacts and look like "k1:<account>/<id>" — they are opaque and ` +
        `must not be constructed by hand.` +
        (raw.startsWith("c1:") || raw.startsWith("r1:")
          ? ` That one belongs to another surface: "c1:" refs are Calendar events and "r1:" refs ` +
            `are Reminders.`
          : ""),
      { ref: raw },
    );
  }
}

export const encodeRef = (source: string, recordPk: number): string =>
  `${REF_VERSION}:${source}/${recordPk}`;

export const decodeRef = (raw: string): ContactRef => {
  const m = REF_PATTERN.exec(raw.trim());
  if (!m) throw new InvalidContactRefError(raw);
  const recordPk = Number(m[2]);
  if (!Number.isSafeInteger(recordPk) || recordPk <= 0) throw new InvalidContactRefError(raw);
  return { source: m[1]!, recordPk };
};
