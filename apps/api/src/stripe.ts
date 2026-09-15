// Verifying that a webhook really came from Stripe.
//
// Done by hand rather than with the Stripe SDK, which would pull in
// `nodejs_compat` and a few hundred kilobytes to perform one HMAC. The scheme is
// small and fully specified: the header carries a timestamp and one or more
// signatures, and each is HMAC-SHA256 over `<timestamp>.<raw body>` keyed by the
// endpoint secret, verbatim including its `whsec_` prefix.
//
// Two things here are not optional. The body must be the RAW text, because
// re-serialising the JSON changes bytes Stripe signed. And the timestamp must be
// checked, because a signature with no freshness bound is a replay waiting to
// happen — a captured `checkout.session.completed` could otherwise be posted
// back forever.

export type Verified = { ok: true } | { ok: false; reason: string };

/** Stripe's tolerance, and the one everyone uses: five minutes either way. */
const TOLERANCE_SECONDS = 300;

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Length-independent compare, so a mismatch leaks no position information. */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};

export const verifySignature = async (
  rawBody: string,
  header: string | null,
  secret: string,
  now: number = Date.now(),
): Promise<Verified> => {
  if (!header) return { ok: false, reason: "no Stripe-Signature header" };

  let timestamp = "";
  const candidates: string[] = [];
  for (const piece of header.split(",")) {
    const separator = piece.indexOf("=");
    if (separator < 0) continue;
    const name = piece.slice(0, separator).trim();
    const value = piece.slice(separator + 1).trim();
    if (name === "t") timestamp = value;
    // v0 is the test-mode scheme and is deliberately not accepted.
    if (name === "v1") candidates.push(value);
  }

  if (!timestamp) return { ok: false, reason: "no timestamp in the signature header" };
  if (candidates.length === 0) return { ok: false, reason: "no v1 signature in the header" };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "timestamp is not a number" };
  const age = Math.abs(now / 1000 - seconds);
  if (age > TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp is ${Math.round(age)}s away, tolerance is 300s` };
  }

  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!candidates.some((candidate) => constantTimeEqual(candidate, expected))) {
    return { ok: false, reason: "no signature matches" };
  }
  return { ok: true };
};

export type PriceLookup = { ok: true; priceId: string } | { ok: false; reason: string };

/** Well inside the time Stripe waits for a webhook answer, so a hang becomes a logged 500. */
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * Which price the customer actually paid: for the product guard in `fulfil`, and
 * for the upgrade maths at 2.0.
 *
 * `checkout.session.completed` does not carry line items, so this is a second
 * call, and a call that FAILED says so rather than answering an empty price. It
 * used to fold every failure, a timeout included, into "", which the guard could
 * not tell apart from a session with no price to find, and so let the sale
 * through. With no `price_id` on the live link, a Stripe API error was then all
 * it took to mint a key for another product's buyer. The caller answers 500 on a
 * failure instead, and Stripe's retry is the second attempt.
 *
 * A 200 that names no price is not a failure: retrying would get the same
 * answer, so it comes back as `ok` with an empty price.
 */
export const priceIdFor = async (sessionId: string, secretKey: string): Promise<PriceLookup> => {
  try {
    const response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=1`,
      {
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    // A 401 here is STRIPE_SECRET_KEY itself, a 404 a key from the other Stripe
    // mode. Both are configuration, and both are worth a retry once fixed.
    if (!response.ok) return { ok: false, reason: `Stripe answered ${response.status}` };
    const body = (await response.json()) as { data?: { price?: { id?: string } }[] };
    return { ok: true, priceId: body.data?.[0]?.price?.id ?? "" };
  } catch (error) {
    // The name and message only: a fetch error describes the request, and the
    // key travels in a header no error message repeats.
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, reason: `line items request failed, ${reason}` };
  }
};
