# Shell: scripts under Cupertino's grants

**Status: BUILT, off by default, not yet tried live.** `shell` is in `surfaces.json` and served by
the app in-process. Every claim below names the check that pins it. Where nothing pins a claim, this
page says so, and [Not yet verified on a real Mac](#not-yet-verified-on-a-real-mac) lists what still
needs a person at the keyboard. The design is
[the spec](superpowers/specs/2026-10-27-shell-surface-design.md). Where the spec and the code
disagree, the code is what this page describes.

Shell runs one script an agent sends, as a child of Cupertino, after the person approves it in a
window that shows the script. It exists because Cupertino holds one Full Disk Access grant, and
work outside the other surfaces' tools had no way to use it.

## The risk, in the spec's words

Every other surface reaches one application and is bounded by write switches, gates and account
allowlists. A command running under Cupertino's grants gets past all of them: it can read
`chat.db`, the Envelope Index, Safari history and anything else Full Disk Access opens, and it can
send Apple Events to every app Cupertino was already granted Automation for. An agent that reads a
mail or a web page saying "run this" is the realistic attack. **The confirmation window is the
only safeguard left, and the bypass setting removes it.**

Everything below follows from that. The window shows the code, not a summary. The safe answer is
the default. Even with the bypass on, a run is never invisible. And the two settings that lower the
bar cannot be written by a program running as the person, approved scripts included.

## What a script reaches

**Every grant Cupertino holds, not only Full Disk Access.** The script is Cupertino's own child,
and macOS charges a child's access to its responsible process, which is Cupertino. That is the
mechanism the node servers already rely on: `Permissions.swift` (above `accessibility()`) records
that `launchctl procinfo` names the app as a server's responsible pid, and that
`scripts/spike-app-tcc` measured the inheritance for Full Disk Access and Apple Events. So a script
can send Apple Events to every app Cupertino has Automation for, use Screen Recording or the
microphone if Cupertino holds them, and read what Full Disk Access opens.

**Accessibility is not to be relied on for grandchildren.** The same comment records an `osascript`
grandchild that answered `AXIsProcessTrusted` false on macOS 26.6 while the app's own row read
granted, because one bundle identifier can hold several Accessibility entries at once. A script
that drives an interface through Accessibility may work, or may not.

**Without Full Disk Access, Shell still works.** The script then has whatever else Cupertino
holds. `apple_shell_diagnostics` reports `fullDiskAccess`, the interpreters the login shell finds,
the runs in flight, whether the run record's chain is intact, and `sealKeyError` when the seal key
could not be read.

**Never the Chat pane.** `ChatPane.picks` filters Shell out even when it is on, so the on-device
model never asks to run a script and no window ever names Cupertino as its own client. No check
pins this. **Known gap:** the headless dev path, `Cupertino --chat=shell --ask=…`
(`ChatConversation.runHeadless`), does not go through `picks` and can still reach Shell.

## The tools

`apple_shell_run` takes `script` and `purpose` (both required), `interpreter`, `cwd`, `stdin` and
`timeoutSeconds`. It answers with `decision`, `exitCode`, `signal`, `timedOut`, `durationMs`, and
`stdout` and `stderr` with a `Truncated` flag each. A refusal is `isError: true` with a sentence
for the agent and `structuredContent.decision` beside it. Annotations: `destructiveHint: true`,
`openWorldHint: true`. `apple_shell_diagnostics` runs nothing of the caller's.

What a request is held to, before anything is decided and before any window shows, as
`make shell-check` pins under "ShellServer: the arguments":

| Field            | Rule                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `script`         | required, not empty, at most 512 KB of UTF-8, no NUL                       |
| `purpose`        | required, not blank, at most 500 characters                                |
| `interpreter`    | `zsh` (default), `bash`, `python3`, `node`, `osascript`, `jxa`             |
| `cwd`            | an absolute path, `~` or `~/…`, that exists and is a folder; default `~`   |
| `stdin`          | at most 256 KB, no NUL; none means `/dev/null`                             |
| `timeoutSeconds` | a whole number from 1 to 600, default 60; the window's wait does not count |

NUL is refused because `zsh -c` takes the script as a C string: the window and the record would
hold the whole text while only the part before the NUL ran. The script and stdin caps keep a
request inside the host's 1 MiB line, which drops a longer one with no answer at all.

## How a run is decided

`ShellPolicy.decide` is a pure function over "Before running", the connection's session approval
and cooldown, the runs in flight, and the time. `make unit` ("Shell policy") pins the decision in
every case below, and `make shell-check` ("ShellServer") pins the server acting on it.

- **"Before running"** is one of three choices in the Shell pane:
  - **Ask every time**, the default. Every run shows the window, and the window has no session
    button.
  - **Ask once per session**. The window adds "Run, and stop asking this session", which approves
    later runs on the same connection for 30 min or until the connection closes. It never crosses
    to another connection (`make shell-check`, "ShellServer: once per session").
  - **Don't ask**. No window. Choosing it shows a warning sheet that names the injection risk,
    and only that sheet's confirming button, pressed by hand, sets it.
- **Cooldown.** After "Don't run" or no answer, the same connection is refused for 30 s with no
  window. The cooldown outranks everything, "Don't ask" and a session approval included.
- **Four at once.** At most four runs are in flight app-wide. A fifth is refused, not queued. The
  slot is taken under the same lock as the decision, so two approvals cannot make five
  (`make shell-check`, "ShellServer: four at once").
- **A run that shows no window shows a card**, "Running a command for <client>", with a Stop
  button, for as long as the run lasts. The menu bar shows "Stop running commands" while any run
  is live. Both end the run (`make shell-check`, "Stop on the card ends the run as cancelled").

## The window

The window is a non-activating floating panel titled "Cupertino Shell", made key without
activating Cupertino. It shows, in order:

1. "<client> wants to run a command with Cupertino's access", and under it "The client names
   itself, and Cupertino cannot verify it."
2. "The agent says:" and the `purpose` in quotes.
3. The **whole script**, monospaced, selectable, not editable, wrapped rather than scrolled
   sideways so nothing hides past the right edge, and never elided. Its caption counts lines and
   bytes. `stdin`, when given, is shown the same way. A script holding invisible format characters
   (bidirectional overrides, zero-width spaces) gets a red warning.
4. The interpreter, the folder and the timeout.
5. "This can read everything Cupertino can, including mail, messages and browsing history, and can
   control apps Cupertino controls."
6. **Don't run**, the default button, then **Run once**, and **Run, and stop asking this session**
   only under "Ask once per session".

Return and Escape both mean Don't run, so someone typing when the window arrives declines it. The
run buttons stay disabled for 1 s after the window shows, so a click already on its way lands on
nothing. No answer within 60 s is a no, timed from when the window shows rather than from when
the request queued. Requests wait their turn, one window at a time (`make shell-check`,
"ShellPromptQueue"). If there is no screen to show the window on, the request is answered as
cancelled rather than left waiting, and the queue moves on (`make shell-window-check`, "with no
screen, a request is answered"). `make shell-window-check` ("Arming") pins that the run buttons
start disabled. The layout, Return and Escape, and the focus are not pinned by any check; they are
among the hand checks [below](#not-yet-verified-on-a-real-mac).

### Only a person can approve

The window and the sheets that lower the bar take input from hardware only. Three layers, each
checked on its own by `make shell-window-check`, which posts no event and shows no window:

- **Posted events.** `ShellPanel` drops every click, keystroke, drag and scroll that
  `ShellInput.isHardware` says a program posted, key equivalents included.
- **Accessibility.** AppKit hands a button's cell to Accessibility, and a cell answers a press
  through two entry points, `accessibilityPerformPress` and the older
  `accessibilityPerformAction(.press)`. The run buttons' cell refuses both and ignores
  `performClick`. The button refuses the same two itself.
- **Anything else that reaches the action.** The action acts only inside a hardware left
  mouse-down tracked on the button itself, during AppKit's tracking loop, and only when the event
  being handled is a hardware left mouse-up in that window. A stale mouse-up left current from an
  earlier click does not count.

The run buttons have no key equivalent and never take keyboard focus.

**The cost: VoiceOver and other Accessibility users cannot approve a run.** VoiceOver can read the
window and press Don't run, but not Run once. That follows from the rule that only a person's hand
can approve, and it is a real accessibility gap.

**`ShellInput.isHardware`'s rule is UNCONFIRMED.** The rule is: the event's source pid
(`eventSourceUnixProcessID`) is 0 AND its source state (`eventSourceStateID`) is `.hidSystemState`.
What has been measured, on 2026-10-27, without posting anything: a `CGEvent` this process builds
carries its own pid whatever source it is built from, and the state id reads 0 for
`.combinedSessionState`, 1 for `.hidSystemState` and an arbitrary number for `.privateState`. So a
program can pick the HID state. Whether it can also get a pid of 0 once the window server has
stamped the event has not been measured: a program can write 0 into an event it holds in memory
(`make shell-check`, "pid 0 and the HID state is hardware"), and the rule rests on posting
overwriting it. What confirms the rule, in a scratch panel that logs both fields:

- a real click, keystroke and trackpad scroll read pid 0 and state 1
- a `CGEvent` posted at `.cghidEventTap` by a separate process reads that process's pid
- one posted by Cupertino itself reads Cupertino's pid

If a real event reads otherwise, the window cannot be answered and times out as a no, which fails
safe. If a posted event reads pid 0 and state 1, the rule is wrong and must change.

## Settings a program cannot forge

Cupertino is not sandboxed, so any process running as the person can write its preferences. A
session with a shell and no Full Disk Access could otherwise `defaults write` Shell on and "Don't
ask", and turn "has a shell" into "has Full Disk Access" with no window. So those two settings,
the two that lower the bar, count only with a seal Cupertino made.

- **The seal.** Beside each value, a hex HMAC-SHA256 over `<app identifier>|<key>|<value>`, keyed
  by 32 random bytes. A missing, unreadable or invalid seal reads as Shell **off** and as **Ask
  every time**, so deleting the key or the preference fails safe. "Ask every time" and "Ask once
  per session" need no seal, since both still put a window in front of a person. `make shell-check`,
  "ShellSeal", pins each of these.
- **Where the key lives.** In the data protection keychain, under the keychain access group named
  by the app's own signed application identifier, `<prefix>.io.mgcrea.cupertino` for the release.
  A process can only name an access group its own signature is entitled to, and that entitlement
  must be authorised by a provisioning profile. So a same-user process can neither plant the key
  nor read it. The item is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so it never syncs to another Mac. `make shell-check`,
  "ShellSeal.Keychain", pins the query: the data protection keychain, the group equal to the
  application identifier, no query at all for a wildcard, a bare bundle id or the other build's
  identifier.
- **Why not the login keychain**, which the spec suggested. A review showed that
  `security add-generic-password -A` plants an item there silently, with an ACL that trusts every
  app. A program could plant a key of its own choosing before Shell was first turned on, compute
  both seals, and write all four preferences: Shell on, "Don't ask", no prompt anywhere. The
  `ShellSeal.swift` header has the detail. That mechanism was dropped, and with it the spec's
  claim that a planted key raises a Keychain prompt.
- **The Debug build has its own key.** Its identifier, `io.mgcrea.cupertino.debug`, is both in the
  sealed text and in the access group, so a seal from one build never validates in the other. The
  Debug group currently carries the legacy prefix `CDV6DT8QF2` that Xcode's wildcard profile gives
  it; the code reads the prefix from the signature rather than assuming one.
- **A build without the entitlement cannot turn Shell on.** It gets `errSecMissingEntitlement`, so
  no key, so Shell off and ask. The Shell pane says "Shell can't be turned on, because Cupertino
  could not keep the key that protects this setting in the Keychain." and the switch stays off.
- **No launch argument sets either.** Values are read from `persistentDomain(forName:)`, which
  leaves out `NSArgumentDomain`, so `-surfaceEnabled.shell YES` and `-shell.before none` are
  ignored, unlike `driving.before` (`make shell-check`, "but a sealed value there does not count").
  One consequence: the screenshot pipeline's `-surfaceEnabled.shell YES` has no effect, and
  screenshots show Shell off.
- **The key rotates on the way down.** A copy of a seal taken while Shell was on would otherwise
  validate if written back after the person turned it off. So whenever a protected setting goes
  down, the key is replaced and every seal made under the old one, copies included, stops
  validating (`make shell-check`, "a seal copied before turn-off does not validate after").
- **Turning Shell off also resets "Before running" to Ask every time**, so turning it on again
  never brings "Don't ask" back with it (`make shell-check`, "on with \"Don't ask\", turned off
  and on again, reads ask"). Lowering "Don't ask" alone leaves Shell on, re-sealed under the new
  key.
- **Seals are written from the Shell pane only**, after a hand-pressed click on a confirming sheet.
  Every switch for Shell, the pane's heading and the sidebar's context menu among them, goes
  through `ShellPane.switchStep`: off happens at once, on opens the Shell pane with the sheet up.

**Release signing needs a Developer ID provisioning profile** for this, and CI reads it from the
secret `DEVELOPER_ID_PROVISIONING_PROFILE_BASE64`. See
[distribution.md, "The provisioning profile"](distribution.md#the-provisioning-profile).

**The residual.** On a Mac that holds the team's signing identity, such as the developer's, a
process able to drive `codesign` with that identity, and a profile that authorises the group, could
sign a binary of its own into the access group and read or replace the key. Users' Macs do not
hold that identity.

## How a run executes

`ShellRunner` starts every run with `posix_spawn`. `make shell-check` ("ShellRunner") pins each
point below except where it says otherwise:

- **Through a login shell, `/bin/zsh -l -c`**, so `PATH` is Terminal's and Homebrew's `node` and
  `python3` resolve. For `zsh` the script is the `-c` argument. For the others it is written to a
  0600 file in a `cupertino-shell` folder of the temporary directory, the login shell `exec`s the
  interpreter on it, and the file is removed after the run. `jxa` is `osascript -l JavaScript`.
  Interpreters that are not installed are skipped by the check and say so.
- **A login shell's own output is part of stdout.** A `~/.zprofile` that echoes puts its line ahead
  of the script's. Measured 2026-10-28 on macOS 27.0.1, with a scratch `ZDOTDIR` whose `.zprofile`
  echoed. `ShellRunner.resolve` takes the last line of `command -v` for that reason.
- **A minimal environment:** `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which the login shell then extends. Nothing of Cupertino's
  own environment, and none of the `APPLE_*` server variables ("env has only the base keys").
  Signal dispositions are reset, so the app's ignored SIGPIPE does not reach the script ("SIGPIPE
  is back to its default in the script"). Only the three pipes are inherited
  (`POSIX_SPAWN_CLOEXEC_DEFAULT`), which no check pins.
- **Its own process group.** At the timeout, or at a cancel, the group gets SIGTERM, then SIGKILL
  once the group is empty or 2 s have passed. The grace belongs to the whole group, not only the
  leader, so a member that traps SIGTERM to clean up gets it even when the leader dies at once.
  "A timeout kills a backgrounded grandchild" is checked by the grandchild's pid being gone.
- **Output.** stdout and stderr are drained concurrently, each capped at 256 KB with the rest read
  and discarded, so a child writing 10 MB never blocks. Decoded as UTF-8 with replacement
  characters.
- **`sudo` fails for want of a terminal.** A script has no tty and no way to receive typed input,
  so `sudo` cannot ask for a password. This is the design's claim and has not been measured. It
  says nothing about a `NOPASSWD` sudoers rule, `sudo -S` reading a password from `stdin`, or Touch
  ID for `sudo`, none of which has been tried. Nothing works around it on purpose.

## Cancellation, switching off and quitting

- **Esc in the client, or a hang-up, cancels a waiting window or a run.** The connection's frames
  are read on one thread and its requests handled on another, so a `notifications/cancelled`
  reaches the call while it waits (`InProcessCalls`). This holds even when the cancel arrives
  before the call registered: a cancel for an unregistered id leaves a tombstone, a hang-up marks
  the connection closed, and a later registration meets either and cancels at once. Then nothing
  is asked and nothing runs. `make host-check` pins the loop; `make shell-check`, "ShellServer:
  stopping", pins "a cancel that beats the call", "a hang-up that beats the call", "a cancel that
  beats the window" and "a cancel mid-run stops it".
- **A hang-up also ends the session approval** and the cooldown for that connection.
- **Turning Shell off** closes every waiting window, stops every run and drops every session
  approval (`make shell-check`, "stopAll").
- **At quit and at an update relaunch,** `ServerHost.terminateChildren` stops Shell's calls first,
  then sends each live run group SIGTERM and then SIGKILL after a 3 s grace that belongs to the
  whole group, not only its leader (`ChildTermination.terminateGroups`, `make shell-check`, "ChildTermination: a process group
  that will not stop"). It then waits up to 1 s for open calls to settle and sweeps the groups a
  second time, because a call that passed its last cancel check just before the first sweep can
  spawn after it. Last, it drains the run record so the final lines are written.

## What is recorded

### The run record, always on

Every request leaves one line, a refusal as much as a run, whatever the activity and audit
settings say. It is at `~/Library/Application Support/io.mgcrea.cupertino/shell-runs/`
(`io.mgcrea.cupertino.debug` for the Debug build), in monthly files `runs-YYYY-MM.jsonl`, in a 0700
folder. Each line holds:

- the time, the client name and the connection id
- `purpose`, the interpreter and `cwd`
- the script's byte count and a SHA-256 over its full text
- stdin's byte count and SHA-256, when stdin was given
- the decision: `approved`, `approvedForSession`, `notAsked`, `declined`, `noAnswer`, `cooldown`,
  `busy`, `cancelled` or `invalid`
- the exit code or signal, whether it timed out, and the duration

**Never the text of the script or of stdin, and never any output.** The hashes close the gap the
activity log leaves: an argument there is cut at 4 KB, so a script hiding its payload past 4 KB of
harmless text would be logged without it, and stdin can carry the real payload (`sh -s`). Lines are
chained with `AuditChain`, which gives tamper evidence, not prevention: a same-user process can
still delete the files. 90 days are kept. The Shell pane lists the 20 most recent under "Recent
runs", with a 12-digit prefix of each script's hash. `make shell-check`, "ShellRecord" and
"ShellServer: the record", pins one line per request, every decision by its name, the hash, and no
script text or output on file.

### Through the activity log

Shell calls also go through the existing activity log path, under its existing settings:

- The call's arguments, the script among them, are kept as for any tool, each cut at 4 KB. The
  audit file, off by default, writes them only under the payloads switch (`auditPayloads`).
- A result keeps the decision, exit code, signal, timeout and duration even without the content
  switch. stdout and stderr appear only under the content switch (`auditContent`), because output
  can be the text of somebody's mail.
- In the default capture mode (Arguments) no result row is written at all. The run record covers
  it.

`make shell-check`, "ShellServer: through the activity log", pins these rules on `CallCapture`,
and that every other tool records exactly what it did before.

## What pins what

| Check                     | What it pins                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `make unit`               | `ShellPolicy`: cooldown beats "Don't ask", a session approval and busy; a session approval expires at 30 min; ask never offers it; busy at 4     |
| `make shell-check`        | the seal and its key query, the pane's switch steps and copy, the run record, the runner, the server's decisions, cancellation, the activity log |
| `make shell-window-check` | the run buttons refuse both Accessibility entry points, `performClick` and a sent action; the sheets' confirms the same; a window with no screen |
| `make host-check`         | cancel for an unknown id, cancel mid-call, EOF mid-call, a cancel or EOF that arrives before the call registers                                  |
| `make dispatch-check`     | the `shell` case reaches `ShellServer` with its connection                                                                                       |

`shell-check` and `shell-window-check` run in CI. At `b649d27`, on 2026-10-28, `shell-check` passed
261 of 261, `shell-window-check` 46 of 46, `unit` 293 of 293, `host-check` 26 of 26 and
`dispatch-check` 83 of 83. Neither Shell check posts an event, shows a window, or touches the real
Keychain or the app's own defaults.

## Not yet verified on a real Mac

Nothing here has been tried against a running Cupertino. These are still open:

- **The hardware-input measurement** for `ShellInput.isHardware`, described under
  [Only a person can approve](#only-a-person-can-approve).
- **The window, by hand** on the Debug build: the full script shows and long scripts scroll,
  Return and Escape decline, no answer declines at 60 s, the cooldown holds, a session approval
  ends when the connection closes, "Don't ask" shows the card and its Stop works, the menu bar's
  Stop works, Esc in a real Claude Code session closes a window and stops a run, quitting mid-run
  leaves no child behind (`pgrep`), and a System Events `click button "Run once"` runs nothing. The
  confirming sheets likewise: they appear from each switch, Return and Escape cancel them, and a
  build without the keychain entitlement shows why Shell stays off.
- **The forging test.** With Shell off, `defaults write` both keys and relaunch: `apple_shell_run`
  must not be listed. Then turn Shell on in the app, `defaults write shell.before none`: the next
  run must still show the window.
- **The plant test.** Plant a login-keychain item, `defaults write` the four keys, relaunch:
  Shell must read off and the next run must ask.
- **The `-shell.before none` launch argument**, which must have no effect.
- **A real click on Run once**, once. `shell-window-check` cannot drive AppKit's tracking loop
  without posting events, so a person's click passing the gate is reasoned, not seen.
- **Release signing end to end** with the Developer ID provisioning profile, and the notarized app
  turning Shell on.
- **`sudo` without a terminal**, see above.
