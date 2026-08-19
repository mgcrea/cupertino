# Cupertino

MCP servers for the Apple apps already on your Mac, and the signed app that grants them their
permissions once instead of once each.

> **Unofficial.** Not affiliated with Apple. These drive the apps that are already on your Mac.

## Packages

| Package                                       | Status                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| [`packages/mail`](packages/mail) — Apple Mail | implemented — search, read, attachments, and gated writes |
| Notes, Reminders, Messages                    | not started; Notes has finished [phase 0](docs/notes.md)  |

Each surface is its own server and its own npm package, so a host loads only the tools it wants.
They share one bundle and one Full Disk Access grant, which is the whole reason they live together
— see [docs/distribution.md](docs/distribution.md).

## Why a single app

Full Disk Access is one indivisible whole-disk grant. Granting it per surface buys no containment
and costs a System Settings trip each time, so every surface ships inside one signed, notarized app
called Cupertino. That document also records why the Mac App Store cannot host any of this, so the
question does not get re-opened.

## Documentation

|                                                  |                                               |
| ------------------------------------------------ | --------------------------------------------- |
| [docs/distribution.md](docs/distribution.md)     | how this ships, and why not the App Store     |
| [docs/notes.md](docs/notes.md)                   | Apple Notes phase-0 measurements              |
| [docs/envelope-index.md](docs/envelope-index.md) | Mail's observed `Envelope Index` schema       |
| [docs/verify.md](docs/verify.md)                 | checking the Mail server against a real index |

## Working on it

```bash
pnpm install
pnpm build          # every package
pnpm test           # every package
pnpm typecheck
pnpm lint
pnpm format
```

Phase-0 probes are repo-wide and read-only. They need the permission of the surface they measure,
and redact their output to counts, timings and DDL:

```bash
pnpm probe:mail     # Envelope Index — needs Full Disk Access
pnpm probe:notes    # Notes — the Apple Events half runs without it
```

Releases are tagged per package, so a tag names what it publishes: `mail-v0.1.0`.

> The directory is still called `mcp-apple-mail` from when Mail was the only surface. Renaming it
> is cosmetic and pending; the bundle identifier `io.mgcrea.cupertino` is the string that actually
> matters, because changing it would invalidate every user's Full Disk Access grant.
