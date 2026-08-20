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
| `app/`           | source-available | readable and buildable for yourself, binary rights reserved |
| the signed build | sold             | the notarized artifact, the update channel, the maintenance |

"Build it yourself if you would rather not pay" is an honest position and a defensible one. Most
people will pay rather than install Xcode, and the ones who will not were never customers.

**There is no `LICENSE` file today** — only `"license": "MIT"` in the package manifests, which says
nothing about `app/`. That ambiguity is the worst state for both halves and is the first thing to
fix, whichever way the app licence lands.

## What is actually being sold

Not the tools. They are MIT, and a `.mcp.json` pointing at `node dist/cli.js` stays free forever.

What is sold is what [distribution.md](distribution.md) already argues for: **one Full Disk Access
grant, held by a notarized binary from an identifiable developer**, instead of four grants handed
out to whichever editors happened to spawn a server. The alternative a user faces today is granting
whole-disk access to Cursor, Claude Desktop, VS Code and Terminal separately — four System Settings
trips, four processes that can now read their SSH keys.

Convenience sits on top and is real but secondary: no absolute paths, the host config written for
you, the writes toggle, the log pane.

|            |                                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| Model      | one-time, bounded update window — no backend exists to justify a subscription |
| Collection | merchant of record — Paddle, Lemon Squeezy or Polar; they file the EU VAT     |
| Validation | offline, signed licence key, verified locally, no phone-home                  |
| Trial      | full features, time-limited                                                   |

**Writes are not the paywall.** Gating them behind the licence would make the free tier the safe one
and the paid tier the dangerous one — backwards as a sales message and worse as a default.
`allowWrites` is a safety control and stays one.

Offline validation is not a nicety either. A privacy tool that calls a licensing server on launch
contradicts its own pitch, and the next section is why that matters more than usual here.

## Three claims worth more than the licence

1. **The app makes no network connections.** There is no `URLSession`, no Sparkle and no HTTP
   anywhere in `app/Cupertino` or `app/CupertinoBridge`. The one socket in the codebase is
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
`sockaddr_in` appear nowhere in `app/`. A socket that never names an internet address family is not
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

- The exact app licence text. It has to permit personal builds and forbid binary redistribution
  without making auditing awkward.
- Whether anything beyond the trial is free.
- Price.
- Whether the servers ever need a second licence. They do not today.

And the honest expectation, recorded so it is not mistaken for a forecast: macOS only, developer
audience, MIT core. This is a modest revenue line and a strong reputation asset, not a business. The
lever on that is surfaces rather than price — Messages and Calendar are what turn a Mail thing into
the local connector layer.
