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

| Part               | Licence          | Why                                                          |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `packages/*`       | MIT              | libraries; ecosystem adoption is the funnel; vendor freely   |
| `app/`             | source-available | readable and buildable for yourself, binary rights reserved  |
| the signed build   | sold             | the notarized artifact, the update channel, the maintenance  |

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
   the one user, carrying stdio between the app and its own servers. Nothing in the bundle can
   reach the network at all. For a process holding Full Disk Access that is a strong claim, and a
   cheap one for anyone to verify — Little Snitch, thirty seconds — so it belongs on the front page
   rather than in a footnote. It is also a **constraint**: adding an update check makes it false, so
   if Sparkle ever lands it becomes the single documented exception and the claim gets reworded, not
   quietly dropped.

   The servers under it speak stdio and Apple Events and nothing else. `send_message` is not a
   counter-example: Mail.app does the sending, over the connection it already had.

2. **Reproducible builds and published checksums.** Open source closes the gap between what the
   source says and what the binary does only if the two are known to correspond. Publish the hash of
   the signed build and the command that reproduces it; otherwise the audit stops at the tarball.

3. **A written succession policy.** The bundle identifier is the most expensive string in the
   project, and distribution.md records why: changing it is a new TCC identity, so every user
   re-grants. The flip side is the dangerous one — *keeping* it lets a new owner inherit every
   existing user's Full Disk Access silently, on an ordinary update, with no prompt. That is
   precisely the Bartender mechanism. Stating in advance what happens to `io.mgcrea.cupertino` if
   this is sold, abandoned or handed on costs nothing, and no competitor bothers.

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
