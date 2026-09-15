-- Why a licence was revoked, so that undoing one revocation cannot undo another.
--
-- `charge.dispute.closed` with status `won` used to clear `revoked_at` on every
-- row for the payment intent. A licence revoked by a full REFUND, whose charge
-- was then also disputed and the dispute won, came back: the next
-- `make revocations` dropped it from the baked-in list, and a working key went
-- back to someone who already had their money. A won dispute now restores only
-- a row whose `revoked_reason` is `disputed`.
--
-- Written by the Worker as `refunded` or `disputed`, after the event that did
-- it. NULL on every row revoked before this landed, and a won dispute leaves
-- those alone: which event revoked them is recorded nowhere this table can see,
-- and a licence left revoked by mistake costs one support email, where one
-- handed back by mistake is a refunded key that works.
--
-- Additive, so the previous build keeps running against it. The build that
-- reads it does not run without it: apply before deploying.

ALTER TABLE licenses ADD COLUMN revoked_reason TEXT;
