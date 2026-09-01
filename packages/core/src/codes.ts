/**
 * One-time-code extraction, as a pure function over text.
 *
 * No I/O by design: everything here is decided from a string plus one bit about
 * the sender, so the whole thing tests offline against a table.
 *
 * ── WHY THIS SITS IN CORE ────────────────────────────────────────────────────
 *
 * It was written in `packages/messages` and said of itself that it was liftable
 * to Mail. Safari asked second — a code rendered in a page's text is the same
 * problem — and a second caller is the event that settles it, because the two
 * alternatives are both bad. Safari depending on the Messages package would
 * drag `chat.db` and a Contacts dependency across for one pure function. A
 * duplicate would drift silently, and the heuristic is exactly where the
 * mistakes live.
 *
 * This is the first HEURISTIC in core, which has otherwise been plumbing —
 * config, sqlite, osascript, tools, resources. Worth naming rather than
 * sneaking in: what belongs here is a judgement no surface owns, and this one
 * is now owned by two.
 *
 * The table in `test/codes.test.ts` is the asset, not this file. It is
 * SMS-shaped — short machine-written notifications — and a web page is a much
 * richer source of digit runs, so for the Safari caller this heuristic is
 * REUSED rather than re-validated. See docs/safari.md.
 *
 * ── WHY THIS IS NOT A REGEX ──────────────────────────────────────────────────
 *
 * The obvious implementation is `/\b\d{4,8}\b/` and it is wrong in a way that
 * matters more than usual: a caller asks for a login code, gets the last four
 * digits of an order number, and pastes it into an auth prompt. The failure is
 * silent and the retry costs the user an account lockout. So the digit run is
 * the CANDIDATE here, never the answer — it has to survive disqualification and
 * then earn a score.
 *
 * The false positives are not hypothetical. A real inbox carries order numbers,
 * tracking numbers, prices, street numbers, years, flight numbers and phone
 * numbers, and every one of them is a 4-to-8 digit run in a message that also
 * contains the word "code" somewhere.
 *
 * ── THE SIGNALS, STRONGEST FIRST ─────────────────────────────────────────────
 *
 *   domain-bound   `@example.com #123456` — the WebOTP/AutoFill convention
 *                  Apple and Chrome both parse. Unambiguous by construction:
 *                  the origin is bound to the code, so there is nothing to
 *                  guess. When present it wins outright.
 *   keyword        A code word adjacent to the digits. "adjacent" is measured
 *                  in characters, not words, because the two orders both occur
 *                  ("your code is 123456" and "123456 is your code") and a word
 *                  window would need two passes.
 *   shortcode      Sender is a shortcode — a bank, a courier, a 2FA sender,
 *                  never a person. Corroborating only: it raises a weak match
 *                  to usable, never creates one on its own.
 *
 * ── WHAT `confidence` IS FOR ─────────────────────────────────────────────────
 *
 * The tool reports it, and the tool description tells the model to check the
 * body on anything below "high". This mirrors `apple_safari_list_tabs`'
 * `historyMatch`: say how the match was made so the caller is never guessing
 * whether to trust it.
 */

/** A code word. "code" carries both English and French, conveniently. */
const KEYWORDS = [
  "code",
  "verification",
  "verify",
  "one-time",
  "onetime",
  "one time",
  "otp",
  "passcode",
  "pin",
  "2fa",
  "two-factor",
  "authentication",
  "authenticate",
  "security",
  "log in",
  "login",
  "sign in",
  "signin",
  "confirm",
  // French. `vérification` is listed unaccented too because senders strip
  // accents to stay inside one SMS segment.
  "verification",
  "usage unique",
  "mot de passe",
  "connexion",
  "identification",
  "securite",
  "sécurité",
  "vérification",
];

/**
 * Phrases where "code" means something else entirely.
 *
 * This is a denylist and `docs/surfaces.md` warns that a denylist can never be
 * finished — correctly, and it is used narrowly here because of that. It only
 * ever SUPPRESSES the keyword signal; it never decides the outcome by itself,
 * and a message carrying both "promo code" and a real domain-bound code still
 * resolves through the stronger signal.
 */
const ANTI_KEYWORDS = [
  "promo code",
  "promotional code",
  "discount code",
  "coupon code",
  "referral code",
  "invite code",
  "area code",
  "zip code",
  "postal code",
  "qr code",
  "barcode",
  "bar code",
  "country code",
  "code promo",
  "code postal",
  "code de reduction",
  "code de réduction",
  "code parrainage",
];

/** How far from the digits a keyword still counts, in characters. */
const NEAR = 32;
const ADJACENT = 12;

export type CodeConfidence = "high" | "medium" | "low";

export type CodeMatch = {
  /** The digits to type. Never the surrounding text. */
  code: string;
  confidence: CodeConfidence;
  /** Which signal fired: `domain-bound` | `keyword` | `shortcode`. */
  matched: string;
  /** Present only for `domain-bound`: the origin the code is bound to. */
  boundTo?: string;
};

/**
 * The WebOTP format: a last line of `@host #code`, optionally with `?` params.
 * Anchored to a `@host` so a bare `#1234` (an order number, a hashtag) does not
 * qualify.
 */
const DOMAIN_BOUND = /@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s+#([0-9]{4,8})\b/i;

/**
 * A maximal run of digits and the separators a phone number or a formatted
 * quantity is allowed to contain. Used to reject, not to match: a span holding
 * more than 8 digits in total is a phone number, an account number or an
 * amount, and every digit run inside it is disqualified along with it.
 */
const NUMBER_SPAN = /\d[\d\s().+-]*\d|\d+/g;
const DIGIT_RUN = /\d{4,8}/g;

const normalise = (s: string) => s.toLowerCase().replace(/ /g, " ");

/** Spans that hold too many digits to be a code. Returns [start, end) pairs. */
const disqualifiedSpans = (text: string): [number, number][] => {
  const out: [number, number][] = [];
  for (const m of text.matchAll(NUMBER_SPAN)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits > 8) out.push([m.index, m.index + m[0].length]);
  }
  return out;
};

const inSpan = (spans: [number, number][], start: number, end: number) =>
  spans.some(([a, b]) => start >= a && end <= b);

/**
 * Rejections that look at the characters touching the digits.
 *
 * Each of these was a real false positive shape before it was a rule; see
 * `test/codes.test.ts`, where every one has a case.
 */
const looksLikeSomethingElse = (text: string, start: number, end: number): boolean => {
  const before = text.slice(Math.max(0, start - 12), start);
  const after = text.slice(end, end + 12);

  // Currency: "$1299", "€ 1299", and the grouped/decimal forms "1,299.00".
  if (/[$€£¥]\s*$/.test(before)) return true;
  if (/^[.,]\d/.test(after)) return true;
  if (/\d[.,]$/.test(before)) return true;

  // Glued to letters — a tracking or reference number like "AA10123456".
  // A separator is fine: Google sends "G-123456" and the code is the digits.
  if (/[a-z]$/i.test(before)) return true;
  if (/^[a-z]/i.test(after) && !/^[a-z]{0,2}\b/i.test(after)) return true;

  // A percentage or an ordinal is never a code.
  if (/^\s*%/.test(after)) return true;

  return false;
};

/** 1900-2099. Rejected unless a keyword sits right against it. */
const looksLikeYear = (digits: string) => digits.length === 4 && /^(19|20)\d{2}$/.test(digits);

/**
 * Distance in characters from a digit run to the nearest keyword, or null.
 *
 * Both directions are searched because both orders are common in the wild:
 * "your code is 123456" and "123456 is your Google verification code".
 *
 * The slice is widened by the longest keyword before searching, and the
 * distance checked afterwards. Slicing to exactly NEAR instead is wrong in a
 * way that is easy to miss: it cuts the keyword in half at the boundary, so
 * "authentication" (14 chars) would need to sit 14 characters closer than
 * "otp" to register at all. The window bounds the GAP, not the keyword.
 */
const LONGEST_KEYWORD = Math.max(...KEYWORDS.map((k) => k.length));

const keywordDistance = (lower: string, start: number, end: number): number | null => {
  const from = Math.max(0, start - NEAR - LONGEST_KEYWORD);
  const before = lower.slice(from, start);
  const after = lower.slice(end, end + NEAR + LONGEST_KEYWORD);

  let best: number | null = null;
  for (const kw of KEYWORDS) {
    const b = before.lastIndexOf(kw);
    if (b !== -1) {
      const d = before.length - (b + kw.length);
      if (d <= NEAR && (best === null || d < best)) best = d;
    }
    const a = after.indexOf(kw);
    if (a !== -1 && a <= NEAR && (best === null || a < best)) best = a;
  }
  return best;
};

/** True when a code word near the digits is one of the decoy phrases. */
const LONGEST_ANTI = Math.max(...ANTI_KEYWORDS.map((k) => k.length));

const suppressedByAntiKeyword = (lower: string, start: number, end: number): boolean => {
  const window = lower.slice(Math.max(0, start - NEAR - LONGEST_ANTI), end + NEAR + LONGEST_ANTI);
  return ANTI_KEYWORDS.some((k) => window.includes(k));
};

export type ExtractOptions = {
  /**
   * Whether the sender is a shortcode. Corroborating only — it raises a weak
   * match to usable and never creates one. `packages/contacts` classifies these
   * and `Correspondent.resolution` carries the verdict.
   *
   * It is ONE caller's corroborating bit and deliberately still named for it. A
   * caller with no sender at all — Safari, reading a page — simply leaves it
   * false, and the consequence is worth knowing rather than working around: on
   * that lane a `low` match can never occur, because the only route to one is
   * this flag. A page with digits and no keyword yields null.
   */
  fromShortcode?: boolean;
};

/**
 * Pull the one-time code out of a message, or return null.
 *
 * Null is the common and correct answer for most messages, and callers must
 * treat it as "no code here" rather than retrying with something looser.
 */
export const extractCode = (
  text: string | null | undefined,
  { fromShortcode = false }: ExtractOptions = {},
): CodeMatch | null => {
  if (!text) return null;
  // A code arrives in a short machine-written notification. Past a few hundred
  // characters this is a newsletter that happens to contain digits, and the
  // scoring below has no way to tell. Cheap, and it removes a whole class.
  if (text.length > 400) return null;

  const lower = normalise(text);

  // 1. Domain-bound. Unambiguous by construction, so it short-circuits.
  const bound = DOMAIN_BOUND.exec(text);
  const boundHost = bound?.[1];
  const boundCode = bound?.[2];
  if (boundHost && boundCode) {
    return { code: boundCode, confidence: "high", matched: "domain-bound", boundTo: boundHost };
  }

  const dead = disqualifiedSpans(text);
  const candidates: { code: string; confidence: CodeConfidence; matched: string; rank: number }[] =
    [];

  for (const m of text.matchAll(DIGIT_RUN)) {
    const digits = m[0];
    const start = m.index;
    const end = start + digits.length;

    if (inSpan(dead, start, end)) continue;
    if (looksLikeSomethingElse(text, start, end)) continue;

    const distance = keywordDistance(lower, start, end);
    const suppressed = distance !== null && suppressedByAntiKeyword(lower, start, end);
    const keyword = distance !== null && !suppressed;

    // A year needs a keyword pressed right against it to count. "expires 2026"
    // does not qualify; "your code is 2026" does.
    if (looksLikeYear(digits) && !(keyword && distance <= ADJACENT)) continue;

    if (keyword) {
      const adjacent = distance <= ADJACENT;
      candidates.push({
        code: digits,
        confidence: adjacent ? "high" : "medium",
        matched: "keyword",
        rank: adjacent ? 0 : 1,
      });
      continue;
    }

    // No keyword. A shortcode sender plus a single short line is the last
    // signal worth acting on, and it is deliberately capped at "low".
    if (fromShortcode && text.length <= 120) {
      candidates.push({ code: digits, confidence: "low", matched: "shortcode", rank: 2 });
    }
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const [best, second] = candidates;
  if (!best) return null;

  // Two equally-ranked candidates means the message holds more than one number
  // this function cannot separate — report the first but never claim "high",
  // because picking wrong is the failure this whole file exists to avoid.
  const ambiguous = second !== undefined && second.rank === best.rank && second.code !== best.code;
  return {
    code: best.code,
    confidence: ambiguous && best.confidence === "high" ? "medium" : best.confidence,
    matched: ambiguous ? `${best.matched}-ambiguous` : best.matched,
  };
};
