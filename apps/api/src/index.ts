// Turning a Stripe payment into a licence key.
//
// Its own Worker rather than a route on the marketing site, for three reasons
// that all point the same way: the site is static assets whose `_redirects` file
// serves the permanent /download URL the Homebrew cask depends on, and adding a
// script in front of that risks shadowing it; the site's tsconfig is Node-shaped
// and this is workerd-shaped; and the signing key has no business living on the
// Worker that serves public HTML.
//
// Everything here is allowed to touch the network. The APP is the thing that
// cannot, and nothing in this directory ships inside it.

import { signingKeyProblem, webhookSecretProblem } from "./config";
import { sendLicense } from "./email";
import type { LicenseRow } from "./env";
import { mint } from "./license";
import { notFoundPage, pendingPage, revokedPage, thanksPage } from "./pages";
import {
  charge,
  checkoutSession,
  dispute,
  eventEnvelope,
  isFullyRefunded,
  resendRequest,
} from "./schema";
import { priceIdFor, verifySignature } from "./stripe";

/** Long enough to swallow a Stripe redelivery, short enough to be useful. */
const SEND_COOLDOWN_MS = 5 * 60 * 1000;

/** A resend body is an address. Anything larger is not one. */
const MAX_BODY_BYTES = 4096;

/** Which field moved, in one line, for the log. */
const explain = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const sentWithin = (at: string | null, window: number, now: number): boolean =>
  at !== null && now - Date.parse(at) < window;

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * A signed event this Worker cannot act on, answered 200.
 *
 * Stripe retries every answer that is not a 2xx, 4xx included, for up to three
 * days. Once the signature has checked out, a payload that does not parse will
 * not parse on the fortieth delivery either, so a 4xx bought nothing but three
 * days of repeats burying the one useful line. The body still shows on the event
 * in the Stripe dashboard, and `console.error` puts it in Workers Logs, which is
 * where someone acts on it. 500 stays for what a retry can fix.
 */
const unactionable = (message: string): Response => {
  console.error(`webhook: ${message}`);
  return new Response(message, { status: 200 });
};

/**
 * Take the right to send this licence's email, or learn that another request
 * already has.
 *
 * Reading `last_sent_at`, sending, and only then writing it left a window as
 * wide as the send: two deliveries of one event (a retry overlapping a slow
 * first attempt, or a "Resend" from the dashboard) both read the old value,
 * both sent, and the customer got the key twice. So the stamp moves FIRST,
 * conditioned on still holding the value that was read, and only the request
 * whose UPDATE changed the row goes on to send. `IS` rather than `=`, so NULL
 * matches NULL.
 *
 * Returns the stamp written, which `releaseSend` needs, or null when another
 * request got there first. A Worker killed between the claim and the send leaves
 * a stamp and no email; that delivery got no 2xx, so Stripe retries it, and a
 * retry landing after the cooldown sends.
 */
const claimSend = async (env: Env, row: LicenseRow): Promise<string | null> => {
  const stamp = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE licenses SET last_sent_at = ? WHERE id = ? AND last_sent_at IS ?",
  )
    .bind(stamp, row.id, row.last_sent_at)
    .run();
  return (result.meta.changes ?? 0) > 0 ? stamp : null;
};

/**
 * Hand a claim back after a failed send, so the retry that follows is not
 * turned away by the cooldown as "already sent". Conditioned on the stamp still
 * being this request's, so it can never rewind a later claim.
 */
const releaseSend = async (env: Env, row: LicenseRow, stamp: string): Promise<void> => {
  await env.DB.prepare("UPDATE licenses SET last_sent_at = ? WHERE id = ? AND last_sent_at = ?")
    .bind(row.last_sent_at, row.id, stamp)
    .run();
};

const findBySession = (env: Env, sessionId: string): Promise<LicenseRow | null> =>
  env.DB.prepare(
    "SELECT id, email, key, last_sent_at, revoked_at, revoked_reason" +
      " FROM licenses WHERE stripe_session_id = ?",
  )
    .bind(sessionId)
    .first<LicenseRow>();

/**
 * The only route that matters.
 *
 * Idempotent by way of the unique constraint on `stripe_session_id`, because
 * Stripe redelivers for days and a redelivery must not mean a second licence.
 * A failed email returns 500 on purpose: Stripe then retries, the insert is a
 * no-op the second time, and the send is attempted again — which is exactly the
 * behaviour wanted when the alternative is a customer who paid and got nothing.
 * The same goes for a price lookup that failed and a signing key that is missing:
 * a retry can fix both. A payload that can never be fulfilled answers 200.
 */
const fulfil = async (object: unknown, env: Env, livemode: boolean): Promise<Response> => {
  const parsed = checkoutSession.safeParse(object);
  if (!parsed.success) {
    // 200, not 4xx or 500: something that will never parse should stop being
    // retried, and Stripe retries any 4xx. The message is what says which field
    // Stripe moved.
    return unactionable(`session: ${explain(parsed.error)}`);
  }
  const session = parsed.data;
  if (session.payment_status && session.payment_status !== "paid") {
    return new Response("not paid yet", { status: 200 });
  }
  const email = session.customer_details?.email?.trim().toLowerCase();
  // Paid, and nowhere to send the key. No retry will add an address, so this is
  // for a human: the log line is how the sale gets found and minted by hand.
  if (!email) return unactionable(`no email on paid session ${session.id}`);

  let row = await findBySession(env, session.id);
  if (!row) {
    // Metadata first, the API call second. A Payment Link copies its metadata
    // onto every session it creates, so a `price_id` set there arrives inside a
    // webhook that is already signed and already parsed — no key, no round trip
    // on the one path that must not fail. The live link carries `price_id` (checked
    // in the Stripe dashboard on 2026-09-14), so the call is only the fallback for
    // a link or session that does not.
    let priceId = session.metadata?.price_id ?? "";
    if (!priceId && env.STRIPE_SECRET_KEY) {
      const lookup = await priceIdFor(session.id, env.STRIPE_SECRET_KEY);
      if (!lookup.ok) {
        // 500: the sale waits for Stripe's retry rather than going through
        // unguarded. See the holes below for why this one is not let through.
        console.error(`fulfil: price lookup failed for ${session.id}, ${lookup.reason}`);
        return new Response(`price lookup failed: ${lookup.reason}`, { status: 500 });
      }
      priceId = lookup.priceId;
    }

    // Whether this sale is ours at all. Resolved BEFORE the mint, so another
    // product's sale never reaches the signing key.
    //
    // This Worker and bastion-api are two endpoints on ONE Stripe account, both
    // subscribed to checkout.session.completed, and Stripe delivers every event
    // of a subscribed type to every endpoint subscribed to it. Neither side used
    // to look at what had been bought, so on 2026-09-11 a Bastion sale was
    // fulfilled here: the buyer paid for Bastion and was mailed a cup1 key for a
    // product they had never heard of.
    //
    // An allowlist of OUR price, never a blocklist of theirs: a third product is
    // then a Worker nobody has to remember to tell about, and forgetting costs a
    // duplicate rather than a stranger's licence.
    //
    // Two deliberate holes, both falling the way this file falls everywhere else
    // — a reporting gap beats a customer who paid and got nothing. An unset
    // EXPECTED_PRICE_ID guards nothing, so deploying this before the var is
    // configured changes no behaviour. And a session whose price nothing CAN
    // name is let through: no `price_id` in the metadata and no
    // STRIPE_SECRET_KEY to ask with, or a Stripe answer listing no price.
    // Refusing those would refund a real sale to protect a column.
    //
    // A lookup that FAILED is not one of the holes. With the key configured, an
    // error or a timeout answers 500 above and the sale waits for Stripe's retry.
    // priceIdFor used to fold those into the same empty string, so for any sale
    // arriving without `price_id` metadata a Stripe hiccup re-opened exactly the
    // mix-up described above. A retry costs a buyer minutes; a stranger's licence
    // costs a refund and an apology.
    if (env.EXPECTED_PRICE_ID && priceId && priceId !== env.EXPECTED_PRICE_ID) {
      // 200, not 4xx: the event is valid and simply belongs to another product.
      // A 4xx would have Stripe retrying it for three days.
      console.log(`fulfil: ignoring ${session.id}, price ${priceId} is not ours`);
      return new Response("not this product", { status: 200 });
    }

    // Checked before the mint rather than discovered inside it, where a missing
    // or malformed key throws something that names neither the key nor the fix.
    const keyProblem = await signingKeyProblem(env.LICENSE_SIGNING_KEY);
    if (keyProblem) {
      console.error(`fulfil: not configured, ${keyProblem}`);
      return new Response(`not configured: ${keyProblem}`, { status: 500 });
    }

    const major = Number(env.CURRENT_MAJOR) || 1;
    const minted = await mint({ email, major, privateKey: env.LICENSE_SIGNING_KEY });
    await env.DB.prepare(
      `INSERT INTO licenses
         (id, email, major, key, stripe_session_id, payment_intent, price_id, amount_paid,
          currency, issued_at, livemode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stripe_session_id) DO NOTHING`,
    )
      .bind(
        minted.id,
        email,
        major,
        minted.key,
        session.id,
        // Empty only when Stripe created no PaymentIntent, which for a session
        // in payment mode means a no-cost order: a 100% discount or a zero
        // price, so nothing was charged and nothing can ever be refunded or
        // disputed. Those arrive as `no_payment_required` and stop at the
        // `payment_status` check above, so in practice the empty rows are the
        // ones that predate migration 0002. `revoke` and `disputeClosed` both
        // return before querying when an event carries no payment intent, so an
        // empty column is never matched.
        session.payment_intent ?? "",
        priceId,
        session.amount_total ?? 0,
        session.currency ?? "eur",
        minted.issuedAt,
        livemode ? 1 : 0,
      )
      .run();
    // Re-read rather than trusting the insert: on a race the row that won is the
    // one to send, and sending a key that is not in the table would be worse
    // than any duplicate.
    row = await findBySession(env, session.id);
  }
  if (!row) {
    console.error(`fulfil: no row after insert for session ${session.id}`);
    return new Response("could not record the licence", { status: 500 });
  }

  // A revoked licence is not mailed again: the money went back. Without this, a
  // redelivery after a refund, or a "Resend" on the event in the Stripe
  // dashboard, would send the dead key under a note promising a refund.
  if (row.revoked_at) {
    const why = row.revoked_reason ?? "reason not recorded";
    return new Response(`licence revoked (${why}), not re-sent`, { status: 200 });
  }
  if (sentWithin(row.last_sent_at, SEND_COOLDOWN_MS, Date.now())) {
    return new Response("already sent", { status: 200 });
  }
  const stamp = await claimSend(env, row);
  // 200: the request holding the claim answers for this send, with a 500 of its
  // own if the email fails.
  if (!stamp) return new Response("already being sent", { status: 200 });
  const sent = await sendLicense(env, row.email, row.key);
  if (!sent.ok) {
    await releaseSend(env, row, stamp);
    console.error(`fulfil: email failed for licence ${row.id}, ${sent.reason}`);
    return new Response(`email: ${sent.reason}`, { status: 500 });
  }
  return new Response("ok", { status: 200 });
};

/**
 * Mark a licence revoked, by the payment that bought it.
 *
 * Guarded on `revoked_at IS NULL` so a redelivered event does not keep moving
 * the timestamp forward — the date is meant to be when it was revoked, not when
 * Stripe last mentioned it. The same guard keeps the FIRST reason: a refunded
 * licence whose charge is later disputed stays `refunded`, which is what stops
 * a won dispute from handing it back.
 *
 * Nothing here reaches the app. Revocation is baked into a build by
 * `make revocations`, so this only records the fact; the refunded key keeps
 * working until the next release, exactly as EULA §4(a) says it will.
 */
const revoke = async (
  env: Env,
  paymentIntent: string | null | undefined,
  why: "refunded" | "disputed",
) => {
  if (!paymentIntent) {
    // 200, not 500. Retrying will never make a payment intent appear, and a
    // three-day retry loop buries the problem; this body shows up in the event
    // log on the Stripe dashboard, where someone will see it.
    return new Response(`${why}: no payment intent on the event, nothing revoked`, { status: 200 });
  }
  const result = await env.DB.prepare(
    "UPDATE licenses SET revoked_at = ?, revoked_reason = ?" +
      " WHERE payment_intent = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), why, paymentIntent)
    .run();
  return new Response(`${why}: revoked ${result.meta.changes ?? 0}`, { status: 200 });
};

/**
 * `charge.refunded` also fires for a PARTIAL refund, which is the trap. Handing
 * back two euros of a fifteen euro licence is a goodwill gesture; treating it as
 * a revocation would take the product away from someone who still owns it.
 */
const refunded = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = charge.safeParse(object);
  if (!parsed.success) return unactionable(`charge: ${explain(parsed.error)}`);
  if (!isFullyRefunded(parsed.data)) {
    return new Response("partial refund: licence left alone", { status: 200 });
  }
  return revoke(env, parsed.data.payment_intent, "refunded");
};

const disputed = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = dispute.safeParse(object);
  if (!parsed.success) return unactionable(`dispute: ${explain(parsed.error)}`);
  return revoke(env, parsed.data.payment_intent, "disputed");
};

/**
 * A dispute that closes in our favour means the claim failed and the customer
 * did pay after all, so the licence comes back, if the dispute is what took it
 * away. Any other outcome leaves it revoked.
 *
 * In practice this usually costs nothing to honour: disputes take weeks, and
 * unless a release went out in the meantime the revocation was never baked into
 * a build to begin with.
 */
const disputeClosed = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = dispute.safeParse(object);
  if (!parsed.success) return unactionable(`dispute: ${explain(parsed.error)}`);
  const { payment_intent: paymentIntent, status } = parsed.data;
  if (status !== "won") {
    return new Response(`dispute ${status ?? "closed"}: licence stays revoked`, { status: 200 });
  }
  if (!paymentIntent) {
    return new Response("dispute won: no payment intent, nothing restored", { status: 200 });
  }
  // Only rows the DISPUTE revoked. This used to clear every row for the payment
  // intent, so a licence revoked by a full refund, whose charge was then
  // disputed and won, came back, and the next `make revocations` dropped it from
  // the baked-in list: a working key for someone who already had their money.
  // Rows revoked before migration 0004 carry no reason and stay revoked.
  const result = await env.DB.prepare(
    "UPDATE licenses SET revoked_at = NULL, revoked_reason = NULL" +
      " WHERE payment_intent = ? AND revoked_reason = 'disputed'",
  )
    .bind(paymentIntent)
    .run();
  return new Response(`dispute won: restored ${result.meta.changes ?? 0}`, { status: 200 });
};

/**
 * Verify, then route on the event type.
 *
 * Every subscribed event lands here, not just the ones handled. Deciding that
 * BEFORE insisting on a shape is what keeps an unrelated event type from being
 * logged as a malformed one.
 */
const handleWebhook = async (request: Request, env: Env): Promise<Response> => {
  const secretProblem = webhookSecretProblem(env.STRIPE_WEBHOOK_SECRET);
  if (secretProblem) {
    console.error(`webhook: not configured, ${secretProblem}`);
    // 500, so Stripe keeps the event and delivers it again once the secret is
    // fixed. The body names nothing: this answer goes to anyone who POSTs.
    return new Response("not configured", { status: 500 });
  }

  const raw = await request.text();
  const verified = await verifySignature(
    raw,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!verified.ok) {
    // The reason goes to the log, not the body. Before the signature holds, the
    // body is read by whoever sent the request, and telling a forger which check
    // failed (no timestamp, stale, wrong MAC) is a guide to the next attempt.
    console.error(`webhook: refused, ${verified.reason}`);
    return new Response("invalid signature", { status: 400 });
  }

  let envelope: ReturnType<typeof eventEnvelope.safeParse>;
  try {
    envelope = eventEnvelope.safeParse(JSON.parse(raw));
  } catch {
    return unactionable("body is not JSON");
  }
  if (!envelope.success) return unactionable(`not a Stripe event: ${explain(envelope.error)}`);

  const object = envelope.data.data.object;
  switch (envelope.data.type) {
    case "checkout.session.completed":
      return fulfil(object, env, envelope.data.livemode);
    case "charge.refunded":
      return refunded(object, env);
    case "charge.dispute.created":
      return disputed(object, env);
    case "charge.dispute.closed":
      return disputeClosed(object, env);
    default:
      return new Response("ignored", { status: 200 });
  }
};

const handleThanks = async (url: URL, env: Env): Promise<Response> => {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return html(notFoundPage(), 404);
  const row = await findBySession(env, sessionId);
  // The redirect can outrun the webhook. That is a wait, not an error.
  if (!row) return html(pendingPage(), 202);
  // Refunded or disputed: the page says so and shows no key, as the webhook
  // mails none and the resend route finds none.
  if (row.revoked_at) return html(revokedPage(row.revoked_reason), 410);
  return html(thanksPage(row.key, row.email));
};

/**
 * The lookup and the send behind `handleResend`, run after its answer has gone.
 *
 * Nothing here reaches the response, so nothing here can tell the caller
 * anything: a failure is logged and the claim handed back, as in `fulfil`.
 */
const resendTo = async (env: Env, email: string): Promise<void> => {
  try {
    const row = await env.DB.prepare(
      `SELECT id, email, key, last_sent_at, revoked_at, revoked_reason FROM licenses
         WHERE email = ? AND revoked_at IS NULL
         ORDER BY issued_at DESC LIMIT 1`,
    )
      .bind(email)
      .first<LicenseRow>();
    if (!row || sentWithin(row.last_sent_at, SEND_COOLDOWN_MS, Date.now())) return;

    // The per-address cooldown, made to hold for requests that overlap as well
    // as for ones that follow each other. See `claimSend`.
    const stamp = await claimSend(env, row);
    if (!stamp) return;
    const sent = await sendLicense(env, row.email, row.key);
    if (!sent.ok) {
      await releaseSend(env, row, stamp);
      console.error(`resend: email failed for licence ${row.id}, ${sent.reason}`);
    }
  } catch (error) {
    console.error(`resend: ${describeError(error)}`);
  }
};

/**
 * Re-send a key to the address that bought it.
 *
 * Answers identically whether or not the address is a customer, in the body AND
 * in the time taken. Anything else makes this an oracle for "did this person
 * buy Cupertino", which is a question a stranger should not be able to ask a
 * thousand times a second. The time is why the lookup and the send run in
 * `ctx.waitUntil` after the answer: awaited inline, a customer's request cost a
 * D1 query plus an Email Service round trip and a stranger's cost the query
 * alone, and that difference answered the question the identical body refused.
 *
 * No CORS, on purpose. Nothing calls this from a browser on another origin, and
 * without an Access-Control-Allow-Origin header no page elsewhere can read the
 * answer. Requiring `application/json` closes the other half: it is not a
 * CORS-safelisted content type, so a cross-origin browser has to preflight, the
 * preflight is answered with no allow header, and the POST is never sent. A
 * `text/plain` form post needs no preflight, so accepting one would let any web
 * page make its visitors' browsers fire resends at addresses of its choosing.
 */
const handleResend = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const answer = json({ ok: true });

  // Not an address-dependent answer, so it can differ: it depends only on what
  // the caller sent.
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    return json({ ok: false, error: "send application/json" }, 415);
  }

  // Declared size first, so an oversized body is refused before it is buffered.
  // This route is public and nothing legitimate on it exceeds a few hundred bytes.
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return answer;

  let email: string;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return answer;
    const parsed = resendRequest.safeParse(JSON.parse(raw));
    if (!parsed.success) return answer;
    email = parsed.data.email;
  } catch {
    return answer;
  }

  ctx.waitUntil(resendTo(env, email));
  return answer;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // `return await`, not `return`: a rejected promise handed straight back would
    // skip the catch below.
    try {
      switch (route) {
        case "POST /stripe/webhook":
          return await handleWebhook(request, env);
        case "GET /thanks":
          return await handleThanks(url, env);
        case "POST /license/resend":
          return await handleResend(request, env, ctx);
        case "GET /health":
          return json({ ok: true });
        default:
          return html(notFoundPage(), 404);
      }
    } catch (error) {
      // Whatever a handler did not expect: a D1 outage, a binding missing from
      // wrangler.jsonc. Named in the log by route, answered 500 so a webhook that
      // hit it is retried. An error's own message describes the operation, never
      // a secret's value.
      console.error(`${route}: unhandled, ${describeError(error)}`);
      return new Response("internal error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
