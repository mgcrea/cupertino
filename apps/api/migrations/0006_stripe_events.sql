-- Every Stripe event this Worker has taken on, by event id.
--
-- Until now idempotency rested on what each handler could check for itself:
-- the unique `licenses.stripe_session_id`, the conditional claim on
-- `last_sent_at`, and revoke and restore written to be run twice. Those stop a
-- second licence and two overlapping sends. They do not stop a redelivery past
-- the five-minute send cooldown, or a "Resend" from the Stripe dashboard, from
-- mailing the key again. bastion-api and armada-api closed that with this
-- table; this is the same layer, on the outside of the ones above, which all
-- stay.
--
-- A delivery claims its event by inserting the row before any handler runs, so
-- of two overlapping deliveries exactly one gets through. A handler that
-- answers 300 or above, or throws, deletes the row again, so Stripe's retry
-- runs it. One that succeeds stamps `handled_at`, which makes the claim
-- permanent. A claim with no `handled_at` that is more than five minutes old
-- belongs to a Worker that died between the insert and its answer, and the
-- next delivery takes it over.
--
-- A new table, so the previous build keeps running against it. The build that
-- writes it does not run without it: apply before deploying.

CREATE TABLE stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  -- When the current claim was taken: the first delivery's, or the one that
  -- took over an abandoned claim.
  received_at TEXT NOT NULL,
  handled_at  TEXT
);
