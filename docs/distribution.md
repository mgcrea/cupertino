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
icon, a Homebrew cask and an update channel are paid once per bundle, not once per server. Two of
those are now paid: the notarization pipeline in 1.0.0, the update channel in 1.1.0.

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
  packages/core/        @mgcrea/mcp-apple-core
  packages/mail/        @mgcrea/mcp-apple-mail   ← this repo, history preserved
  packages/notes/
  packages/reminders/
  packages/contacts/    implemented
  packages/messages/    implemented
  apps/apple/           the Cupertino.app build
  apps/website/         the marketing site
  design/               the one mark, and what `make icon` generates from it
  docs/                 this
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
the bundle for `@modelcontextprotocol/sdk` to resolve against. `apps/apple/tsdown.servers.config.ts`
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
from `apps/apple/.build` to `/Applications` and the grant followed it, no re-prompt. `InstallLocation`
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

**Built, since 1.0.0.** The `release-app` job in `.github/workflows/ci.yml` runs on `app-v*` rather
than the `v*.*.*` this originally proposed, because the monorepo tags per artifact: it imports a
base64 p12 into a temporary keychain, notarizes with an App Store Connect API key, verifies the
artifact and attaches the stapled zip plus its SHA-256 to the GitHub release. The `-Werror` launcher
compile stayed a PR check.

**The update channel is built too, since 1.1.0**, and it is the one piece of this that changed a
published claim rather than merely adding a job — see [licensing.md](licensing.md). Sparkle, checks
off unless asked for, a static EdDSA-signed `appcast.xml` attached to each release and reached
through `cupertino.mgcrea.io/appcast.xml`. No server: the signature is what makes the hosting
untrusted, so a static file on GitHub is sufficient.

**The Homebrew cask is built, since 1.1.0.** `mgcrea/homebrew-tap` exists and
`brew install --cask mgcrea/tap/cupertino` — which `apps/website/src/config.ts` had been advertising
against a tap that did not exist — now works. It mattered more than it looked: it is the only
channel that can move a 1.0.0 install forward, since 1.0.0 shipped with no updater in it.

Two things the cask gets right and are easy to get wrong. It pins
`.../download/app-v#{version}/Cupertino.zip` rather than `/releases/latest/download/`, so a package
release cannot redirect it; and `livecheck` is anchored to `^app[-/]v?`, because the tag glob in this
monorepo would otherwise offer a `core-v*` release as an app update. `auto_updates true` keeps brew
and Sparkle from racing to replace the same bundle: brew is the install channel, Sparkle owns the
copy afterwards.

The bump is automatic but not unconditional — the `release-app` job skips it with a notice when
`HOMEBREW_TAP_TOKEN` is unset, so a silently stale cask looks exactly like a successful release.

### The version number, and where it lives

**The root `package.json` version is the source**, and every other copy is generated from it by
`make version`. `make version-check` fails on drift and runs in CI, the same contract
[surfaces.json](surfaces.md) gets. The copies:

| File                         | Form                                            |
| ---------------------------- | ----------------------------------------------- |
| `packages/*/package.json`    | the published `version`, all in lockstep        |
| `apps/website/src/config.ts` | `APP_VERSION`, shown in the nav and the JSON-LD |
| `README.md`, `CHANGELOG.md`  | the tag examples                                |
| `CHANGELOG.md`               | a `## [x.y.z]` section — checked, never written |

This exists because the number was hand-kept in eleven places and the 1.2.1 and 1.2.2 release
commits bumped ten of them. The one they missed was `APP_VERSION`, so the site announced 1.2.0 for
two releases — the only copy of the number a visitor ever reads.

The `app-v*` tag stays authoritative about what people are RUNNING: nothing bumps
`MARKETING_VERSION` in the pbxproj and CI overrides it from the tag name. It cannot be what the
files are generated from, though — they have to be right in the commit the tag points AT, and the
site builds from a shallow clone with no tags. So the `release-app` job checks the other direction
and refuses to build when `app-v$X` points at a commit whose root version is not `$X`. Cutting a
release is: bump the root version, `make version`, write the CHANGELOG section, commit, tag.

**Push the tags one at a time, or dispatch them by hand.** GitHub creates no workflow runs at all
when more than three tags arrive in a single push, and it reports nothing — `git push` succeeds,
ten tags appear on the remote, and the Actions tab stays empty. Nothing in this repository can
detect that; it looks exactly like a release that has not started yet. The 1.3.1 round hit it and
the evidence is still in the run history: `core-v1.3.1` is a `push` event and the other eight are
`workflow_dispatch`, because they had to be re-triggered by hand. 1.4.0 hit it again with all ten.

Either push each tag separately, or push them together and then dispatch each one:

```sh
for t in core calendar contacts mail maps messages notes reminders safari app; do
  gh workflow run ci.yml --ref "$t-v$VERSION"
done
```

`workflow_dispatch` against a tag ref is not a workaround with different behaviour: `github.ref` is
`refs/tags/<tag>` either way, so every `startsWith(github.ref, 'refs/tags/')` guard in the release
jobs holds and the same jobs run. Dispatch `core` first and let it finish — the surface packages
depend on `@mgcrea/mcp-apple-core@^$VERSION`, and publishing them first leaves a window where that
dependency does not resolve.

`DemoSeed.swift`'s `version` is deliberately not generated. It is the number the marketing images
show, and tying it to the release would churn the golden-image gate on every tag and claim a version
before the store listing showing it had caught up. Bump it when new images are wanted.

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

| Surface   | Store                                                            | Probe | AppleScript lane                 |
| --------- | ---------------------------------------------------------------- | ----- | -------------------------------- |
| Mail      | `~/Library/Mail/V10/MailData/Envelope Index`                     | EPERM | full — implemented               |
| Notes     | `~/Library/Group Containers/group.com.apple.notes/`              | EPERM | usable alone below ~5k notes     |
| Reminders | `~/Library/Group Containers/group.com.apple.reminders/`          | EPERM | workable                         |
| Messages  | `~/Library/Messages/chat.db` — **implemented**                   | EPERM | none — measured, see below       |
| Contacts  | `~/Library/Application Support/AddressBook/` — **implemented**   | EPERM | own TCC grant, not FDA           |
| Safari    | `~/Library/Safari/History.db` — **implemented**                  | EPERM | live tabs only, no history       |
| Calendar  | `…/group.com.apple.calendar/Calendar.sqlitedb` — **implemented** | EPERM | too slow — 3.4 s at 1,349 events |

Two paths that are commonly cited and wrong on this machine: **`~/Library/Reminders` does not
exist** — Reminders is under Group Containers — and neither does `~/Library/Calendars`.

**An earlier version of this document drew the wrong conclusion from that second one**, and the
correction is worth stating rather than quietly fixing. It read the absence of `~/Library/Calendars`
as evidence that Calendar "probably needs EventKit rather than a file lane". But
`~/Library/Group Containers/group.com.apple.calendar` **exists and returns `Operation not
permitted`** — the same EPERM signature every other row here carries, and the exact
absent-vs-unreadable split `packages/core/src/fs.ts` was written to keep apart. The premise was
right; only one of the two candidate paths had been checked. `group.com.apple.contacts` exists too.
**Since measured, and settled** — see [calendar.md](calendar.md). `Calendar.sqlitedb` is there,
4.9 MB, opening read-only in about a millisecond, with `CalendarItem.UUID` holding the Apple Events
`uid` exactly (198 of 198 sampled). Calendar does not need EventKit, so `apps/apple/` stays a pure
broker.

The table's unsourced "slow" was measured too, and it holds badly: a ±90-day range query takes
**3.4 s over 1,349 events**, `whose` is worse and unstable, and every per-property bulk fetch costs
~2 s whichever property it is. Calendar is the first surface where the Apple Events lane cannot carry
the product — it needs the file lane for SPEED, not capability, which is the reverse of Reminders.

Safari has since been probed too — see [safari.md](safari.md). It is the odd one out: its two lanes
see almost DISJOINT things, so neither is a fallback for the other, and it needs a third permission
state (Safari's "Allow JavaScript from Apple Events" toggle) that `Permissions.swift` does not
model.

Messages is the surface where Full Disk Access is not optional: there is no AppleScript read path
at all, so without the file lane there is no server. **This is now measured rather than read off the
dictionary** — see [messages.md](messages.md). Every read attempt failed, and Messages answers
"Application isn't running" to Apple Events even while it is running. The consequence is that "try
before you grant" below cannot be honoured for this surface: every other server degrades without the
grant, Messages simply does not exist without it.

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

### Lane policy: the file lane reads, Apple Events writes

**Revised after probing Reminders, Messages, Calendar and Safari.** The original policy made two
lanes the default shape everywhere and kept the Apple Events lane as a first-class _read_ path. The
measurements do not support that. What they support is below.

| Surface   | Apple Events read      | Per item | File lane          | AE reads viable? |
| --------- | ---------------------- | -------- | ------------------ | ---------------- |
| Mail      | 74 s search            | —        | index, required    | no               |
| Calendar  | 3,355 ms / 1,349       | ~2.5 ms  | 1 ms to open       | no               |
| Messages  | none exists            | —        | only door          | impossible       |
| Contacts  | fast, but cannot index | ~0.15 ms | 0 ms, plural       | no — see below   |
| Safari    | disjoint, not slower   | —        | the past only      | n/a — see below  |
| Notes     | 97 ms / 921            | 0.105 ms | attachments, scale | **yes**          |
| Reminders | dictionary is complete | —        | tags, attachments  | **yes**          |

Apple Events is a viable read path on two surfaces out of seven. So:

- **Reads go through the file lane.** For a new surface, do not build an Apple Events read lane at
  all. Messages, Calendar and Contacts get file-lane reads and nothing else. Calendar
  shipped on exactly that shape and it held: no `jxa/read.ts` exists in `packages/calendar`, and a
  test asserts it never will. Contacts is the sharper case, and the reason the rule is about
  CAPABILITY rather than speed: its dictionary answers in ~65 ms, comfortably fast, and is still
  useless for the one thing the surface exists to do. Resolving a phone number means a suffix-keyed
  index over every stored number, and no quantity of round trips produces one.
- **Writes go through Apple Events, always.** Not a preference: `PRAGMA query_only` is set because
  the app owns the store, holds it open and reconciles it against a server, so writing to it corrupts
  sync state. Every write verb on every surface is an Apple Event.
- **Safari is the one exception, and it is an exception to the REASON rather than to the rule.**
  `packages/safari` ships an Apple Events READ path — `apple_safari_list_tabs` — and that does not
  breach the policy above, because the policy forbids a slow Apple Events lane that DUPLICATES a
  fast file lane. Safari's does not duplicate anything. Its two lanes see almost disjoint things:
  the file lane holds every visit ever made and cannot see the tab in front of you, because Safari
  never writes open tabs to disk. There is no question the tabs lane answers more slowly than the
  store; there is a question only it can answer, at 95–1,482 ms.

  The test for a future surface is therefore not "is Apple Events fast enough" but "does the file
  lane already answer this". Where the answer is no — and it is no exactly once so far — an Apple
  Events read is a capability rather than a shortcut. `packages/safari` still has no
  `jxa/history.ts`, and a test asserts it never will.

- **Live state goes through Apple Events.** Safari is the sharp case — only **60.7%** of open tabs
  resolve to a history row, so the lanes genuinely see different things and "what is open right now"
  has no file-lane answer at any speed.
- **Keep the Notes and Reminders read lanes.** They are already written, and they are the drift
  insurance. The file lane is reverse-engineered and unversioned — `SchemaDriftError` exists because
  it is expected to break. A scripting dictionary is a published contract that survives a column
  move, so when a macOS release reshuffles a store, one surface degrades instead of dying.

Consistency still holds, in a narrower form: one shape — file lane preferred, Apple Events for writes
and live state, diagnostics naming which is live — lives once in `packages/core` rather than being
re-litigated per surface.

#### Retiring "try before you grant"

The original policy rested on it: someone could install the app and use it before handing over
whole-disk access, which is what made the Apple Events lane a first-class path rather than dead code
once the file lane landed.

**The measurements retired it, and it should stop being claimed.** It held for Notes (97 ms) and
holds for Reminders. It never held for Messages, which has no read path at all. And it does not hold
for Mail or Calendar: a 74-second search and a 3.4-second range query are not a trial, they are a
broken product that happens to return the right answer. A promise three of eight surfaces cannot
keep is worse than no promise.

What replaces it is narrower and true: **with writes off, a surface needs no Automation grant at
all.** `allowWrites` is off by default, so someone who never enables writes gets zero Automation
prompts for Messages, Calendar and Safari — just the one Full Disk Access grant the bundle already
shares. That is a better permission story than the one being retired, and the strongest argument for
file-first.

Messages is now the cleanest demonstration of it, having been the counter-example when this was
written. Its send lane made `usesAppleEvents` true, and the surface still sends no Apple Event in its
default configuration — because on that surface Apple Events can ONLY write. There is no read to
leak through the gate, which is what makes the claim structural rather than a matter of discipline.

The cost, stated plainly: **Full Disk Access becomes load-bearing for everything.** Nothing works
before the largest grant. That was already true for Messages; this extends it to the rest.

**What this does not change:** the permission still has to buy something. The closed table in
`Surfaces.swift` lists only servers that genuinely use the grant, which is the smallest honest answer
to "what did I just give Full Disk Access to".

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
- **Scope.** Settled since 1.1.0: core and every bundled surface — seven of them as of 1.2.0 — are
  in scope to publish, versioned with the app rather than on their own count. `.release-it.json`
  keeps `npm.publish: false` deliberately — release-it bumps and tags, and the `publish-npm` job
  does the publishing, so a release cannot happen from a laptop without provenance.

  **All eight are on npm at 1.3.0 as of 2026-08-26**, which closes a gap this section tracked from
  1.1.0. Two of them got there the wrong way, and that is the part worth keeping.

  **Three things the 1.3.0 round taught.** First, npm's OIDC trusted publishing cannot be configured
  for a package that does not exist yet, so a brand-new name fails the token exchange with a 404 and
  then falls through to an unauthenticated `PUT` that 404s again — which is exactly how `-messages`
  and `-safari` failed while five siblings succeeded in the same round. The `0.0.0-bootstrap`
  placeholder exists to break that circle: publish it once by hand under a `bootstrap` dist-tag
  (never `latest`, or `npm i` serves a stub), configure the trusted publisher, and every release
  after that goes through CI.

  Second, and the reason the rule above is worth defending: `-messages@1.3.0` and `-safari@1.3.0`
  were published from a laptop rather than bootstrapped, and therefore **carry no provenance
  attestation**. npm will not let a version be republished, so neither build can be fixed — only the
  next release restores it. That is the failure `npm.publish: false` is there to make impossible,
  and it happened anyway the moment a publish was run by hand.

  Third, a diagnostic trap: **a newly published package 404s on the read path for several minutes**
  while its tarball is already fetchable. `npm view` and the packument endpoint both said `-safari`
  did not exist well after it did, which is how it collected a redundant `0.0.0-bootstrap` published
  _after_ its 1.3.0. When checking whether a fresh publish landed, ask
  `/-/package/<name>/dist-tags` or HEAD the tarball URL; do not trust `npm view`.

  **Fourth, and the one that cost the most: `pnpm publish` reports an OTP challenge as a 404.**
  Bootstrapping `-maps` for 1.4.0 failed with
  `404 Not Found - PUT https://registry.npmjs.org/@mgcrea%2fmcp-apple-maps`, which reads as a
  permissions or naming problem and is neither. npm answers the `PUT` with **401 `EOTP`, "this
  operation requires a one-time password"**; pnpm's `withOtpHandling` swallows it and surfaces the
  _preceding_ `GET 404` — the existence check, which correctly 404s for a package that does not
  exist yet. The two failures are indistinguishable from pnpm's output, and the 404 is the more
  plausible-looking of them, so it sends you to the token settings for a token that was never
  the problem.

  `npm profile get` does not settle it either: it reported `two-factor auth: auth-only`, which
  sounds like writes are exempt. They are not — a granular token that is not marked as bypassing
  2FA still gets challenged on publish. **To see the real error, publish with `npm`, not `pnpm`:**

  ```sh
  cd packages/<slug> && pnpm pack --pack-destination /tmp   # pnpm packs, for workspace: substitution
  npm publish /tmp/<tarball>.tgz --tag bootstrap --access public --loglevel verbose
  ```

  Packing with pnpm and publishing the tarball with npm is the combination that works: `npm publish`
  on the directory would ship the literal `workspace:^` string, and `pnpm publish` hides the OTP
  prompt. It also touches no file in the tree, so there is no bootstrap version left to restore.

  **The first version published becomes `latest` whatever `--tag` says.** `--tag bootstrap` does not
  prevent it — npm points `latest` at the only version there is, so `npm i` serves the stub until the
  real release lands. It cannot be undone (`latest` can be moved, never deleted), so the bootstrap
  and the release that supersedes it belong in the same sitting.
