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
holds. `apple_shell_diagnostics` reports `fullDiskAccess`, the interpreters a script's PATH finds,
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
plain-text request inside the host's 1 MiB line, which drops a longer one with no answer at all,
even with both at their limits. They count decoded bytes, though, and the line is the encoded JSON:
text heavy in characters JSON escapes (quotes, backslashes, control characters) can push a request
under both caps past 1 MiB, and that request gets no answer.

## How a run is decided

`ShellPolicy.decide` is a pure function over "Before running", the connection's session approval,
the cooldown, the runs in flight, and the time. `make unit` ("Shell policy") pins the decision in
every case below, and `make shell-check` ("ShellServer") pins the server acting on it.

- **"Before running"** is one of three choices in the Shell pane:
  - **Ask every time**, the default. Every run shows the window, and the window has no session
    button.
  - **Ask once per session**. The window adds "Run, and stop asking this session", which approves
    later runs on the same connection for 30 min or until the connection closes. It never crosses
    to another connection (`make shell-check`, "ShellServer: once per session"). Any change to
    "Before running" withdraws every session approval at once, so moving to "Ask every time" and
    back within the 30 min does not bring one back ("switching away from once per session and
    back asks again"). The app reports each change as its defaults change, and every request
    reports the setting it was decided under ("a change seen first by a request withdraws it
    too"). The app's half, the defaults watcher in `CupertinoApp.swift`, is not pinned by a
    check.
  - **Don't ask**. No window. Choosing it shows a warning sheet that names the injection risk,
    and only that sheet's confirming button, pressed by hand, sets it.
- **Cooldown.** After "Don't run" or no answer, the same connection, and every connection whose
  client gives the same name, is refused for 30 s with no window. An agent that holds a shell can
  open a new connection for each retry, so a cooldown kept per connection alone would cost it
  nothing. Closing a connection drops that connection's own state but not its name's cooldown,
  which ends on its own (`make shell-check`, "ShellServer: a cooldown follows the client's name
  across connections"). The name is whatever the client says it is: two clients that share a name
  share a cooldown, and a client that changes its name each time gets a fresh one. The cooldown
  outranks everything, "Don't ask" and a session approval included.
- **Four at once.** At most four runs are in flight app-wide. A fifth is refused, not queued. The
  slot is taken under the same lock as the decision, so two approvals cannot make five
  (`make shell-check`, "ShellServer: four at once").
- **Four windows at once.** At most four requests wait for the window app-wide, the one on screen
  included. One more is refused with the same "Four commands are already running" sentence,
  recorded as `busy`, and opens no window, so an agent cannot stack windows in front of the person
  to wear them down (`make shell-check`, "ShellServer: at most four windows wait at once").
- **A run that shows no window shows a card**, "Running a command for <client>", with a Stop
  button, for as long as the run lasts. The menu bar shows "Stop running commands" while any run
  is live. Both end the run (`make shell-check`, "Stop on the card ends the run as cancelled").

## The window

The window is a non-activating floating panel titled "Cupertino Shell", made key without
activating Cupertino. It shows, in order:

1. "<client> wants to run a command with Cupertino's access", and under it "The client names
   itself, and Cupertino cannot verify it."
2. "The agent says:" and the `purpose` in quotes, scrolled past a tenth of the screen's height.
3. The **whole script**, monospaced, selectable, not editable, wrapped rather than scrolled
   sideways so nothing hides past the right edge, and never elided. Its caption counts lines and
   bytes. `stdin`, when given, is shown the same way. A script or stdin holding invisible format
   characters (bidirectional overrides, zero-width spaces) gets a red warning.
4. The interpreter, the folder and the timeout, scrolled past a tenth of the screen's height too,
   so neither the purpose nor a long folder can push the buttons off the screen.
5. "This can read everything Cupertino can, including mail, messages and browsing history, and can
   control apps Cupertino controls."
6. The buttons, which read left to right as **Run, and stop asking this session** (only under "Ask
   once per session"), **Run once**, then **Don't run**, the default button, at the right.

**The client's own words are made safe to show.** The client name is cut to 100 characters
wherever Shell uses it: the window, the card, the run record and Recent runs. The name, the purpose
and the folder are drawn without control and format characters (Unicode Cc and Cf: bidirectional
overrides, zero-width spaces), with a line break or tab drawn as a space, so a name cannot read as
another. The run record keeps them as they came, capped. A purpose or folder holding such
characters raises the same red warning as a script that does (`make shell-check`, "ShellText" and
"a client's name is capped wherever it is used").

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

**Another program's window over the Shell window.** A program running as the person can put a
borderless window above the Shell window's level, draw a harmless script where the real one is, and
let clicks fall through, so the person's genuine click lands on Run once. A hardware click is all
the layers above ask for, and that click is one. So while the window is up, `CoverWatch` asks the
window list every 0.1 s for the windows above it (`CGWindowListCopyWindowInfo` with
`.optionOnScreenAboveWindow`). While any window of another process overlaps it, Apple's own aside,
the run buttons are off and the window says which program's it is: "A window of Notes is over this
one, so Run is off until it moves.", or "Another window is over this one, …" when the list gives no
owner name. The name is the program's own, stripped of control and format characters and cut to 40
characters (`ShellText.owner`), and the notice is laid out as tall as the longest name makes it, so
naming one does not move the buttons. Once the window moves, the 1 s arming delay starts again, so
a cover pulled away just before a click still finds Run off. A click that lands on Run while one is
there is refused and logged, at the click itself.

**Apple's own windows do not count.** The menu bar, the Dock and `screencaptureui` keep windows
above the Shell window's level over the whole screen. A read-only probe on Olivier's Mac on
2026-10-28 found `screencaptureui` ("Screenshot") at layer 24 over the full 1728×1117 screen, the
menu bar (Window Server) at layer 24, and the Dock full-screen at layer 20, all opaque; counted as
covering, they kept Run off for good. The level cannot tell them apart, because a program can put
its window at any level. The code signature can: a program running as the person cannot make its
window belong to a process whose running code meets `anchor apple`, the requirement only Apple's
own signing meets. So `ShellPlatform` asks Security for the owner's code by pid
(`SecCodeCopyGuestWithAttributes`) and checks it against `anchor apple` (`SecCodeCheckValidity`);
any error is a no, and the window still covers. Not `anchor apple generic`, which any Developer ID
program meets, an attacker's among them; an App Store app of Apple's, such as TestFlight, does not
meet it either and counts like any other. Each verdict is kept for its process, a pid together with
the time it started, read from the kernel's process table (`sysctl` `KERN_PROC_PID`), so a pid
handed to a new process is asked about afresh; a process whose start time cannot be read is not
trusted. `proc_pidinfo` was not used for the start time: it refuses a process of another user, and
the window server runs as `_windowserver`. At most 256 verdicts are kept. The same probe, run again
with the fix (no events, no window, nothing launched), found the menu bar, `screencaptureui`,
Notification Center, Finder, WindowManager and the wallpaper all trusted, and a centred 600×500
window not covered; the Dock had no window on screen then, and its process met the requirement by
pid; every program that came out untrusted was a third party's, or TestFlight, and
all of those were at layer 0, below the Shell window.

The Shell window is kept inside the screen's visible area (`ShellCover.placed`), so it never sits
under the menu bar or the Dock, which no longer turn Run off: a script too tall for the window gives
up height and scrolls.

`ShellCover.isCovered`, the decision, is pure and pinned (`make shell-check`, "ShellCover",
"ShellPlatform"): this app's own windows, the card among them, do not count; a fully transparent
window does not; a window of Apple's own does not; a window the list gives no pid for, a window of
anyone else's it gives no bounds for, or no list at all, counts as covering everything, so Run stays
off rather than on; and the trust test failing for every pid leaves every overlapping window
covering. `make shell-window-check` ("CoverWatch") pins that the watched buttons start off, get the
click-time test, and what the notice says. Limits:

- **A window that appears after the click has been taken is not seen.**
- **The card can still be covered.** Its Stop can only stop a run, so a cover there costs a stop
  the person meant, not a run they did not; the run goes on and is still on the record.
- **The confirming sheets are not watched.** The person opened them from a switch themselves.
- **Apple's tools that run code they are given are trusted too.** `anchor apple` says who signed
  the program, not who wrote what it shows. `osascript`, `/usr/bin/swift`, Xcode's `swift-frontend`
  and the Command Line Tools' `python3` all meet it (measured with `codesign -R` on 2026-10-28), and
  `osascript`'s JavaScript reaches AppKit through its Objective-C bridge: `NSWindow` answers
  `setLevel:` and `setIgnoresMouseEvents:` from it (measured on the same day without making a
  window). So a program running as the person can, as far as is known, put a borderless,
  click-through window of `osascript`'s over the Shell window, and it would not count. A
  `display dialog` takes clicks rather than letting them through, so it could only hide Run, but a
  window made through the bridge need not. Making one was not tried: it would show a window on
  Olivier's Mac.
- **The fields read without Screen Recording are not measured.** The window list withholds window
  titles from a process without the grant, and documents bounds, owner pid, owner name and alpha as
  readable without it. Measured on 2026-10-28 only from a shell that holds the grant, so the case
  without it is unconfirmed; were bounds withheld, Run would stay off whenever another program's
  window is above the Shell window, which fails safe.
- **Any window of another program, Apple's aside, above the Shell window's level turns Run off**, an
  always-on-top utility among them. It comes back on 1 s after that window moves.

**No driving surface clicks it.** The Desktop surface checks that a point is on a window of the
application it names, and steps over windows at higher levels, the Shell window among them. A
Desktop click aimed at a window under the Shell window would have been posted onto Run once, with
only the hardware rule left to drop it. `ShellPanels` keeps the window numbers and frames of the
open Shell window and confirming sheets (not the card, which sits over targets by design, as the
driving card does), set as each shows and cleared as it closes. `AccessibilityDriver.click` and
`drag`, which every driving surface posts through, refuse a point on one before anything else:
"(x, y) is on Cupertino's Shell window, so nothing was posted. No surface clicks the window where a
person decides whether a script runs; wait for them to answer it." (`make desktop-check`, "a click
on the Shell window is refused"; `make shell-check`, "ShellPanels"). Keystrokes are not refused:
Return and Escape mean Don't run, and no key presses Run.

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
  nor read it. The item is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so it never syncs
  to another Mac. `make shell-check`, "ShellSeal.Keychain", pins the query: the data protection
  keychain, the group equal to the application identifier, no query at all for a wildcard, a bare
  bundle id or the other build's identifier.
- **Why not the login keychain**, which the spec suggested. A review showed that
  `security add-generic-password -A` plants an item there silently, with an ACL that trusts every
  app. A program could plant a key of its own choosing before Shell was first turned on, compute
  both seals, and write all four preferences: Shell on, "Don't ask", no prompt anywhere. The
  `ShellSeal.swift` header has the detail. That mechanism was dropped, and with it the spec's
  claim that a planted key raises a Keychain prompt.
- **The Debug build has its own key.** Its identifier, `io.mgcrea.cupertino.debug`, is both in the
  sealed text and in the access group, so a seal from one build never validates in the other. The
  Debug group carries the legacy prefix `CDV6DT8QF2` that Xcode's wildcard profile gave it, as
  signed on 2026-10-27; the code reads the prefix from the signature rather than assuming one.
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

- **Through zsh with no startup files, `/bin/zsh -f -c`.** `-f` is NO_RCS: zsh reads none of the
  person's startup files (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`, `~/.zlogin`), and the only file
  it can read is a root-owned `/etc/zshenv`, if there is one. `jxa` is `osascript -l JavaScript`.
  Interpreters that are not installed are skipped by the check and say so ("ShellRunner: no shell
  startup files", "`<interpreter>` runs through zsh with no startup files").
- **The script reaches the interpreter as an argument, never a file.** For `zsh` it is the
  argument after `-c --`. For the others zsh `exec`s the interpreter with the script as an argument
  of its own: `bash -c -- <script>`, `python3 -I -c <script>`, `node --eval=<script>`,
  `osascript -e <script>` and `osascript -l JavaScript -e <script>`. Until 2026-10-28 the script
  was written to a file in `$TMPDIR` and read back by path, and any process running as the person
  could rewrite or rename that file between the write and the read, Full Disk Access or not: the
  person approved one text, another ran with every grant, and the record hashed the first. The
  kernel copies an argument into the new process at `exec`, and nothing else can reach it there. A
  file removed once opened would be no better, since whoever opened it first could still write to
  it. `--` and `--eval=` keep a script that starts with a dash from being read as options;
  `python3 -c` and `osascript -e` take the next argument whatever it starts with. A multi-line
  script as one `-e` compiles as it does from a file, for AppleScript and for JavaScript, shebang
  line included (tried 2026-10-28). `ARG_MAX` is 1 MiB for the arguments and the environment
  together; the environment is a few short variables, so a 512 KB script fits. For every installed
  interpreter, `make shell-check` ("ShellRunner: the script reaches the interpreter as an argument,
  never a file") gives the run a scratch `$TMPDIR` and has the script search it for a marker its
  own text holds, finding no file; runs a script with several lines, both quote marks and a `$`;
  and runs a 512 KB script. What changes for a script: `$0`, `__file__` and `__filename` no longer
  name a script file, and on Node 23.6 and later `--eval` falls back to stripping TypeScript types
  when the text is not valid JavaScript, which a file without an extension did not. Any process
  running as the person can still read the script in the process list, as it could read the file.
- **PATH is listed by root-owned files, not made of root-owned folders.** It is built from
  `/etc/paths` and `/etc/paths.d`, both owned by root, in the order `path_helper` reads them for
  Terminal, then `/opt/homebrew/bin`, `/opt/homebrew/sbin` and `/usr/local/bin` where they exist
  and are not listed yet ("ShellRunner: the search path, from /etc only"). If `/etc/paths` cannot
  be read, `/usr/bin:/bin:/usr/sbin:/sbin` stands in for it. The folders those files name need not
  be root's: see [What the window cannot show](#what-the-window-cannot-show). Interpreters installed
  through nvm, pyenv or asdf are not found unless the script sets them up itself, for example with
  `source ~/.nvm/nvm.sh`, and that line then shows in the window with the rest.
- **Which interpreter a name finds depends on the Mac.** On this Mac, on 2026-10-28 (macOS 27.0.1),
  `/etc/paths` lists `/usr/local/bin` first, then `/System/Cryptexes/App/usr/bin`, `/usr/bin`,
  `/bin`, `/usr/sbin` and `/sbin`, and `/opt/homebrew/bin` comes later from
  `/etc/paths.d/homebrew`. `/usr/local/bin` is root's here and holds no interpreter, so `python3`
  is Apple's `/usr/bin/python3` and `node` is Homebrew's `/opt/homebrew/bin/node`. On a Mac where
  `/usr/local/bin` holds a `python3`, `bash` or `osascript` (Intel Homebrew, a python.org install),
  that one is found ahead of `/usr/bin`'s. A script that wants a particular one names its path.
- **Finding an interpreter starts nothing.** `ShellRunner.resolve` walks that PATH in Swift, so
  `apple_shell_diagnostics` starts no process at all ("resolving every interpreter starts no
  process").
- **python3 runs isolated, as `python3 -I`.** No user site-packages, so no `.pth` file or
  `usercustomize` there runs, and not the current folder on `sys.path`, so a `json.py` planted in
  the folder the run starts in, or in its `$TMPDIR`, does not shadow the standard library's
  ("ShellRunner: python3 runs isolated", with a non-isolated control that does run the planted
  files). The check plants in the user site-packages only when python3 reports them inside its
  scratch home, and fails rather than plant anywhere else. `PYTHON*` variables are ignored too: `-I`
  ignores them, and none reaches the script anyway ("env has only the base keys"). A script that
  needs the user site-packages adds them to `sys.path` itself.
- **A minimal environment:** `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and that `PATH`.
  Nothing of Cupertino's own environment, and none of the `APPLE_*` server variables ("env has only
  the base keys"). Signal dispositions are reset, so the app's ignored SIGPIPE does not reach the
  script ("SIGPIPE is back to its default in the script"). Only the three pipes are inherited
  (`POSIX_SPAWN_CLOEXEC_DEFAULT`), which no check pins.
- **Its own process group.** At the timeout, or at a cancel, the group gets SIGTERM, then SIGKILL
  once the group is empty or 2 s have passed. A finished run leaves the list of live runs before
  its leader is reaped, so a quit sweep that reads the list from then on never signals a group id
  that may already be someone else's; one that read it a moment before keeps that narrow window.
  The grace belongs to the whole group, not only the leader, so a member that traps SIGTERM to
  clean up gets it even when the leader dies at once.
  "timeout killed the backgrounded grandchild" is checked by the grandchild's pid being gone.
- **Output.** stdout and stderr are drained concurrently, each capped at 256 KB with the rest read
  and discarded, so a child writing 10 MB never blocks. Decoded as UTF-8 with replacement
  characters.
- **`sudo` is expected to fail for want of a terminal (not measured).** Started the usual way
  (Finder, a login item, `open`), Cupertino has no controlling terminal, so a script has none and
  `sudo` cannot ask for a password. Started from a terminal (`make run`) or from Xcode, it may have
  one: `ShellRunner` calls no `setsid`, so a script can inherit that terminal. None of this says
  anything about a `NOPASSWD` sudoers rule, `sudo -S` reading a password from `stdin`, or Touch ID
  for `sudo`, none of which has been tried. Nothing works around it on purpose.

### Why no startup file is read

Until 2026-10-28 every run, and every interpreter lookup, started `/bin/zsh -l -c`, a login shell
that reads `~/.zshenv`, `~/.zprofile` and `~/.zlogin`. Any process running as the person can write
those files, with Full Disk Access or without it. One that wrote `~/.zshenv` then had it run under
Cupertino's grants the next time anything called `apple_shell_diagnostics`, which shows no window
and leaves no line in the run record; and every approved run read files the window never showed.
That was closed on 2026-10-28 by `-f`, the PATH from `/etc`, a lookup that starts nothing, and
`python3 -I`.

### What the window cannot show

The window shows the script, not what the programs it calls will do. Residuals no check pins:

- **The interpreter itself can be the person's to replace.** This is the most direct case. The
  interpreter is resolved from the same PATH as everything else, and `node`, and Homebrew's
  `python3`, live in `/opt/homebrew/bin`, which the user owns on this Mac (checked 2026-10-28).
  `/usr/local/bin`, first in `/etc/paths`, is user-owned on an Intel Homebrew Mac and can hold a
  python.org `python3`, ahead of `/usr/bin` for `bash`, `osascript` and `python3`. A same-user
  process can replace that binary, and every approved run with that interpreter then runs its code.
- **So can any binary on PATH.** The same folders hold the programs a script calls. A same-user
  process could replace one, or shadow a command with one of the same name earlier on PATH.
- **So can anything the script reads or sources.** A file the script sources, a module it imports
  from a writable folder, a config file a tool it calls reads: all run or are read with the run's
  grants, and none is in the window.
- **node's `require()`.** With `--eval`, a non-core module name resolves from a `node_modules`
  folder in the folder the run starts in or any folder above it, and then from `~/.node_modules`
  and `~/.node_libraries`. The user can write to all of them, so a planted module there can shadow
  a package the script asks for. Ruled a residual: it only loads a module the script itself names.

## Cancellation, switching off and quitting

- **Esc in the client, or a hang-up, cancels a waiting window or a run.** The connection's frames
  are read on one thread and its requests handled on another, so a `notifications/cancelled`
  reaches the call while it waits (`InProcessCalls`). This holds even when the cancel arrives
  before the call registered: a cancel for an unregistered id leaves a tombstone, a hang-up marks
  the connection closed, and a later registration meets either and cancels at once. Then nothing
  is asked and nothing runs. `make host-check` pins the loop; `make shell-check`, "ShellServer:
  stopping", pins "a cancel that beats the call", "a hang-up that beats the call", "a cancel that
  beats the window" and "a cancel mid-run stops it".
- **A call whose id is null or a fraction is still stopped by a hang-up.** Such an id cannot be
  named by a cancel, so the call is registered under a private key no cancel can name, which a
  hang-up still reaches (`make shell-check`, "a call whose id is null is stopped by a hang-up",
  and the same for a fraction).
- **A hang-up also ends the session approval** and that connection's own cooldown. The client
  name's cooldown stays until it ends.
- **Turning Shell off** closes every waiting window, stops every run and drops every session
  approval (`make shell-check`, "stopAll").
- **At quit and at an update relaunch,** `ServerHost.terminateChildren` stops Shell's calls first,
  then sends each live run group SIGTERM and then SIGKILL after a 3 s grace that belongs to the
  whole group, not only its leader (`ChildTermination.terminateGroups`; `make shell-check`,
  "ChildTermination: a process group that will not stop"). It then waits up to 1 s for open calls
  to settle and sweeps the groups a second time, because a call that passed its last cancel check
  just before the first sweep can spawn after it. Last, it drains the run record so the final lines
  are written.

**What a stop cannot reach (known residual, no check pins it).** Every stop above, at a timeout, a
cancel, switching off or quitting, signals the run's process group, so it reaches only what is
still in that group. A script that double-forks through `setsid`, hands a job to `launchctl submit`,
or starts an app with `open` leaves processes that survive the stop, with nothing supervising them.
No supported macOS API tracks processes once they leave the group. The same holds when Cupertino
itself ends mid-run: a script that runs `kill -9 $PPID`, a crash or a force-quit leaves the run
going with nobody to stop it, its group included. The run record still has its started line,
written before the script was spawned, with no outcome after it (see below). The forked process
keeps Cupertino as its responsible process, and so keeps Cupertino's grants. A `launchctl submit`
job and an app started with `open` are spawned by launchd and are normally their own responsible
process, so they are expected not to hold Cupertino's grants; that has not been measured.

## What is recorded

### The run record, always on

Every request leaves a line, a refusal as much as a run, whatever the activity and audit settings
say. A run leaves two: a **started** line, with the decision, the hashes and the rest of the
request, written and waited for before the script is spawned, and an **outcome** line once it is
over. Both carry the same `runId`. So a script that ends Cupertino, a crash or a force-quit still
leaves the request on the record, as a run with no outcome. Recent runs folds the pair into one row,
and shows a started line with nothing after it as "no outcome recorded"; that is also what a run
still going shows. A refusal never starts, so it is one line. Lines written before 2026-10-28 have
no `runId` and still read and verify (`make shell-check`, "ShellRecord: a run's started line and
its outcome", and "the started line is on disk before the script runs", where the script reads the
record itself). It is at `~/Library/Application Support/io.mgcrea.cupertino/shell-runs/`
(`io.mgcrea.cupertino.debug` for the Debug build), in monthly files `runs-YYYY-MM.jsonl`, in a 0700
folder. Each line holds:

- the time, the client name and the connection id
- `purpose`, the interpreter and `cwd`
- the script's byte count and a SHA-256 over its full text
- stdin's byte count and SHA-256, when stdin was given
- the decision: `approved`, `approvedForSession`, `notAsked`, `declined`, `noAnswer`, `cooldown`,
  `busy`, `cancelled` or `invalid`
- the exit code or signal, whether it timed out, and the duration, on the outcome line
- `runId`, and `started: true` on a started line

**The run record never holds the text of the script or of stdin, or any output.** That is a
property of this record only: the activity log and the audit file can hold the first 4 KB of the
arguments, script and stdin among them (see below). The hashes close the gap those leave: they
keep at most 4 KB of a call's whole arguments object, so a script hiding its payload past that much
harmless text would be logged without it, and stdin can carry the real payload (`sh -s`). Lines are
chained with `AuditChain`, which gives tamper evidence, not prevention: a same-user process can
still delete the files. 90 days are kept. The Shell pane lists the 20 most recent under "Recent
runs", with a 12-digit prefix of each script's hash. `make shell-check`, "ShellRecord" and
"ShellServer: the record", pins one line per request, every decision by its name, the hash, and no
script text or output on file.

### Through the activity log

Shell calls also go through the existing activity log path, under its existing settings.

- **The call's arguments** are kept in the Activity window as for any tool, in the "Arguments" and
  "Arguments and results" capture modes (`captureMode.shell`, falling back to the app-wide
  `captureMode`). The 4 KB cap applies to the whole encoded arguments object, not to each argument,
  and its keys are sorted, so `cwd`, `interpreter` and `purpose` come before `script`: less than
  4 KB of a script is ever logged. The run record's SHA-256 covers the whole script, which is why
  it exists.
- **A result** is kept only in the "Arguments and results" mode. In the default mode, "Arguments",
  no result row is written at all, and the run record covers it. When a result is kept, it keeps the
  decision, exit code, signal, timeout and duration whatever the content switch says. stdout and
  stderr reach the Activity window only under the content switch for Shell, `captureContent.shell`,
  which falls back to the app-wide `captureContent`, because output can be the text of somebody's
  mail.
- **The audit file**, off by default, gets every call's arguments when `auditEnabled` and
  `auditPayloads` are both on, in either capture mode that keeps arguments. `auditContent` does not
  strip arguments that fit the 4 KB cap, because `script`, `stdin`, `purpose` and `cwd` are not
  among the keys it treats as content: arguments under 4 KB, the script and stdin among them, reach
  disk in plain text. Arguments over 4 KB were cut to a prefix that is no longer JSON, and without
  `auditContent` the whole value becomes «redacted» on disk; with `auditContent` on, the first 4 KB
  reach disk as captured. It gets a Shell result with its decision and exit only when
  `auditEnabled` and `auditPayloads` are both on, the capture mode is "Arguments and results", and
  the live capture kept the row in the first place. On the way to the file, `auditContent`
  re-redacts it: without that switch, stdout and stderr are taken out again, even when the
  Activity window kept them, and the decision and exit stay.

`make shell-check`, "ShellServer: through the activity log", pins these rules on `CallCapture`,
the audit file's treatment of arguments under and over 4 KB among them ("on disk without content:
arguments under 4 KB keep the script", "and arguments over 4 KB become «redacted»"), and that every
other tool records exactly what it did before.

## What pins what

| Check                     | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make unit`               | `ShellPolicy`: cooldown beats "Don't ask", a session approval and busy; a session approval expires at 30 min; ask never offers it; busy at 4                                                                                                                                                                                                                                                                                                                                                                               |
| `make shell-check`        | the seal and its key query, the pane's switch steps and copy, the run record and its started and outcome lines, the runner (the script as an argument and never a file, no startup files read, PATH from `/etc`, a lookup that starts nothing, python3 isolated), the server's decisions (the name's cooldown, the four-window cap, approvals withdrawn on a change), cancellation, the client's words made safe to show, `ShellCover`, `ShellPlatform` and `ShellPanels`, the activity log and the audit file's arguments |
| `make shell-window-check` | the run buttons refuse both Accessibility entry points, `performClick` and a sent action; the sheets' confirms the same; a window with no screen; `CoverWatch` starts the buttons off, gives them a click-time test and names the cover                                                                                                                                                                                                                                                                                    |
| `make desktop-check`      | a click or drag on an open Shell window or sheet is refused before anything is posted                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `make host-check`         | cancel for an unknown id, cancel mid-call, EOF mid-call, a cancel or EOF that arrives before the call registers                                                                                                                                                                                                                                                                                                                                                                                                            |
| `make dispatch-check`     | the `shell` case reaches `ShellServer` with its connection                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`shell-check` and `shell-window-check` run in CI. At the final fix wave, on 2026-10-28,
`shell-check` passed 367 of 367, `shell-window-check` 50 of 50, `unit` 293 of 293, `host-check` 26
of 26, `dispatch-check` 83 of 83 and `desktop-check` 175 of 176 with 1 skipped (172 of 173 before
the wave). Neither Shell check posts an event, shows a window, or touches the real Keychain or the
app's own defaults.

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
- **A Desktop click on Run once is dropped.** With the Shell window up, an `apple_desktop_click`
  at Run once's point must come back refused, with nothing posted.
- **An Accessibility value write to the script text view is refused or harmless.** The script is
  shown in a non-editable text view; a program setting its `AXValue` must either be refused or
  change only what is drawn, never what runs (the run takes the text the request carried).
- **Screen Sharing, Universal Control and Sidecar input fail safe.** A click that arrives through
  any of them must either be refused as not hardware, which times out as a no, or be a person's
  own click; it must never let a program approve a run.
- **The covered-window check without Screen Recording**, and with a real borderless window from
  another process over the Shell window: Run must stay off and the window must say why.
- **The release notes assume the hardware rule.** The CHANGELOG's "only a click by hand on Run once
  runs it" holds only if `ShellInput.isHardware` is right. Olivier must confirm the measurement
  above before the release that carries Shell.
