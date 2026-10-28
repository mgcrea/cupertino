# Shell surface: design

> Superseded on 2026-10-28 for how a run starts (`-f`, not `-l`; no process to look up an interpreter; `python3 -I`); see docs/shell.md.

Date: 2026-10-27. Status: design approved by Olivier in chat on 2026-10-27, with the review's three questions
answered the same day; this document is the write-up, for planning.

## Why

Cupertino holds one Full Disk Access grant, and every surface spends it on one app through a
narrow, scoped tool set. Work outside those tools that needs the same grant has nowhere to go. On
2026-10-27 a Claude session tuning Mail and Reminders reads had no FDA of its own, so every probe
went through Olivier pasting commands into a second session that had it. Olivier's framing is
wider than Cupertino's own development: "it could be useful for other work", with "a dialog
prompt to ask for confirmation (optionally bypassable in settings)".

So the surface is a general command runner that executes under Cupertino's grants, shipped to
everyone who installs Cupertino, off by default, with a confirmation before each run.

## The risk this has to carry, stated once

Every other surface reaches one application and is bounded by write switches, gates and account
allowlists. A command running under Cupertino's grants gets past all of them: it can read
`chat.db`, the Envelope Index, Safari history and anything else Full Disk Access opens, and it
can send Apple Events to every app Cupertino was already granted Automation for. An agent that
reads a mail or a web page saying "run this" is the realistic attack. **The confirmation window
is the only safeguard left, and the bypass setting removes it.** The design below is built
around that: the window shows the code, not a summary; the safe answer is the default; and even
with the bypass on, a run is never invisible.

## Goals

- An agent can run a one-shot script under Cupertino's grants and get its exit code and output.
- The person decides each run from the script's actual text, in a window they cannot mistake for
  anything else.
- The person can lower the friction to once per connection, or to none, knowingly.
- Only the person can approve a run or lower the bar. A program running as them, including an
  approved script, cannot.
- Every request leaves a record of what was asked and what was decided.

## Non-goals

- Interactive sessions, a PTY, or anything that waits for typed input.
- Processes that outlive the call. The run's process group is killed when the call ends.
- Elevated privileges. `sudo` fails for want of a tty, and the docs say so; nothing works around it.
- File upload/download tools, an environment-variable parameter, a read-only SQL tool. Each is a
  possible later surface or parameter, not v1.

## Anti-goals (a failure even if it works)

- A run that happens without the person being able to see that it happened.
- A window where Return, or a stray click on the default button, runs the script.
- A window that shows the agent's description of the script instead of the script.
- A child process left running after Cupertino quits, still holding its grants.

## The surface

A new in-process Swift surface, a capability like Screen, Sound and Desktop.

`surfaces.json` entry (then `make surfaces`; see `docs/surfaces.md`, "What a new surface costs"):

| Field              | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| `id`               | `shell` (Olivier said "terminal"; renamed because nothing is interactive)   |
| `displayName`      | `Shell`                                                                     |
| `kind`             | `capability`                                                                |
| `runtime`          | `swift`                                                                     |
| `npmName`          | `null`                                                                      |
| `bundleId`         | `null`                                                                      |
| `iconPath`         | `/System/Applications/Utilities/Terminal.app`                               |
| `symbol`           | `terminal`                                                                  |
| `usesAppleEvents`  | `false` (the surface sends none itself; a script may, under its own grants) |
| `appleEventsScope` | `null`                                                                      |
| `supportsWrites`   | `false` — see below                                                         |
| `defaultEnabled`   | `false`                                                                     |
| `envPrefix`        | `APPLE_SHELL_`                                                              |
| `gates`            | none                                                                        |
| `notes`            | the risk paragraph above, condensed                                         |

`supportsWrites: false` and no gate, **my call**, following Screen's note in `surfaces.json`: "A
second gate would be worse than none". Running a script is the only thing the surface does, so
the surface switch is the gate, and a write switch on top would be a second switch that is
always on whenever the first is. Turning the surface on shows the risk paragraph and needs a
confirming click, the first time and every time it goes from off to on.

`storePermission`: `full-disk-access`, an existing value. The surface works without FDA. The
command then just has whatever else Cupertino holds, and diagnostics say so.

**Not offered to the Chat pane** (**my call**). `ChatPane.picks` offers every enabled surface;
Shell is filtered out, so the on-device model never asks to run scripts and no window ever names
Cupertino itself as the client.

## Tools

### `apple_shell_run`

| Parameter        | Type                                                                | Notes                                                                  |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `script`         | string, required                                                    | The program text.                                                      |
| `purpose`        | string, required                                                    | One sentence from the agent: why it wants this. Shown as its words.    |
| `interpreter`    | enum `zsh` (default), `bash`, `python3`, `node`, `osascript`, `jxa` | `jxa` is `osascript -l JavaScript`.                                    |
| `cwd`            | absolute path, default `~`                                          | Refused if it does not exist or is not a directory.                    |
| `stdin`          | string, optional                                                    | Written to the child's stdin, then closed. No stdin means `/dev/null`. |
| `timeoutSeconds` | integer, default 60, range 1…600                                    | Wall-clock time of the run, not counting the time the window waits.    |

Returns structured content:

```jsonc
{
  "decision": "approved" | "approvedForSession" | "notAsked",
  "exitCode": 0,          // null when killed
  "signal": null,          // "SIGKILL" etc. when killed
  "timedOut": false,
  "durationMs": 412,
  "stdout": "...", "stdoutTruncated": false,
  "stderr": "...", "stderrTruncated": false
}
```

A refusal, a window nobody answered, a cooldown, a bad `cwd` or a full run queue come back as
`isError: true` with a message. Annotations: `destructiveHint: true`, `openWorldHint: true`.

Refusal and no-answer messages reuse the wording of the driving refusals
(`DrivingSession.swift` around line 208 and line 491): nothing ran, ask the person in the
conversation, do not retry.

### `apple_shell_diagnostics`

The same shape as the other surfaces' diagnostics. It reports:

- the "Before running" setting
- whether Cupertino holds Full Disk Access
- which interpreters resolve on the login-shell PATH, and where they resolve to
- the number of runs in flight

### Server instructions

One short paragraph covering:

- the person sees and approves every run (unless they have turned that off)
- a refusal means ask them, not retry
- batch work into one script rather than many small runs, because each run can cost the person a
  decision

## How a run executes

- **The grant comes from parentage.** Cupertino spawns the command as its own child. macOS holds
  the responsible process accountable, and that is Cupertino, the same mechanism the Node servers
  already rely on (`Permissions.swift` around line 466: "the responsible pid of a `node` server is
  this process"). Every grant Cupertino holds applies, not only Full Disk Access. Accessibility
  for grandchildren is unreliable, as measured in the same comment, and the docs say so rather
  than promise it.
- **Login shell, so PATH matches Terminal.** The servers are handed `PATH=/usr/bin:/bin`
  (`surfaces.json`, Screen's notes), which would hide Homebrew's `node`, `python3` and the rest.
  Every interpreter is therefore resolved and started through `/bin/zsh -l -c`. For `zsh` the
  script is the `-c` argument. For the others it is written to a 0600 file in Cupertino's
  temporary directory, run as `exec <interpreter> <file>`, and removed after the run.
- **Environment.** A minimal base (`HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`,
  `PATH=/usr/bin:/bin:/usr/sbin:/sbin`) that the login shell then extends. Nothing from
  Cupertino's own environment leaks in, and none of the `APPLE_*` server variables.
- **Its own process group** (`posix_spawn` with `POSIX_SPAWN_SETPGROUP`; `Process` cannot do
  this). At the timeout, or when the connection closes mid-run, the group gets SIGTERM, then
  SIGKILL after 2 s, so backgrounded grandchildren go too.
- **At quit and at an update relaunch**, running shell children are stopped together with the
  servers. `ChildTermination.terminateAll` takes `[Process]` and signals single pids, so it gets a
  process-group sibling, called from the same place (`ServerHost.swift` around line 386). Its
  header gives the reason, and it applies here doubly: a child left behind keeps its grants with
  nothing supervising it.
- **Switching Shell off mid-run** kills runs in flight and closes any window still waiting.
- **Output.** stdout and stderr are drained concurrently and each is capped at 256 KB, with the
  rest read and discarded so the child never blocks on a full pipe. Decoded as UTF-8 with
  replacement.
- **Concurrency.** At most 4 runs in flight app-wide, **my call**. A fifth is refused with a
  message rather than queued silently. Requests waiting for the window queue in arrival order,
  one window at a time.

The handler blocks the connection's thread while the window waits and while the command runs.
Nothing server-side cuts the call off: the bridge and the host clear `SO_RCVTIMEO` after the
handshake (checked 2026-10-27). Only client-side limits are unknown; if one is shorter, the docs
say so and the default timeout stays 60 s.

**Cancellation and hang-up (Olivier: "what you think is best").** Today `serveInProcess` reads
one line and blocks inside `InProcessServers.handle` until the reply, so while a run or a window
waits, nothing reads the socket: a client's `notifications/cancelled` (Esc in Claude Code) is
never seen, and neither is a disconnect. The read loop changes so it keeps reading while a call
is in flight:

- Requests are handed to the surface as today. Frames that arrive meanwhile are read on the
  connection's thread.
- A `notifications/cancelled` naming an in-flight request id calls a canceller the surface
  registered for that id. Shell registers one, which closes its window or kills the run's group
  and returns the cancelled error. A surface that registers none ignores it, which is what every
  surface does today.
- EOF on the socket ends every in-flight call on the connection the same way. For Shell that
  means the window closes, the group is killed and the session approval ends.
- Ordering is unchanged. A second request arriving mid-call waits for the first, as it does now,
  because the client already serialises per connection. Only notifications are acted on early.

This touches the loop every in-process surface shares, so `host-check` and `dispatch-check` gain
cases: a cancel for an unknown id is ignored, a cancel mid-call reaches the registered canceller,
and Screen, Sound, Desktop and Simulator behave as before.

## The confirmation window

A real window, not the 60 px driving card (`DrivingOverlay`). It is centred on the screen with
the mouse and floats above other windows. Contents, top to bottom:

1. A title: "**<client>** wants to run a command with Cupertino's access". `<client>` is the MCP
   `clientInfo.name` from `Sessions`. A smaller line says the client names itself and Cupertino
   cannot verify it.
2. The agent's `purpose`, in quotes, labelled "The agent says:".
3. The **full script, verbatim**, monospaced, selectable, not editable, scrollable. Long scripts
   scroll and are never elided. `stdin`, when given, is shown the same way under its own label.
4. The interpreter, the `cwd` and the timeout.
5. One fixed sentence of risk: this can read everything Cupertino can, including mail, messages
   and browsing history, and can control apps Cupertino controls.
6. Buttons:
   - **Don't run**: the default button. Return and Escape both mean this.
   - **Run once**
   - **Run, and stop asking this session**: shown only when the setting is "Ask once per session",
     see below.

No answer within **60 s** (**my call**) is a no. The window closes itself, and the call returns
the no-answer error.

**Cooldown.** After "Don't run" or no answer, the same connection is refused for 30 s without a
window (`DrivingPolicy.declineCooldown`'s reasoning: a retrying agent must not put the window
straight back in front of the person who just closed it).

**Bringing it forward.** The window has to be key to be answered. Because Return means "Don't
run", taking focus from someone mid-sentence fails safe. The builder decides whether to activate
Cupertino or only order the panel front, and tests what a keystroke typed into it does.

**Only a person can approve.** The window accepts only hardware input. A click or keystroke
posted by a program (a `CGEvent` from any process, including an approved script running under
Cupertino's own Accessibility grant) is dropped, the way `FirstClickHostingView` already drops
them for the driving card. The same applies to the confirming clicks in the settings below. The
builder confirms the test it uses tells a posted event from a real one, with a script check that
posts one and sees it ignored.

## The "Before running" setting

In the Shell pane, three choices:

| Choice                       | Behaviour                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask every time** (default) | Every run shows the window. The third button is not shown.                                                                                                                                                                             |
| **Ask once per session**     | The window shows the third button. Choosing it approves later runs on the same connection until the connection closes or **30 min** pass (**my call**), whichever comes first. A session approval never carries to another connection. |
| **Don't ask**                | No window. Choosing this setting shows a warning sheet naming the injection risk and needs a confirming click.                                                                                                                         |

Whatever the setting, a run that shows no window shows the non-blocking info card ("Running a
command for <client>"). The run can be stopped from it or from the menu bar. `VisibleTools.InFlight`
drops a notice after 30 s and keys it on an app bundle id, so Shell gets its own notice kind with
no cap that lasts as long as the run. **Keeping the card under "Don't ask" is my call.**

### Settings a program cannot forge (Olivier: agreed)

Cupertino is not sandboxed, so any process running as the user can write its preferences. A
session with a shell but no Full Disk Access could otherwise run
`defaults write io.mgcrea.cupertino surfaceEnabled.shell -bool YES` and
`shell.before -string none`, and turn "has a shell" into "has Full Disk Access" with no window.
So the two settings that lower the bar are not trusted from `UserDefaults`:

- **"Shell is on"** and **"Don't ask"** count only when they carry a seal Cupertino made. The
  suggested mechanism is an HMAC over the value and the app's identifier, with a key kept in the
  Keychain under an item Cupertino created, so its ACL trusts Cupertino alone. Another process
  reading the key raises the system's own prompt. The builder may choose a different mechanism,
  but it has to satisfy the test below.
- A missing, unreadable or invalid seal reads as **off**, and as **Ask every time**. Deleting the
  key or the preference therefore fails safe.
- No launch argument sets either. `-shell.before none` and `-surfaceEnabled.shell YES` are
  ignored, unlike `driving.before`. "Ask every time" and "Ask once per session" need no seal:
  they still put a window in front of a person.
- The seal is written only from the settings pane, after a hardware click on the confirming
  sheet.
- The Debug build has its own identifier and so its own key. A seal from one build never
  validates in the other.

The test: with Shell off in the app, `defaults write` both keys, relaunch, and confirm that
`apple_shell_run` is not listed. Then turn Shell on in the app, `defaults write shell.before
none`, and confirm the next run still shows the window.

`shell.before` is still stored as `ask` | `session` | `none`, with the seal beside it.

The decision is a pure function in `ShellPolicy.swift`, modelled on `DrivingPolicy.swift`:
Foundation only, no AppKit, compiled into `make unit`. Its inputs are the setting, the
connection's session approval (expiry date or nil), its cooldown (date or nil), runs in flight,
and now. Its outputs are `.run(notice: Bool)`, `.ask(timeout:, offerSession: Bool)`,
`.declined(retryIn:)` and `.busy`. A cooldown outranks everything, including "Don't ask", for the
reason `DrivingPolicy.decide` gives.

## Audit

### The run record, always on (Olivier: agreed)

Every request leaves a record whatever the activity and audit settings are. The existing paths
cannot provide that on their own. The audit file is off by default, the Activity window's default
capture mode keeps no result, and each argument is cut at 4 KB (`CallCapture.byteCap`), so a
script hiding its payload after 4 KB of harmless text would be recorded without it.

So Shell writes its own record to `~/Library/Application Support/<app id>/shell-runs/`, one line
per request. Each line holds:

- the time, the client name and the connection id
- `purpose`, the interpreter and `cwd`
- the script's byte length and **SHA-256 over the full text**
- the decision
- exit code or signal, timed out, duration

It never holds the script text or the output.

Lines are chained with `AuditChain` (**my call**). The chain gives tamper evidence, not
prevention: a same-user process can still delete the file. The record keeps 90 days (**my
call**). The Shell pane lists the most recent 20 runs (**my call**), so the person can see what
ran without opening a file.

### Through the existing log

Every request is also recorded through the existing activity log path, under its existing
settings. The call record carries the
script, `purpose`, interpreter and `cwd` under the existing payloads switch (`AuditLog`'s
`auditPayloads`). The result record carries:

- the decision: approved, approved for the session, not asked, declined, no answer, cooldown or
  busy
- the exit code or signal
- whether it timed out
- the duration

stdout and stderr are recorded only under the content switch (`auditContent`), because output
can be the text of somebody's mail. The builder checks how `CallCapture` records in-process
calls today and extends it rather than writing a second path.

## Files

New, under `apps/apple/Cupertino/`:

- `ShellServer.swift`: the JSON-RPC tool surface, like `ScreenServer.swift`.
- `ShellPolicy.swift`: the pure decision.
- `ShellRunner.swift`: spawn, process group, output caps, timeout and kill. Foundation only, so a
  script check can compile it.
- `ShellConsent.swift`: the window and the queue.
- `ShellSeal.swift`: sealing and checking the two protected settings.
- `ShellRecord.swift`: the always-on run record.

Changed:

- `surfaces.json`, then the generated files (`make surfaces`)
- `InProcessServers.swift`: a `case "shell"`, with the `connection` passed through
- `ServerHost.swift`: the `serveInProcess` read loop (cancellation and EOF), and `surfaceEnabled`
  for `shell` read through the seal
- the settings pane for the setting and the enable confirmation
- `ChildTermination` callers, for quit and relaunch
- `Makefile`: `ShellPolicy.swift` in `unit`, and a new `shell-check` target

Docs:

- `docs/shell.md`: what the grant reaches, the threat model, `sudo`, Accessibility caveats, the
  setting
- a row in `docs/surfaces.md`, "State of play"
- `README` and the website surface list via the generated paths
- the `CHANGELOG` Unreleased section

## Verification

- The forging test under "Settings a program cannot forge", and a posted `CGEvent` dropped by
  the window and by the confirming sheet.
- `host-check`: the cancellation and EOF cases listed under "Cancellation and hang-up".
- The run record: one line per decision, including refusals; the hash matches a script over
  4 KB; no script text or output in the file.
- `make unit`: every `ShellPolicy` combination. The cooldown beats "Don't ask"; a session approval
  expires at 30 min and does not cross connections; "Ask every time" never offers the third
  button; busy at 4.
- `make shell-check` (new, `scripts/shell-check.swift` compiling `ShellRunner.swift`):
  - exit codes
  - stderr kept apart from stdout
  - `cwd` honoured, and a bad `cwd` refused
  - `stdin` delivered
  - truncation at the cap without a hang (a child writing 10 MB)
  - a timeout kills a backgrounded grandchild (`sleep 100 &` then `wait`), checked by its pid being
    gone
  - each interpreter resolves through the login shell where it is installed, skipped where it is
    not (CI)
- `dispatch-check`: the `shell` case is reached and is given the connection.
- By hand on the Debug build (`use-the-dev-build`; the Debug app has its own FDA grant):
  - the window shows the full script
  - Return and Escape decline
  - no answer declines at 60 s
  - the cooldown holds
  - a session approval works and ends when the connection closes
  - "Don't ask" shows the card
  - a script reading `~/Library/Messages/chat.db` succeeds only with FDA granted to the Debug app
  - quitting Cupertino mid-run leaves no child behind (`pgrep`)

## Left to the builder

- Window layout and copy beyond the fixed sentences above, within the order given.
- Whether the window activates Cupertino or only orders front.
- Temporary file location and naming.
