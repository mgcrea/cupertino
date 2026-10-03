// Which licences `make revocations` bakes into the app as refused.
//
// Here rather than inline in scripts/generate-revocations.mjs so that
// revocations.test.mjs can run it against the real migrations: a query is the
// kind of thing that reads right and selects wrong.

/**
 * Every licence a refund or dispute revoked, and every licence test mode minted.
 *
 * The second half is because there is one signing key and one D1 database for
 * both Stripe modes (see apps/api/migrations/0003_livemode.sql). A test-mode
 * purchase therefore mints a key the shipped app genuinely accepts, from a
 * checkout anybody holding a test-mode link can complete with card 4242.
 * Revoking all of them, whatever `revoked_at` says, leaves a rehearsal working
 * in the build it was run against and in no build made after the next
 * `make revocations`.
 */
export const REVOKED_QUERY =
  "SELECT id FROM licenses WHERE revoked_at IS NOT NULL OR livemode = 0 ORDER BY id";
