# The desktop surface: one copy of an app by pid, and the driving channel's version 2

Written 2026-11-16. This is the third of three small cycles Olivier approved on 2026-11-15 ("ok
sounds great"), so that a check by eye of one of our own Mac apps runs through its driving channel
instead of the session's cursor.

- The first cycle shipped as swift-support-kit 1.25.0, tagged 2026-11-16: `SupportKitDriving`'s
  channel version 2.
- The second is Maquette linking the channel. It waits for Maquette's G8.
- This one is Cupertino's.

## Why

The motivating case: Maquette's checks by eye run a worktree's Debug build while Olivier's own
Debug build, from the main checkout, is open beside it, with the same bundle id. Today that fails
four ways:

1. **`apple_desktop_launch` refuses to start a second copy.** "Two copies under one bundle
   identifier would leave every bundleId verb unsure which it reaches." That is right while verbs
   can only name a bundle id.
2. **Every desktop verb names its app by `bundleId` alone.** Two lookups resolve it with `.first`
   over the running copies, so they reach whichever copy comes first:
   - `AccessibilityDriver.app(forBundleId:)` (`AccessibilityDriver.swift:638`);
   - `AppChannel.find(bundleId:)` (`AppChannel.swift:49`).
3. **The channel's version 2 is unreachable.** Cupertino sends none of:
   - a drag's button, modifiers or pacing;
   - a hover's `from`;
   - a scroll (there is no scroll verb).

   Maquette's viewport orbits and pans only on events that carry a movement, sent with the middle
   button or with Option held.

4. **The channel's known gaps** (`docs/desktop.md`, "A channel into our own apps") include
   interleaved appends, a `seq` base two Cupertinos can share, and `events.jsonl` re-read whole
   every 10 ms for the life of the app.

## What changes

### A copy by pid

- **`pid` on every verb that takes `bundleId`.** This includes `run`'s steps and a drag end's
  `{x, y, bundleId}`.
  - With `pid`, the verb reaches that process and no other.
  - `bundleId` may then be left out. When both are given, they must agree, or nothing happens.
  - The scope is checked against the process's bundle id, as today.
  - A `pid` that is not running, or that has no bundle id, is refused.
- **A handle reaches the process its element belongs to** (`AXUIElementGetPid`), never another
  copy, including for the channel lookup below. A `ui_tree` or `find_elements` call made with a
  `pid` returns handles of that copy.
- **An ambiguous bundle id is refused rather than guessed.** A verb named by `bundleId` alone
  while more than one copy runs is refused. The refusal lists each copy with:
  - its `pid`;
  - its bundle's path;
  - whether this Cupertino launched it with a channel.

  It also says to pass `pid`. With one copy running, nothing changes for any caller.

- **`list_apps` gives each app's `path`** beside the `pid` it already gives, so a caller can tell
  two copies apart.
- **`launch` by `path` with `channel: true` starts a copy beside a running one.** It answers that
  copy's `pid`. Every launch answer carries `pid` when it started something.
  - Without `channel: true`, the old refusal stands. A plain second copy has no use here worth
    the ambiguity.
  - Launch by `bundleId` alone never starts a second copy.
- **The channel registry is keyed by pid.** It is already; `find(bundleId:)` gains a `pid` form.
  - With a pid, the lookup is that process's channel, if this Cupertino launched it.
  - With a bundle id alone, it is the one running copy's channel, and the ambiguity refusal
    above applies first.

### Version 2

- **The channel's version.** `AppChannel` reads `version` from the app's `ready` event. It is 1
  when absent. A version-1 app _ignores_ fields it does not know, so a middle-button drag would
  silently become a left drag. Cupertino therefore refuses to send a version-2 field to a
  version-1 channel, naming the version and saying to rebuild against swift-support-kit 1.25.0
  or later.
- **`drag` gains three arguments:**
  - `button`: `left` (the default) or `middle`, sent as the channel's `other`;
  - `modifiers`: the names `key` takes;
  - `paced`: a boolean.

  All three are channel-only. On the session lane, a non-default value is refused with the
  reason, rather than dropped.

  A paced drag's ack is waited on for `ackTimeout + durationMs / 1000 + 1` seconds. The extra
  second is the channel's patience. A paced drag's command waits for its ack before the next is
  sent, so commands never interleave with a held button.

- **`hover` gains `from: {x, y}`.** It is channel-only, and the sweep runs from it to the target,
  so the moves carry their movement.
- **`apple_desktop_scroll`: a new verb, channel-only for now.** It takes:
  - `x` and `y`;
  - `dx` and `dy` (0 by default);
  - `units`: `line` (the default) or `pixel`;
  - `bundleId` / `pid`.

  It is refused for an app without a channel, with the reason. A session-lane scroll is a later
  measurement. It is admitted like the other channel verbs, as a write, and it is a `run` step.

- **The ack's `note` reaches the caller unchanged.** `channelFields` already copies it. Version
  2 uses it to say an event lost its movement or its middle button.

### The channel's gaps

- **`send` appends with `O_APPEND`, under the existing lock**, so two connections never
  interleave a line.
- **The `seq` base is random over a 52-bit range** at process start, so two Cupertinos (Debug
  and installed) do not share one.
- **`events.jsonl` is read from where the last read ended.** Keep a per-directory offset. Fall
  back to a whole read when the file shrank, which means a new process reused the directory.

### `channel-check`

Extend it for what this cycle adds:

- Two copies of the fixture, both launched by path with `channel: true`, each driven by `pid`.
  Check that a click reaches only the named copy.
- A bundle-id verb with both copies running is refused, listing both.
- A version-2 middle-button drag with Option held, and a pixel scroll, read back by the fixture.
- A version-2 field sent to a version-1 channel is refused. Plant a `ready` without `version`
  in a test directory, as the Finder plant does.

Everything that can be asserted without a running app goes in the existing no-app checks
(`desktop-check`, `unit`):

- argument parsing and refusals;
- the version gate;
- the `seq` base;
- the incremental read.

## Not here

- Measuring that Cupertino, with Full Disk Access, reads a sandboxed app's container channel.
  That is Maquette's cycle, which has the sandboxed app; `channel-check`'s fixture is not
  sandboxed.
- A session-lane scroll, and session-lane modifiers or a middle button on `drag`.
- Screen captures by window id, and the stale captures seen after synthetic input. They belong
  to the screen surface, so they get a cycle of their own.
- Pruning channel directories left by killed processes.

## Docs and release

- `docs/desktop.md`: update "A channel into our own apps" and its gaps list to what is now true.
  Add a dated section on the pid and version-2 work, with what `channel-check` measured.
- `CHANGELOG.md`: an entry under the next version, if the repo keeps one per change.
- Releasing is Olivier's call.
