# Licensing

What is open, what is sold, and what actually buys trust.

## Short version

Everything stays readable. The servers stay MIT because they are libraries and adoption is the
point. The app's source stays in the repo, but its licence narrows: read it, audit it, build it for
yourself — do not redistribute the binary. What is sold is the signed, notarized build and the
promise behind it, never secrecy.

## Trust is auditability, not the licence

These get collapsed into each other and they are not the same thing. For a tool asking for Full
Disk Access, what settles the question is: can I read what it does, can I check who signed it, do I
know what happens if the author stops. None of that requires redistribution rights. A permissive
OSI licence is what makes an ecosystem adopt the **servers**; it is not what makes someone hand the
**app** their whole disk.

The instructive case is Bartender. It held sensitive macOS permissions, changed hands quietly in
2024, and users moved to Ice — an open competitor — within days. Closed source was not what killed
it; unverifiable ownership was. Cupertino has the same risk profile against a larger grant.

So closing the app would cost exactly the thing being sold, and buy only protection from a rebuild
— which a narrower licence buys anyway.

## What is licensed how

| Part             | Licence          | Why                                                         |
| ---------------- | ---------------- | ----------------------------------------------------------- |
| `packages/*`     | MIT              | libraries; ecosystem adoption is the funnel; vendor freely  |
| `apps/apple/`    | source-available | readable and buildable for yourself, binary rights reserved |
| the signed build | sold             | the notarized artifact, the update channel, the maintenance |

"Build it yourself if you would rather not pay" is an honest position and a defensible one. Most
people will pay rather than install Xcode, and the ones who will not were never customers.

**Both halves are now written down.** [`LICENSE`](../LICENSE) at the root is plain MIT, covering
`packages/*`, `scripts/` and `docs/`; [`apps/apple/LICENSE`](../apps/apple/LICENSE) is the Cupertino
Source-Available License, which disclaims its own open-source status in the second paragraph rather
than leaving anyone to work it out.

Its shape is the one this section argues for. Section 1 grants use, study, modification, source
redistribution — so a public fork or a pull request is fine — and, explicitly, **compiling it and
running your own build with no fee and no licence key**. Section 2 reserves exactly one thing:
handing a _binary_ to someone else. Auditing is not merely tolerated but named in 1(e): publishing
benchmarks, security findings, disassembly and the quotes needed to support them requires no
permission and no notice, because a licence that made an audit a favour would defeat the point of
being readable at all.

## What is actually being sold

Not the tools. They are MIT, and a `.mcp.json` pointing at `node dist/cli.js` stays free forever.

What is sold is what [distribution.md](distribution.md) already argues for: **one Full Disk Access
grant, held by a notarized binary from an identifiable developer**, instead of four grants handed
out to whichever editors happened to spawn a server. The alternative a user faces today is granting
whole-disk access to Cursor, Claude Desktop, VS Code and Terminal separately — four System Settings
trips, four processes that can now read their SSH keys.

Convenience sits on top and is real but secondary: no absolute paths, the host config written for
you, the writes toggle, the log pane.

|            |                                                                          |
| ---------- | ------------------------------------------------------------------------ |
| Price      | €14.99 at launch, rising with the surface count — see below              |
| Model      | one-time, per major version — 1.x is free forever, 2.0 is a new purchase |
| Collection | Stripe, with Stripe Tax on; VAT filed directly through OSS — see below   |
| Validation | offline, signed licence key, verified locally, no phone-home             |
| Trial      | none — see below; the refund is the trial                                |

**Writes are not the paywall.** Gating them behind the licence would make the free tier the safe one
and the paid tier the dangerous one — backwards as a sales message and worse as a default.
`allowWrites` is a safety control and stays one.

Offline validation is not a nicety either. A privacy tool that calls a licensing server on launch
contradicts its own pitch, and the next section is why that matters more than usual here.

## Three claims worth more than the licence

1. **The app makes no network connections.** There is no `URLSession`, no Sparkle and no HTTP
   anywhere in `apps/apple/Cupertino` or `apps/apple/CupertinoBridge`. The one socket in the codebase is
   `socket(AF_UNIX, SOCK_STREAM, 0)` in `ServerHost.swift` — a filesystem entry, mode-restricted to
   the one user, carrying stdio between the app and its own servers. For a process holding Full
   Disk Access that is a strong claim and a cheap one for anyone to verify, so it belongs on the
   front page rather than in a footnote. Because it is load-bearing for the sale it is checked
   rather than asserted; the next section is how. It is also a **constraint**: adding an update
   check makes it false, so if Sparkle ever lands it becomes the single documented exception and the
   claim gets reworded, not quietly dropped.

2. **Reproducible builds and published checksums.** Open source closes the gap between what the
   source says and what the binary does only if the two are known to correspond. Publish the hash of
   the signed build and the command that reproduces it; otherwise the audit stops at the tarball.

3. **A written succession policy.** The bundle identifier is the most expensive string in the
   project, and distribution.md records why: changing it is a new TCC identity, so every user
   re-grants. The flip side is the dangerous one — _keeping_ it lets a new owner inherit every
   existing user's Full Disk Access silently, on an ordinary update, with no prompt. That is
   precisely the Bartender mechanism. Stating in advance what happens to `io.mgcrea.cupertino` if
   this is sold, abandoned or handed on costs nothing, and no competitor bothers.

   **Now written**, in [succession.md](succession.md), and incorporated into the EULA by reference so
   it is owed to licensees rather than merely published. The load-bearing commitment is that a change
   of ownership ships under a **new** bundle identifier — every user re-grants, consciously, having
   been told who the acquirer is. That is deliberately expensive to acquire through, which is the
   whole point. The second is a twelve-month dead-man's switch: no release and no substantive commit
   for a year and `apps/apple/` relicenses to MIT on its own, because a redistribution reservation
   protecting an unmaintained project protects nothing and only blocks a fork.

## Enforcing the first claim

A sentence in a README is not a guarantee. There are two tiers here, and only the second one closes
the hole.

### Checked, today

`scripts/audit-network.sh` runs against the built bundle rather than the sources, so a stranger can
point it at the `.app` they downloaded and get the same answer CI got:

```console
$ scripts/audit-network.sh /Applications/Cupertino.app
  ok    Cupertino          no URL loading, no DNS, no TLS
  ok    cupertino-bridge   no URL loading, no DNS, no TLS
  ok    sockets            AF_UNIX only
```

It denies the high-level symbols — `URLSession`, CFNetwork, `Network.framework`, `getaddrinfo`, the
TLS entry points — and deliberately does **not** deny `socket` / `bind` / `connect`, because the
AF_UNIX bridge shares those syscalls with the thing being ruled out and so they cannot be the test.
The assertion that carries the claim is at source level instead: `AF_INET`, `PF_INET` and
`sockaddr_in` appear nowhere in `apps/apple/`. A socket that never names an internet address family is not
one.

Two properties make it a gate rather than a decoration. It fails when it inspected nothing — a build
that did not happen is not a pass — and it runs on every macOS CI job, against an unsigned build,
since signing adds no symbols. `make audit` is the local form.

It covers the Swift binaries only. `Resources/node` links networking by design and is reported
rather than failed: a general-purpose runtime cannot be symbol-audited into safety, and Node's
permission model (`--permission`, `--allow-fs-read`) covers the filesystem, child processes, workers
and addons but has no network permission to switch off.

### Enforced, pending a spike

Which leaves Node as the hole, and one mechanism closes it: a deny-only sandbox profile applied
through `sandbox_init` before any server is spawned. Sandbox policy is inherited across
`fork`/`exec`, so a profile applied once at app launch covers every child — a compromised dependency
inside a server cannot open a socket whatever it imports.

```scheme
(version 1)
(allow default)
(deny network*)
(allow network-outbound (literal "…/cupertino.sock"))
(allow network-bind     (literal "…/cupertino.sock"))
```

`(allow default)` is what makes this compatible with everything [distribution.md](distribution.md)
rules out for the App Store. It is **not** the App Sandbox entitlement: no container, no
`~/Library/Mail` denial, `osascript` still execs. It is a deny-only overlay of the kind browsers use
for renderer processes, and last-match-wins in SBPL is what lets the socket be carved back out.

Three things to settle before it ships:

- **A unix socket connection is `network-outbound` in SBPL**, addressed by path. A blanket
  `(deny network*)` breaks the bridge at `ServerHost.swift`, hence the explicit re-allow — which has
  to be built from the runtime socket path rather than hardcoded, since `BridgeProtocol.socketPath`
  is derived per user.
- **`sandbox_init` is deprecated SPI.** Same risk class as `responsibility_spawnattrs_setdisclaim`,
  already accepted in `native/launcher.c`, and with no App Review in the path there is no rejection
  risk. It should degrade-don't-die exactly the way that `dlsym` does.
- **Whether a custom profile disturbs TCC** — Full Disk Access, the disclaimed re-exec, Apple Events
  — is an empirical question rather than a design one. It is a spike in the shape of
  `scripts/spike-app-tcc`.

### What none of it covers

Apple Events. `send_message` and `check_for_new_mail` make **Mail.app** do network I/O on the user's
behalf, and no sandbox on Cupertino touches that. So the defensible claim is that Cupertino opens no
socket of its own — never that nothing leaves the machine. Say it first; a hostile reader finds it
in ten seconds either way.

And never cite the absence of `com.apple.security.network.client` as evidence. That entitlement
means something only inside the App Sandbox, so its absence here proves nothing at all. It is cited
wrongly often enough to be worth naming.

## Collection, and where the record lives

This table used to say "merchant of record — Paddle, Lemon Squeezy or Polar". It says Stripe now, and
the reasoning is recorded here so the swap is not read as an oversight and quietly reverted.

An MoR is bought for one thing: it becomes the legal seller and files the EU VAT. That is worth real
money in saved attention, and it is declined here for one reason — **Paddle, Lemon Squeezy and Polar
all want to be the licence authority too**, and their licence authority is an online activation
endpoint. Bending one of them into issuing an offline key that nothing ever calls back is fighting
the product to get less of it, at a higher fee. Stripe has no opinion about licensing, which is the
correct amount of opinion.

The cost is honest and recurring: selling from France to EU consumers means registering for **VAT
OSS**, filing quarterly at destination rates from the first sale, and keeping two pieces of location
evidence per transaction. Stripe Tax computes and collects; the filing is ours. If that attention
ever costs more than the fee difference, **Polar** is the escape hatch — the migration is a new
checkout URL and a webhook, because nothing in the app knows where a key came from.

### The app can never be the enforcement point

Worth stating once, because every licensing vendor's happy path violates it. `audit-network.sh` fails
the build on `URLSession`, `_nw_*`, `_CFHTTP`, `_getaddrinfo` and the TLS entry points, and the front
page sells the claim it protects. An activation call would break a green CI job **and** a shipped
promise. CryptoKit and the Keychain trip none of those symbols, so offline verification is free of
CI risk and online verification is not merely undesirable but unavailable.

The second constraint is `apps/apple/LICENSE` §1(c): anyone may already compile and run their own
build with no fee and no key. So **no effort goes into anti-tamper** — no obfuscation, no integrity
self-checks, no hardened trial storage. All of it is unenforceable by construction against an audience
that can run `make build-release` legally, and every hour spent on it is an hour not spent on the
people who paid. The deterrent is that the key carries the buyer's email and the app renders it.

### No trial, because three already exist

A time-limited trial is the standard answer to "nobody pays before they have seen it work", and it is
the wrong one here — not because the objection is weak but because it is already answered three times
over, none of them needing a clock:

- **Build it.** `apps/apple/LICENSE` §1(c) grants compiling and running your own build, on every
  machine you control, forever, with no fee and no key. It is the same program, not a crippled demo.
- **Run the servers alone.** They are MIT and on npm. They do the work; the app holds the permission.
- **Buy it and change your mind.** Thirty days, no reason required, no form.

So the refund _is_ the trial, with the payment step in front of it rather than behind. What that buys
is the deletion of an entire subsystem: no trial clock, no Keychain expiry state, no degraded mode, no
"one trial per machine" fiction to pretend to enforce, and no moment where a tool holding Full Disk
Access starts refusing to work. The licence check becomes one branch — a valid key, or not — and
[EULA §3](../apps/apple/EULA) says all of this to the buyer in the same words.

The cost is real and worth naming: someone who will not build it and will not risk €14.99 is not
reachable. At this price and this audience that is a small number, and the refund catches most of it.

### Price, and why it goes up

The ladder is published in advance and tied to **shipped surfaces**, not to the calendar:

| Price  | When           | Surfaces                                  |
| ------ | -------------- | ----------------------------------------- |
| €14.99 | launch         | Mail, Notes, Reminders, Calendar          |
| €24.99 | Messages ships | + Messages                                |
| €34.99 | Safari ships   | + Safari — the full set the probes mapped |

Calendar landed in `c740b4f`, before launch rather than after, so it sits in the opening rung rather
than buying the first rise. The table was written a commit too early; this is the correction, and the
top rung is one lower for it. A fourth at €49.99 is held rather than promised, because promising a
price for a surface nobody has built yet is the kind of schedule that gets quietly dropped.

Tying a rise to a date says latecomers pay more for the same thing, which earns resentment and teaches
people to wait for a sale. Tying it to surfaces says the price went up because the product got bigger,
which is both true and the roadmap in [surfaces.md](surfaces.md) restated as a reason to buy now.
Published as a schedule it is a price ladder, a roadmap and genuine urgency in one table.

Two rules come with it. **Every rise is announced before it happens** — a quiet increase reads as
testing on people. And **it never goes back down**: retreating from €49.99 would insult everyone who
paid it, so the ladder only ratchets.

The sour spot is the interaction with per-major pricing. Someone who buys 1.x at €14.99 meets 2.0 at
whatever the ladder reached, and [EULA §2](../apps/apple/EULA) deliberately promises them nothing.
That is honest and it will still sting at 3.3×, so the D1 row records `amount_paid` and `price_id`
from the very first sale — fair upgrade pricing later is impossible without knowing what people
actually paid, and that number cannot be reconstructed after the fact.

### The seller side is its own project

`apps/api` — a Cloudflare Worker on `api.cupertino.mgcrea.io` — rather than a route bolted onto the
marketing site. Three reasons, and they all point the same way:

- The site is static assets whose `public/_redirects` serves `/download`, the permanent URL both the
  Homebrew cask and `config.ts` depend on. Putting a script in front of that risks shadowing it, and
  the failure would be silent and total.
- `apps/website/tsconfig.json` is `include: ["**/*"]` over a Node-shaped base config. Worker code
  needs `@cloudflare/workers-types` and a bundler resolution; co-locating means fighting that or
  carving out exceptions forever.
- The signing key has no business living on the Worker that serves public HTML.

The cost is a second deploy target and a second hostname, which is why `/thanks` renders from the API
rather than the site. That is the right trade: a marketing copy edit can no longer take fulfilment
down, and fulfilment can no longer take the marketing site down.

The same format is implemented three times — `scripts/lib/license.mjs` on Node, `apps/api/src/license.ts`
against WebCrypto, and `apps/apple/Cupertino/License.swift` in CryptoKit — because none of the three
can import the others. What keeps them honest is that the signature covers the **encoded** payload
rather than the parsed object, so only bytes have to agree, and a test asserts the Worker and Node
produce byte-identical keys from identical input.

### Three stores, one job each

| Question                                  | Lives in                  | Why there                                                 |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------- |
| who paid, how much, what tax              | Stripe                    | already the system of record for money; do not rebuild    |
| which key went to whom, and is it revoked | Cloudflare D1, one table  | needed to re-send a key, and to address 1.x buyers at 2.0 |
| is _this_ Mac licensed                    | this Mac's `UserDefaults` | offline by construction; never leaves the machine         |

`UserDefaults` rather than the Keychain, which is what this table said first. The key is not a
secret — it is issued to the user, rendered in the menu bar, emailed in plain text and re-sendable on
demand — so encrypting it at rest would be ceremony, and it would make licensing the app's first
`SecItem` code for nothing gained. `SurfaceSettings.allowWrites` already reads `UserDefaults` synchronously
from the connection thread, which is exactly what the gate needs and all it needs.

**"Who has not paid" is not stored anywhere.** There is no such list. It is the absence of a valid key
on a disk we cannot see, and any design that needs the list has smuggled a phone-home back in.

D1 rather than deriving the key deterministically from the payment: derivation looks elegant until the
payload format changes once, and then no old key can be reproduced and every re-send is wrong. It also
has to be possible to ask which addresses hold a 1.x key on the day 2.0 ships, or the per-major model
has no upgrade path. One table, and it is the only state this project keeps about anyone.

Revocation lands at build time rather than run time: a refund sets `revoked_at`, `make revocations`
rewrites `apps/apple/Cupertino/Revocations.swift`, and the diff is committed like any other source
change. Generated-and-committed rather than fetched by CI, because reading D1 from the release job
would put a network dependency in the path of shipping — an outage at Cloudflare becoming an outage
in releases — and buy nothing, since a revocation cannot take effect before the next build either way. A refunded key therefore stops working at the
next update, not instantly. That asymmetry is the price of the no-network claim, it is small, and the
[EULA](../apps/apple/EULA) says so in §4(a) rather than leaving it to be discovered.

## Positioning

Every MCP connector shipping today is cloud OAuth — Gmail, Drive, Notion. This one is the opposite,
and that is the sentence:

> Your Mac's data, available to Claude, without sending it to anyone. No OAuth, no third party,
> nothing leaves the machine.

That reframes the product from "an Apple Mail plugin", which is narrow, to "the local half of MCP",
which is not. Reminders and Notes already carry more users than Mail does, and the probes in
`scripts/` for Messages, Calendar and Safari are the roadmap that keeps making the claim truer.

Selling it also raises the stakes on the Apple association. Naming the apps it drives is nominative
use and fine; the unaffiliated disclaimer stays prominent and the icon stays well clear of anything
Apple-shaped.

## Not decided

- **Whether the menu bar should nag beyond the one status line.** It currently states the fact and
  stops, which may be too quiet for something that is refusing to work.
- **Whether upgrade pricing exists at 2.0.** Not promised, and deliberately left open — but the data
  needed to offer it is being recorded from the first sale.
- Whether the servers ever need a second licence. They do not today.

Decided, and recorded above so they are not re-opened: one-time per major version, Stripe rather than
a merchant of record, offline validation as a constraint rather than a preference, no trial at all,
a surface-tied price ladder from €14.99, and the succession commitments in [succession.md](succession.md).

And the honest expectation, recorded so it is not mistaken for a forecast: macOS only, developer
audience, MIT core. This is a modest revenue line and a strong reputation asset, not a business. The
lever on that is surfaces rather than price — Messages and Calendar are what turn a Mail thing into
the local connector layer.
