-- Which Stripe mode minted this licence.
--
-- The Worker signs with the real key whatever mode the event came from, because
-- there is only one signing key and only one database. So a test-mode purchase
-- produces a licence that genuinely unlocks the shipped app — useful during a
-- rehearsal, and a hole if it goes unrecorded.
--
-- Recording it means test-minted keys can be found and revoked later instead of
-- being indistinguishable from real ones. Defaults to 1 because every row that
-- predates this column was written during local testing against a real key.

ALTER TABLE licenses ADD COLUMN livemode INTEGER NOT NULL DEFAULT 1;

CREATE INDEX licenses_livemode ON licenses (livemode) WHERE livemode = 0;
