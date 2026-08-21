-- Give a refund something to match on.
--
-- Fulfilment keys off `stripe_session_id`, but a refund or a dispute arrives as a
-- charge, and a charge knows its payment intent rather than the checkout session
-- that created it. Without this column the only way back to the licence would be
-- a Stripe API call on a path where the whole point is to keep working when the
-- network does not.
--
-- Empty on rows written before this landed. Those predate any real sale.

ALTER TABLE licenses ADD COLUMN payment_intent TEXT NOT NULL DEFAULT '';

CREATE INDEX licenses_payment_intent ON licenses (payment_intent);
