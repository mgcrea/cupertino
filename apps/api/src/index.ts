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

import { sendLicense } from "./email";
import type { LicenseRow } from "./env";
import { mint } from "./license";
import { notFoundPage, pendingPage, thanksPage } from "./pages";
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

const markSent = async (env: Env, id: string): Promise<void> => {
  await env.DB.prepare("UPDATE licenses SET last_sent_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), id)
    .run();
};

const findBySession = (env: Env, sessionId: string): Promise<LicenseRow | null> =>
  env.DB.prepare("SELECT id, email, key, last_sent_at FROM licenses WHERE stripe_session_id = ?")
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
 */
const fulfil = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = checkoutSession.safeParse(object);
  if (!parsed.success) {
    // 400, not 500: something that will never parse should stop being retried,
    // and the message is what says which field Stripe moved.
    return new Response(`session: ${explain(parsed.error)}`, { status: 400 });
  }
  const session = parsed.data;
  if (session.payment_status && session.payment_status !== "paid") {
    return new Response("not paid yet", { status: 200 });
  }
  const email = session.customer_details?.email?.trim().toLowerCase();
  if (!email) return new Response("no email on the session", { status: 400 });

  let row = await findBySession(env, session.id);
  if (!row) {
    const major = Number(env.CURRENT_MAJOR) || 1;
    const minted = await mint({ email, major, privateKey: env.LICENSE_SIGNING_KEY });
    const priceId = await priceIdFor(session.id, env.STRIPE_SECRET_KEY);
    await env.DB.prepare(
      `INSERT INTO licenses
         (id, email, major, key, stripe_session_id, payment_intent, price_id, amount_paid,
          currency, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stripe_session_id) DO NOTHING`,
    )
      .bind(
        minted.id,
        email,
        major,
        minted.key,
        session.id,
        session.payment_intent ?? "",
        priceId,
        session.amount_total ?? 0,
        session.currency ?? "eur",
        minted.issuedAt,
      )
      .run();
    // Re-read rather than trusting the insert: on a race the row that won is the
    // one to send, and sending a key that is not in the table would be worse
    // than any duplicate.
    row = await findBySession(env, session.id);
  }
  if (!row) return new Response("could not record the licence", { status: 500 });

  if (sentWithin(row.last_sent_at, SEND_COOLDOWN_MS, Date.now())) {
    return new Response("already sent", { status: 200 });
  }
  const sent = await sendLicense(env, row.email, row.key);
  if (!sent.ok) return new Response(`email: ${sent.reason}`, { status: 500 });
  await markSent(env, row.id);
  return new Response("ok", { status: 200 });
};

/**
 * Mark a licence revoked, by the payment that bought it.
 *
 * Guarded on `revoked_at IS NULL` so a redelivered event does not keep moving
 * the timestamp forward — the date is meant to be when it was revoked, not when
 * Stripe last mentioned it.
 *
 * Nothing here reaches the app. Revocation is baked into a build by
 * `make revocations`, so this only records the fact; the refunded key keeps
 * working until the next release, exactly as EULA §4(a) says it will.
 */
const revoke = async (env: Env, paymentIntent: string | null | undefined, why: string) => {
  if (!paymentIntent) {
    // 200, not 500. Retrying will never make a payment intent appear, and a
    // three-day retry loop buries the problem; this body shows up in the event
    // log on the Stripe dashboard, where someone will see it.
    return new Response(`${why}: no payment intent on the event, nothing revoked`, { status: 200 });
  }
  const result = await env.DB.prepare(
    "UPDATE licenses SET revoked_at = ? WHERE payment_intent = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), paymentIntent)
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
  if (!parsed.success) return new Response(`charge: ${explain(parsed.error)}`, { status: 400 });
  if (!isFullyRefunded(parsed.data)) {
    return new Response("partial refund: licence left alone", { status: 200 });
  }
  return revoke(env, parsed.data.payment_intent, "refunded");
};

const disputed = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = dispute.safeParse(object);
  if (!parsed.success) return new Response(`dispute: ${explain(parsed.error)}`, { status: 400 });
  return revoke(env, parsed.data.payment_intent, "disputed");
};

/**
 * A dispute that closes in our favour means the claim failed and the customer
 * did pay after all, so the licence comes back. Any other outcome leaves it
 * revoked.
 *
 * In practice this usually costs nothing to honour: disputes take weeks, and
 * unless a release went out in the meantime the revocation was never baked into
 * a build to begin with.
 */
const disputeClosed = async (object: unknown, env: Env): Promise<Response> => {
  const parsed = dispute.safeParse(object);
  if (!parsed.success) return new Response(`dispute: ${explain(parsed.error)}`, { status: 400 });
  const { payment_intent: paymentIntent, status } = parsed.data;
  if (status !== "won") {
    return new Response(`dispute ${status ?? "closed"}: licence stays revoked`, { status: 200 });
  }
  if (!paymentIntent) {
    return new Response("dispute won: no payment intent, nothing restored", { status: 200 });
  }
  const result = await env.DB.prepare(
    "UPDATE licenses SET revoked_at = NULL WHERE payment_intent = ?",
  )
    .bind(paymentIntent)
    .run();
  return new Response(`dispute won: restored ${result.meta.changes ?? 0}`, { status: 200 });
};

/**
 * Verify, then route on the event type.
 *
 * Every subscribed event lands here, not just the ones handled. Deciding that
 * BEFORE insisting on a shape is what keeps an unrelated event type out of the
 * same retry loop a malformed one belongs in.
 */
const handleWebhook = async (request: Request, env: Env): Promise<Response> => {
  const raw = await request.text();
  const verified = await verifySignature(
    raw,
    request.headers.get("stripe-signature"),
    env.STRIPE_WEBHOOK_SECRET,
  );
  if (!verified.ok) return new Response(`signature: ${verified.reason}`, { status: 400 });

  let envelope: ReturnType<typeof eventEnvelope.safeParse>;
  try {
    envelope = eventEnvelope.safeParse(JSON.parse(raw));
  } catch {
    return new Response("body is not JSON", { status: 400 });
  }
  if (!envelope.success) return new Response("not a Stripe event", { status: 400 });

  const object = envelope.data.data.object;
  switch (envelope.data.type) {
    case "checkout.session.completed":
      return fulfil(object, env);
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
  return html(thanksPage(row.key, row.email));
};

/**
 * Re-send a key to the address that bought it.
 *
 * Answers identically whether or not the address is a customer. Anything else
 * makes this an oracle for "did this person buy Cupertino", which is a question
 * a stranger should not be able to ask a thousand times a second.
 */
const handleResend = async (request: Request, env: Env): Promise<Response> => {
  const answer = json({ ok: true });

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

  const row = await env.DB.prepare(
    `SELECT id, email, key, last_sent_at FROM licenses
       WHERE email = ? AND revoked_at IS NULL
       ORDER BY issued_at DESC LIMIT 1`,
  )
    .bind(email)
    .first<LicenseRow>();
  if (!row || sentWithin(row.last_sent_at, SEND_COOLDOWN_MS, Date.now())) return answer;

  const sent = await sendLicense(env, row.email, row.key);
  if (sent.ok) await markSent(env, row.id);
  return answer;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "POST /stripe/webhook":
        return handleWebhook(request, env);
      case "GET /thanks":
        return handleThanks(url, env);
      case "POST /license/resend":
        return handleResend(request, env);
      case "GET /health":
        return json({ ok: true });
      default:
        return html(notFoundPage(), 404);
    }
  },
} satisfies ExportedHandler<Env>;
