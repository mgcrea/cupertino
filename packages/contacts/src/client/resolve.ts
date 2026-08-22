import { emailKey, handleKind, suffixKey, type HandleKind } from "./phone.js";
import type { HandleLookup, IndexContact } from "./store.js";

/**
 * Turn Messages handles into names.
 *
 * This is the function `packages/messages` exists to call, and the reason
 * Contacts was probed at all: `chat.db` records a correspondent as
 * `+15551234567` and nothing else, so a Messages server without this answers
 * "+15551234567 said …", which is complete and useless.
 *
 * ## What the measurement says it must do
 *
 * `docs/contacts.md` measured resolution against a real 958-handle store two
 * ways, and the gap between them is the whole design:
 *
 * | denominator                | resolved |
 * | -------------------------- | -------- |
 * | every handle ever seen     | 27.6%    |
 * | messages in the last year  | 97.6%    |
 * | the 25 busiest correspondents | 84%   |
 *
 * The first number is a fact about the address book — 321 handles sent exactly
 * one message, ever — not about this resolver. The last one is the one that
 * shapes the API: **about one in six of the busiest correspondents does not
 * resolve.** So `unknown` is a normal, expected, first-class outcome. It is not
 * an error, it must not throw, and a caller that treats it as a failure will be
 * wrong several times on any real inbox.
 */

export type ResolutionStatus =
  /** Exactly one contact carries this handle. */
  | "resolved"
  /** Nobody does. Normal — see above. */
  | "unknown"
  /**
   * More than one distinct contact does.
   *
   * Reported rather than resolved by picking a winner. Six handles collided at
   * nine digits on the probed store, and the failure mode of guessing is putting
   * one person's name on another person's messages — which is worse than no name
   * at all, because it is not visibly wrong.
   */
  | "ambiguous"
  /** A shortcode: a bank, a courier, a 2FA sender. Can never be a contact. */
  | "shortcode";

export type ResolvedHandle = {
  handle: string;
  kind: HandleKind;
  status: ResolutionStatus;
  /** The name to show. Null unless `status` is `resolved`. */
  name: string | null;
  contact: IndexContact | null;
  /** How many distinct contacts matched. 0, 1, or more. */
  matches: number;
};

/**
 * Distinct PEOPLE, not distinct rows.
 *
 * A contact with the same number stored twice (mobile and iPhone, which Contacts
 * does routinely) would otherwise read as ambiguous. Linked records across two
 * accounts are collapsed on `ZLINKID` for the same reason: Contacts shows one
 * unified card for them, and reporting two names for one person would contradict
 * what the user sees in the app.
 */
const distinctPeople = (ids: Iterable<string>, lookup: HandleLookup): IndexContact[] => {
  const seen = new Map<string, IndexContact>();
  for (const id of ids) {
    const contact = lookup.contacts.get(id);
    if (!contact) continue;
    // Prefer the link id so cross-account duplicates fold together; fall back to
    // the record's own identity when it carries no link.
    const key = contact.linkId === null ? `pk:${id}` : `link:${contact.linkId}`;
    if (!seen.has(key)) seen.set(key, contact);
  }
  return [...seen.values()];
};

export const resolveHandle = (handle: string, lookup: HandleLookup): ResolvedHandle => {
  const kind = handleKind(handle);
  const base = { handle, kind, name: null, contact: null, matches: 0 } as const;

  if (kind === "shortcode") return { ...base, status: "shortcode" };

  const ids =
    kind === "email"
      ? lookup.byEmail.get(emailKey(handle))
      : (() => {
          const key = suffixKey(handle, lookup.suffixDigits);
          return key === null ? undefined : lookup.byPhone.get(key);
        })();

  if (!ids?.size) return { ...base, status: "unknown" };

  const people = distinctPeople(ids, lookup);
  if (people.length === 1) {
    const contact = people[0]!;
    return { handle, kind, status: "resolved", name: contact.displayName, contact, matches: 1 };
  }
  if (people.length === 0) return { ...base, status: "unknown" };
  return { ...base, status: "ambiguous", matches: people.length };
};

export const resolveHandles = (
  handles: readonly string[],
  lookup: HandleLookup,
): ResolvedHandle[] => handles.map((h) => resolveHandle(h, lookup));

/** Counts by status, for a caller that wants to report coverage honestly. */
export const summarise = (results: readonly ResolvedHandle[]): Record<ResolutionStatus, number> => {
  const out: Record<ResolutionStatus, number> = {
    resolved: 0,
    unknown: 0,
    ambiguous: 0,
    shortcode: 0,
  };
  for (const r of results) out[r.status] += 1;
  return out;
};
