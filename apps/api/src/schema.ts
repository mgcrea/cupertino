// What arrives from outside, and what is allowed through.
//
// Not a security boundary — the webhook is already past an HMAC, and every D1
// query here is parameterised. What this buys is a diagnosable failure. Reading
// `event.data.object` off an unchecked cast throws a TypeError when the shape
// surprises us, which becomes a 500, which becomes Stripe retrying every few
// hours for three days with nothing in the log saying what was wrong. A named
// validation error costs the same line count and says it.
//
// The envelope is separate from the session ON PURPOSE. Stripe delivers every
// event type this endpoint is subscribed to, and a single schema over the whole
// payload would reject `payment_intent.succeeded` and friends as malformed —
// turning "an event we do not care about" into the same retry loop. So: parse
// the envelope, decide whether it is ours, and only then insist on a shape.

import { z } from "zod";

/** Just enough to route on. `object` stays unknown until the type is known. */
export const eventEnvelope = z.object({
  type: z.string(),
  data: z.object({ object: z.unknown() }),
});

/**
 * The fields fulfilment actually reads. Everything is nullish because Stripe
 * omits rather than nulls, and because a missing currency should cost a default
 * rather than a licence.
 */
export const checkoutSession = z.object({
  id: z.string().min(1),
  amount_total: z.number().int().nullish(),
  currency: z.string().nullish(),
  payment_status: z.string().nullish(),
  customer_details: z.object({ email: z.string().nullish() }).nullish(),
});

/**
 * The only unauthenticated body this Worker accepts.
 *
 * Bounded at 320 characters because that is the longest address RFC 5321 admits,
 * and because `includes("@")` would happily pass ten megabytes of it into a
 * query. The address is lowercased here so it matches how the webhook stored it.
 */
export const resendRequest = z.object({
  // Trim and lowercase BEFORE validating, not after. `z.email()` runs against
  // the raw value, so a transform hung on the end would reject exactly the input
  // this is meant to accept — an address pasted out of a mail client with a
  // trailing space. Piping puts the normalisation first, where it belongs.
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
});

export type CheckoutSession = z.infer<typeof checkoutSession>;
