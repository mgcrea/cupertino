# Cupertino licence API

The Cloudflare Worker that turns a Stripe payment into a licence key, on
`api.cupertino.mgcrea.io`. It is the only part of [Cupertino](../..) allowed to touch the network,
and the only place the signing key lives.

## Development

```bash
pnpm dev                 # wrangler dev, local D1 via miniflare
pnpm test                # vitest
pnpm typecheck           # tsc --noEmit
pnpm migrate:local       # apply migrations to the local D1
pnpm migrate             # …to the real one. Deliberately separate commands.
pnpm deploy              # wrangler deploy, by hand or from the api-v* tag in CI
```

Copy `.dev.vars.example` to `.dev.vars` first — it is gitignored and holds the signing key in
plain text. Leaving `RESEND_API_KEY` unset is useful rather than broken: the webhook then returns 500,
which is exactly what makes Stripe retry, and the licence row is still written.

`pnpm lint` and `pnpm format:check` are **root-only** commands covering every workspace at once.

## Why this is not part of the website

Three reasons, and they all point the same way. The site is static assets whose `public/_redirects`
serves `/download` — the permanent URL the Homebrew cask depends on — and a Worker in front of that
risks shadowing it. The site's `tsconfig.json` is `include: ["**/*"]` over a Node-shaped base,
which is the wrong shape for workerd. And the signing key has no business on the Worker that serves public
HTML. The cost is a second hostname, which is why `/thanks` renders here rather than there.

## The one secret

`LICENSE_SIGNING_KEY` fails in both directions. Leaked, anyone can issue licences. Lost, no key
can ever be issued for that major version again — including a replacement for a customer who lost
theirs, because the public half is compiled into every shipped build. It belongs in a backup that is
neither this repository nor the Worker.

## Three implementations, one format

`scripts/lib/license.mjs` (Node), `src/license.ts` (WebCrypto, here) and
`apps/apple/Cupertino/License.swift` (CryptoKit) all implement the same key format, because none of
the three can import the others. Two things keep them honest:

- The signature covers the **encoded** payload, never the parsed object, so JSON key order and
  whitespace never have to agree across three languages — only bytes do.
- `test/license.test.ts` asserts this Worker and the Node script produce **byte-identical** keys
  from identical input. "Each accepts the other's" would pass while the two quietly diverged on field
  order; that is the failure this is built to catch.

Changing the payload shape means changing all three. The field order in the object literal in
`src/license.ts` is load-bearing.

## What the webhook must keep doing

- **Verify the signature against the raw body.** Re-serialising the JSON changes bytes Stripe signed.
- **Parse the envelope before the session.** Every subscribed event arrives here, not just ours. A
  single schema over the whole payload would call `payment_intent.succeeded` malformed and answer
  400, putting unrelated events into the same three-day retry loop a broken payload deserves.
- **Stay idempotent.** `stripe_session_id` is unique; Stripe redelivers for days and a redelivery
  must not mean a second licence.
- **Return 500 when the email fails.** That is not an oversight — it is what makes Stripe retry, and
  the alternative is a customer who paid and got nothing.
- **Check `payment_status`.** A session completes for delayed payment methods before the money lands.

## Revocation is not enforced here

This Worker only records it. `revoked_at` is set on a full refund or a dispute, cleared if the
dispute is won, and read by `make revocations` at the repository root, which bakes the list into the
next build. The app cannot consult anything at run time — it makes no network connections at all,
which `scripts/audit-network.sh` gates in CI — so a refunded key keeps working until the next
release and then stops. [EULA](../apple/EULA) §4(a) tells the buyer that rather than leaving it to be
discovered. See [docs/licensing.md](../../docs/licensing.md).

## What is not stored

There is no list of who has **not** paid. Stripe is the record of who paid; the one D1 table is the
record of which key went to whom; whether a given Mac is licensed lives in that Mac's `UserDefaults`
and is never transmitted. Any design that needs a not-paid list has smuggled a phone-home back in.

`/license/resend` answers identically whether or not an address is a customer, on purpose — anything
else makes it an oracle for "did this person buy Cupertino".
