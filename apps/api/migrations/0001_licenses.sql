-- One table. It is the whole of what this project knows about anyone.
--
-- Stripe already records who paid, how much and what tax; duplicating that here
-- would mean two systems of record disagreeing eventually. What Stripe does NOT
-- know is which key was issued, and that is the only reason this exists.
--
-- `key` is stored rather than re-derived from the payment on demand. Derivation
-- looks elegant until the payload format changes once, and then no old key can
-- be reproduced and every re-send is subtly wrong.
--
-- `price_id` and `amount_paid` are recorded from the very first sale because the
-- price ladder rises: offering fair upgrade pricing at 2.0 is impossible without
-- knowing what people actually paid, and that number cannot be reconstructed
-- after the fact.

CREATE TABLE licenses (
  id                TEXT    PRIMARY KEY,
  email             TEXT    NOT NULL,
  major             INTEGER NOT NULL,
  key               TEXT    NOT NULL,
  -- The idempotency key. Stripe redelivers a webhook for days, and a second
  -- delivery must not mean a second licence.
  stripe_session_id TEXT    NOT NULL UNIQUE,
  price_id          TEXT    NOT NULL DEFAULT '',
  amount_paid       INTEGER NOT NULL,
  currency          TEXT    NOT NULL,
  issued_at         TEXT    NOT NULL,
  -- Set on refund or chargeback. Read by `make revocations`, which bakes the
  -- list into the next build — revocation lands at build time, never at run
  -- time, because the app is not allowed to ask anyone anything.
  revoked_at        TEXT,
  -- Rate-limits the resend route without needing a second table.
  last_sent_at      TEXT
);

CREATE INDEX licenses_email ON licenses (email);
