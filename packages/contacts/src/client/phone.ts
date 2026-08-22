/**
 * Phone number matching, which on this surface is the whole product.
 *
 * Contacts stores what the user typed. `docs/contacts.md` measured a 400-row
 * sample of `ZFULLNUMBER`: 222 formatted (`06 12 34 56 78`), 159 already E.164,
 * 15 bare digits. Messages, meanwhile, stores a handle as E.164 and nothing
 * else. So the two never meet as strings, and the measurement says so with an
 * unusually blunt number: **exact string equality resolves 3.7% of message
 * traffic.** A resolver that joins on the stored value is not slightly wrong, it
 * is useless.
 *
 * What works is a SUFFIX. No prefix rule connects `06…` to `+336…` without
 * knowing the user's country, which nothing here has any business guessing, but
 * the two agree from the ninth digit back.
 */

/** Everything that is not a digit, removed. The base of every key below. */
export const digitsOf = (value: string): string => value.replaceAll(/\D/g, "");

/**
 * How many trailing digits make a key. Nine, measured rather than picked.
 *
 * | key      | recent traffic resolved | ambiguous |
 * | -------- | ----------------------- | --------- |
 * | exact    | 8.5%                    | 1         |
 * | 10       | 96.7%                   | 5         |
 * | **9**    | **97.6%**               | **6**     |
 * | 7        | 97.6%                   | 6         |
 *
 * Seven ties nine on every column measured, so nine wins on the tie-break that
 * matters: a shorter key can only ever collide more. Ten is where French
 * national numbers (`0612345678`, ten digits) stop lining up with the same
 * number in E.164 (`+33612345678`, eleven) — which is exactly why 10 does no
 * better than plain digits and 9 does.
 */
export const SUFFIX_DIGITS = 9;

/**
 * Below this, a number is a shortcode — a bank, a delivery service, a 2FA
 * sender. 115 of the 958 handles in the measured `chat.db` were these. They can
 * never resolve to a contact, and counting them as failures is how a resolver
 * ends up reporting a far worse rate than it earns.
 */
const SHORTCODE_MAX_DIGITS = 6;

export const isShortcode = (value: string): boolean => {
  const d = digitsOf(value);
  return d.length > 0 && d.length <= SHORTCODE_MAX_DIGITS;
};

/**
 * The lookup key, or `null` when the value is too short to make one.
 *
 * Returning `null` rather than a short key is deliberate: a three-digit key
 * would match any number ending in those digits, which is the failure mode this
 * whole module exists to avoid.
 */
export const suffixKey = (value: string, digits: number = SUFFIX_DIGITS): string | null => {
  const d = digitsOf(value);
  return d.length >= digits ? d.slice(-digits) : null;
};

/** Email keys are simply case-folded. Measured: 37 of 60 resolve, none ambiguous. */
export const emailKey = (value: string): string => value.trim().toLowerCase();

export type HandleKind = "phone" | "email" | "shortcode";

/**
 * What kind of thing a Messages handle is.
 *
 * Order matters: `@` decides first, because an email address can contain digits
 * and a phone number can never contain an `@`.
 */
export const handleKind = (handle: string): HandleKind => {
  if (handle.includes("@")) return "email";
  return isShortcode(handle) ? "shortcode" : "phone";
};
