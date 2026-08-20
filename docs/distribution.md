# Distribution

How this ships, and why it is not on the App Store.

## Short version

The App Store cannot carry this server: a Mac App Store binary is sandboxed, the sandbox denies
`~/Library/Mail` regardless of Full Disk Access, and that removes the index and body lanes
outright. The route that works is a Developer ID signed, notarized `.app`.

Since Full Disk Access is a single indivisible grant, that app covers **all** the Apple surfaces
rather than one per surface. It is called **Cupertino**.

## Why not the App Store

Settled. Recorded so it is not re-opened.

1. **The sandbox is mandatory, and Full Disk Access does not lift it.** Every Mac App Store binary
   carries `com.apple.security.app-sandbox`. Sandbox policy and `kTCCServiceSystemPolicyAllFiles`
   are evaluated independently — the sandbox denies `~/Library/Mail` whatever the user granted, and
   no App Store-available entitlement reads another app's TCC-protected data. The index lane and
   the body lane are impossible, not merely harder.
2. **What survives is already benchmarked unusable.** Only the Apple Events lane would remain, and
   [verify.md](verify.md) puts `messages whose read status is false` at 74 seconds.
   Searching cannot go through Apple Events; that is the whole reason the index lane exists.
3. **The launcher is disqualifying twice over.** `responsibility_spawnattrs_setdisclaim` is
   undocumented SPI reached through `dlsym`, and private API use is a rejection. Its purpose —
   escaping the responsible-process chain to get an independent TCC identity — is what App Review
   exists to stop.
4. **A sandboxed app cannot exec `/usr/bin/osascript`**, which is the only subprocess in the
   runtime. The AppleScript lane would have to be rewritten onto in-process `NSAppleScript`.
5. **Shipping the server _inside_ a store app fails separately.** A store app is a self-contained
   bundle that installs nothing into shared locations; the MCP host would remain the responsible
   process for TCC, which is the exact problem the launcher was written to solve; and the app
   cannot write `~/Library/Application Support/Claude/claude_desktop_config.json` from inside its
   container.
6. **MailKit is not a way round it.** `MEExtension` is the sanctioned route into Mail, but it
   covers compose sessions, message actions, content blocking and message security. It cannot
   enumerate or search a mailbox.

Apple Events to Mail _is_ shippable on the store, via
`com.apple.security.temporary-exception.apple-events`. That buys point 2 and nothing else.

## One app, many servers

Full Disk Access is not divisible. A grant for mail is already a grant for Messages, Safari
history and SSH keys — so granting it once per surface buys no containment at all, and costs the
user a System Settings trip each time. One grant covering every surface is both less work and a
more honest description of what was granted.

The fixed costs point the same way. A signing certificate, a notarization pipeline, CI secrets, an
icon, a Homebrew cask and an update channel are paid once per bundle, not once per server.

And the bundle identifier is the most expensive string in the project: changing it is a new TCC
identity, so every existing user re-grants Full Disk Access. It has to be right before the first
release, which is why the multi-surface decision could not wait.

**The servers stay separate, though.** One combined server would put every surface's tools into
the host's context whether or not you use Notes; hosts already enable servers individually; and
write tools against Mail and against Reminders are not the same risk.

|                   |                                                             |
| ----------------- | ----------------------------------------------------------- |
| App display name  | Cupertino                                                   |
| Bundle identifier | `io.mgcrea.cupertino`, Magenta Creations (`75QE9PRT3V`)     |
| Repo              | `mcp-cupertino`, a monorepo absorbing this one              |
| npm packages      | unchanged — `@mgcrea/mcp-apple-mail`, `-notes`, `-messages` |
| Transport         | stdio, unchanged                                            |

The names are split on purpose. `mcp-apple-mail` is what people search npm for, so the packages
keep it. The app does not: its name shows up in the Full Disk Access list next to real Apple rows,
and "Apple MCP" sitting there would undercut the README's first line.

## Repo layout

```text
mcp-cupertino/
  packages/core/       @mgcrea/mcp-apple-core
  packages/mail/       @mgcrea/mcp-apple-mail   ← this repo, history preserved
  packages/notes/
  packages/messages/
  packages/reminders/
  app/                 the Cupertino.app build
```

`packages/core` exists, and holds only mechanism with more than one plausible consumer:

| Module         | What                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `osascript.ts` | the runner, the serialising queue, `assertStaticScript`, `mapOsaError`           |
| `errors.ts`    | the taxonomy, written against a required `SurfaceContext`                        |
| `fs.ts`        | `inspectFile` / `describeStore` — the exists-vs-readable distinction             |
| `sqlite.ts`    | the `ro` -> `immutable` ladder, `toFileUri`, `escapeLike`, `PRAGMA query_only`   |
| `schema.ts`    | `columnsOf`, `tableMap`, `fingerprintSchema`, `detectEpoch`, the Core Data epoch |
| `config.ts`    | the four env parsers and `BaseConfigSchema`                                      |
| `tools.ts`     | `wrap`, `toFailure`, `ok`/`okText`/`fail`, `compact`, `limitArg`, `confirmArg`   |
| `cli.ts`       | `runStdioServer`, carrying the stdout-is-JSON-RPC rule and the darwin guard      |

The strongest argument was never line count: `assertStaticScript` is a shell-injection tripwire and
the queue is the `-1712` guard, and an invariant kept in two copies is one refactor away from being
enforced in one.

**Deliberately left in `packages/mail`**, because they are structurally Mail-shaped and an interface
designed from one sample would be wrong: `locateEnvelopeIndex`'s four-branch strategy ladder,
`ref.ts` (whose `#(\d+)$` assumes an integer id that Notes' `x-coredata://` ids are not), the JXA
`PRELUDE`, and the diagnostics payload.

Two defects were fixed rather than copied across:

- `TccDeniedError` took an optional `hint` defaulting to "Mail", hardcoded "Mail" again later in the
  same string, and was never passed a hint at either call site. `SurfaceContext` is now **required**
  wherever it appears in a message, so it cannot silently go missing again.
- `degraded()` in `tools/util.ts` had no call sites — every one inlined the shape. Deleted rather
  than promoted: an unused helper in a shared package is API nobody honours.

## The bundle

Built by `make bundle`. As shipped:

```text
Cupertino.app/Contents/
  Info.plist                      io.mgcrea.cupertino, LSUIElement, NSAppleEventsUsageDescription
  MacOS/Cupertino                 the SwiftUI menu bar app — holds FDA and Automation
  Helpers/cupertino-bridge        stdin <-> unix socket relay, touches nothing protected
  Resources/node                  from nodejs.org, universal
  Resources/servers/<id>/package.json
  Resources/servers/<id>/dist/cli.js
  Resources/servers/mcp-<hash>.js shared SDK chunk
```

**The launcher is gone, and with it the private SPI.** `scripts/spike-app-tcc` measured what the
order of work below asked for: Full Disk Access and Automation granted to a signed `.app` are
inherited by the processes it spawns, two levels deep — a `node` grandchild reads the Envelope
Index, and `tccd` resolves a grandchild `osascript` to `io.mgcrea.cupertino`, not to whatever
launched it. So there is nothing to escape, and `responsibility_spawnattrs_setdisclaim` is no
longer needed. `native/launcher.c` stays in the repo as the clearest statement of the
responsible-process problem, but it is not shipped.

What an MCP host spawns instead is `cupertino-bridge`, which copies bytes between stdin and a unix
socket and opens no protected path at all. Its own TCC identity is therefore irrelevant. It
launches the app **by path**, derived from its own location inside the bundle, rather than by
bundle identifier — `open -b` asks LaunchServices to choose among every registered copy, and during
development it chose a stale one out of DerivedData.

**The closed table survived the move.** `ServerHost` validates the requested surface against
`Surface.all`, a table fixed at compile time, exactly as the launcher compiled its paths in: a
caller names a surface, never a path, so this cannot become a
read-anything-with-my-permissions gadget.

**Node comes from nodejs.org, not Homebrew.** The official darwin builds are a single
self-contained binary; Homebrew's is not, which is why `scripts/spike-launchd-fda.sh` had to
symlink `libnode.137.dylib` next to its copy. Embedding it also pins the `node:sqlite` requirement.
Universal costs about 240 MB of the bundle; `make bundle NODE_ARCHS=arm64` halves it while
iterating.

**The servers are bundled, not copied from `dist/`.** Each package's own `tsdown.config.ts` leaves
dependencies external, which is right for npm and fatal here — there is no `node_modules` inside
the bundle for `@modelcontextprotocol/sdk` to resolve against. `app/tsdown.servers.config.ts`
inlines everything instead.

The `package.json` + `dist/cli.js` shape mirrors an installed package on purpose.
`build-info.ts` reads its version from `new URL("../package.json", import.meta.url)`; with a flat
`servers/<id>/cli.js` that resolves to one shared `servers/package.json`, which cannot carry two
different versions — and diagnostics reported `0.0.0` until the layout changed. The same config
re-applies the `__GIT_COMMIT__` substitution, without which the commit field reads `unknown`, which
is the one thing it must never say in a bug report.

**Full Disk Access binds to the bundle identifier and signing certificate, not the path.**
Measured in `scripts/spike-app-tcc`: an earlier version of this claim said the opposite — that a
grant is denied the moment the bundle moves — and it was wrong, an artifact of testing a copy of an
app that had already lost its own grant. The controlled result: `make install` moved a granted build
from `app/.build` to `/Applications` and the grant followed it, no re-prompt. `InstallLocation`
therefore only warns that a _bridge path_ written into another app's config will break if the bundle
moves or is deleted — never that a permission is at risk.

## Signing and notarization

Inner-out, hardened runtime throughout.

1. Sign the bundled `node` with `--options runtime` plus `com.apple.security.cs.allow-jit` and
   `com.apple.security.cs.allow-unsigned-executable-memory`. V8 needs both.
2. Sign the launcher, then the bundle: `--options runtime --timestamp`, Developer ID Application.
3. `ditto -c -k --keepParent` → `xcrun notarytool submit --wait` → `xcrun stapler staple`.

Universal on both binaries: `lipo` the two Node downloads, and build the launcher
`-arch arm64 -arch x86_64`.

Distribute the stapled zip and a Homebrew cask. In CI, add a macOS release job on `v*.*.*`
alongside `publish-npm` — import a base64 p12 into a temporary keychain, notarize with an App Store
Connect API key, attach the stapled zip to the GitHub release. The existing `-Werror` launcher
compile stays a PR check.

## What this does to the permission story

Today Automation is granted to whatever launched the server — VS Code, Terminal, Claude — and only
Full Disk Access lands on the launcher. Inside a bundle that should change: after the disclaimed
re-exec the app is the responsible process for its whole subtree, `osascript` included, so
**Automation moves onto Cupertino too**, as one row per target (`com.apple.mail`,
`com.apple.Notes`, `com.apple.reminders`), with `NSAppleEventsUsageDescription` supplying the
prompt text.

If that holds, a lot of prose is wrong and has to be rewritten: the Permissions table in the
README, the `howToGrant` array in `src/tools/diagnostics.ts`, the FDA `reason` in
`src/client/locate.ts`, the `TccDeniedError` message in `src/client/errors.ts`, and the degraded
hints in `src/tools/search.ts` and `src/tools/messages.ts` — whose exact wording
`test/tools.test.ts` asserts on.

**Measure before rewriting any of it.** If Automation stays with the host, only the Full Disk
Access strings change.

## The other surfaces

Probed on macOS 26.6 (build 25G72). Every store below **exists but cannot be listed** — `ls`
returns `Operation not permitted` while `test -e` succeeds, the same split `src/client/locate.ts`
documents for Mail. Which is the point: nothing about their internals can be measured until Full
Disk Access is granted to something.

| Surface   | Store                                                   | Probe  | AppleScript lane             |
| --------- | ------------------------------------------------------- | ------ | ---------------------------- |
| Mail      | `~/Library/Mail/V10/MailData/Envelope Index`            | EPERM  | full — implemented           |
| Notes     | `~/Library/Group Containers/group.com.apple.notes/`     | EPERM  | usable alone below ~5k notes |
| Reminders | `~/Library/Group Containers/group.com.apple.reminders/` | EPERM  | workable                     |
| Messages  | `~/Library/Messages/`                                   | EPERM  | send only, no reads          |
| Contacts  | `~/Library/Application Support/AddressBook/`            | EPERM  | limited                      |
| Calendar  | `~/Library/Calendars`                                   | absent | slow                         |

Two paths that are commonly cited and wrong on this machine: **`~/Library/Reminders` does not
exist** — Reminders is under Group Containers — and neither does `~/Library/Calendars`, so Calendar
probably needs EventKit rather than a file lane. Everything about the schemas behind these stores
is unverified. Notes is the exception — it has since been probed, and its bodies turned out
**not** to be the gzipped protobuf they are reputed to be.

Messages is the surface where Full Disk Access is not optional: there is no AppleScript read path
at all, so without the file lane there is no server.

Each new surface starts with a phase-0 probe in the style of `scripts/probe-envelope-index.mjs` →
`docs/envelope-index.md`. That is the only way to learn one of these schemas, and writing the probe
output down is what makes the queries defensible later.

### Notes, measured

Probed — see [notes.md](notes.md). At 921 notes Apple Events search runs in **97 ms**, against the
74 s that forced Mail onto its index lane, so Notes is genuinely shippable without Full Disk Access
on a small library. But the lane has no index and pays the full cost on every query, so the
projection puts the wall at roughly 5–10k notes. Notes gets two lanes like Mail; what differs is
that it can ship on the fallback and add the file lane after.

The pure capability gain — the thing Apple Events cannot do at any speed — is **attachment bytes**:
the dictionary exposes `URL` and `content identifier` but no filesystem path, so contents require
reading `Accounts/<uuid>/Media/`.

### Every surface gets a fallback

Two lanes is the default shape, not Mail's special case:

| Surface  | File lane                     | Apple Events fallback            |
| -------- | ----------------------------- | -------------------------------- |
| Mail     | required — search is 74 s     | accounts, mailboxes, all writes  |
| Notes    | attachments, then scale       | **fully usable** below ~5k notes |
| Messages | required — no read API exists | none possible                    |

Three reasons this is the default rather than a per-surface optimisation:

- **Try before you grant.** Someone can install the app and use it before deciding to hand over
  whole-disk access. That is the honest way to ask for a permission this large, and it means the
  Apple Events lane has to stay a first-class path rather than become dead code once the file lane
  lands.
- **Consistency.** One shape — file preferred, Apple Events fallback, diagnostics naming which is
  live — lives once in `packages/core` instead of being re-litigated per surface.
- **Scale.** Every unprivileged lane is per-item over Apple Events, so all of them degrade the same
  way on a large library. Messages is the reminder that some surfaces have no fallback at all.

**What this does not change:** the permission still has to buy something. Notes reads
`Accounts/<uuid>/Media/` for attachments and, when a library is large enough to need it, the index
for search — but a server that needs neither is still spawned as plain `node` against the bundled
runtime rather than through the launcher. The closed table lists only servers that genuinely use
the grant, which is the smallest honest answer to "what did I just give Full Disk Access to".

## Order of work

0. **Test the assumption everything rests on**: does a disclaimed _bundled_ main executable get the
   bundle's TCC identity — `io.mgcrea.cupertino` with a team-based designated requirement — rather
   than a content-hash one? The grant-survives-updates payoff depends entirely on it, and it is
   cheap to check.
1. Monorepo migration, `packages/core` extraction.
2. Bundle, sign, notarize — Mail only.
3. Ship. Then the second surface.

## Risks

- **The disclaim SPI is still private.** No worse than today, and `native/launcher.c` already
  warns to stderr and runs the server without it. `scripts/spike-launchd-fda.sh` is the measured
  fallback: a LaunchAgent gets its own Full Disk Access identity too.
- **Quarantine on first exec.** The app is spawned by an MCP host and may never be opened by the
  user. Stapled notarization should satisfy Gatekeeper — test it on a machine that has never seen
  the bundle, because if it does not hold, the double-click path stops being a nicety.
- **Scope.** Mail is at 0.1.0 and not yet published; `.release-it.json` still has
  `npm.publish: false`. This document plans four surfaces. Step 2 above deliberately ships one.
