# Desktop waits, step selectors and committed writes: design

Date: 2026-10-30. Status: approved by Olivier in chat on 2026-10-30 ("go"); this document is the
write-up. Items 1 to 4 are built on `feat/desktop-waits`; 5 and 6 are left for later.

## Why

A Claude session testing Drakar's rewind sheet on 2026-10-30 spent most of its time working around
the desktop surface rather than testing:

- **Menus close between calls.** `run` refuses a step without its handle, so a step cannot press an
  item a previous step opened. To choose one it pressed the arrow and then sent ↓ ↓ Return blind,
  which twice left stray letters in Drakar's composer.
- **Waiting is polling.** `wait` sleeps at most 5 s, so "until the turn ends" took chains of waits
  and `find_elements` loops, four round trips for one check.
- **`set_value` claimed a write the app never took.** It answered `confirmed`, Send was pressed, and
  the prompt was never sent.
- **A crash looked like a busy app.** "Drakar did not answer in time. The app may be busy; retry"
  came back while Drakar was dead. `pgrep` found out.
- `name` does not match a static text's value, and disabled controls read `pressable: true`.

## What was measured, 2026-10-30

Probes in a scratch SwiftUI app (`NSHostingView`, accessory policy, never frontmost), driven from
the agent shell, which inherits Accessibility.

**An `AXValue` write on an unfocused SwiftUI `TextField` reaches the field and not the binding.**
Both a one-line field and an `axis: .vertical` one (Drakar's composer is the second) read back the
written text at once, while a `Text` bound to the same `@State` stayed empty at 0 ms, 100 ms and
1.1 s. So the read-back `set_value` relies on proves the field shows the text, not that the app has
it, and waiting longer does not help.

**Focusing the field first fixes it.** `AXFocused = true`, then the same `AXValue` write: the
binding updated on both fields, 6 of 6 with no settle time between the two writes, and the same
through `AXSelectedTextRange` + `AXSelectedText`. The app was not brought forward. Focus installs
the field editor, and a write through the field editor posts the change SwiftUI listens for.

**SwiftUI barely posts Accessibility notifications.** An observer registered for ten notifications
on the app element, over 3 s in which a `Text` changed six times and a `Button` appeared and
disappeared three times, received six `AXRowCountChanged` from a `List` and nothing else: no
`AXValueChanged`, `AXCreated` or `AXUIElementDestroyed`. A wait driven by notifications alone would
hang on a SwiftUI app. AppKit apps post them, so they are worth listening to as a way to wake early,
not as the mechanism.

**A dead application's element answers `kAXErrorCannotComplete` (-25204) at once**, for a read, a
press and a write alike, which `failure(for:)` maps to `.busy`. `AXUIElementGetPid` still answers
on that element, and `kill(pid, 0)` then says the process is gone.

## 1. A dead application is named as such

`resolveEntry`, which every handle verb goes through, checks the handle's process before the verb
acts: `AXUIElementGetPid`, then `kill(pid, 0)` failing with `ESRCH`. A dead one throws a new
`Failure.appQuit`, answered as "Drakar quit (pid 44616)." plus the newest crash report for that
executable in `~/Library/Logs/DiagnosticReports` from the last ten minutes, or a note that
ReportCrash takes a few seconds and none is there yet. A process that quit cleanly has no report,
and the answer does not claim a crash.

The executable name comes from the bundle (`NSWorkspace.urlForApplication(withBundleIdentifier:)`),
since the process is gone. A death between the check and the action still reads `busy`, and the
next call names it.

## 2. `apple_desktop_wait_for`

A read, registered with writes off too, and a `run` step.

- `bundleId`, and `id`, `role`, `name`, `value`, at least one, flat as `find_elements` takes them
  (a `run` step nests them under `match`, where `value` would collide with `set_value`'s). `id`
  and `role` match exactly, `name` and `value` by case-insensitive substring. `value` is the
  element's `AXValue`, read only when a `value` is asked for, so a search that does not use it costs
  what it did. `find_elements` gains `value` too.
- `state`: `present` (default) or `absent`.
- `window`, and the walk bounds `find_elements` takes.
- `timeoutMs`: default 10 000, at most 60 000.

The loop walks with the match inside the walk, as `find_elements` does, then waits up to 250 ms on
the thread's run loop with an `AXObserver` source attached for the app's pid. A notification ends
the wait early; the 250 ms re-check is what makes it correct on SwiftUI. Before each walk the
process is checked, as in item 1.

- `present` holds when at least one element matches. The answer carries them with handles.
- `absent` holds when nothing matches **and the walk was not cut short** by its node or time bound.
  A truncated walk that found nothing has not shown absence. A depth cap is reported but not
  treated as truncation, as everywhere else.
- A timeout is an error, so a `run` stops there. It says how long it waited, how many walks it
  took, and what the last walk saw: the matches, or that it was cut short.
- The app quitting is an error carrying item 1's answer.

Esc in Claude Code ends the wait within one re-check. Every desktop call registers a canceller with
`InProcessCalls` on the connection and request id `ServerHost` already supplies, and the wait loop
reads the flag. That covers a `wait_for` inside a `run` too, since the steps run on the same call.

## 3. `match` in place of `handle` in a `run` step

Any step whose tool takes a `handle` (`press`, `show_menu`, `select`, `set_value`, `focus`,
`raise_window`, `get_attribute`, `hover`, `type`, `key`) may give `match` and `bundleId` instead:

```json
{"tool": "show_menu", "match": {"id": "prompt.row"}, "bundleId": "io.mgcrea.Drakar"},
{"tool": "press", "match": {"name": "Rewind code"}, "bundleId": "io.mgcrea.Drakar"}
```

The step finds its element when it runs, through item 2's loop, waiting up to `waitMs` (default
2000, at most 10 000) for it to appear, so a menu an earlier step opened is found: an open menu
leads every walk already. If exactly one element matches, the step runs on it. If several match,
the step takes `index` when one is given and otherwise fails, listing the candidates. Nothing
matching within `waitMs` fails the step. The answer for the step names the handle it resolved.

Validation stays whole: a `match` must be an object with at least one key, and must come with
`bundleId`. `drag` keeps handles only.

## 4. `set_value` focuses a text element first

When the element's role is `AXTextField`, `AXTextArea` or `AXComboBox` and `AXFocused` is
settable, `set_value` sets it first, then writes. The answer gains `focused`. When focus did not
take, `confirmed` is still the read-back, and the note says the field shows the text but an app
built on SwiftUI may not have it, and to focus and type instead. A slider and anything else
without a field editor is written exactly as before.

## Left for later

5. **Smaller reads**: `enabled: false` on pressable elements and `press` refusing a disabled one as
   `press_menu` already does, plus a compact answer that drops `rect` and `depth`.
6. **`scroll_to`** for rows a lazy list has not built. `AXScrollToVisible` needs the element to
   exist, and these do not yet, so it has to scroll the container (its scroll bar's `AXValue`)
   until a `match` appears.

Also not done: a streaming `watch` command for Claude Code's `Monitor`, and a resource
subscription riding the observer. Claude Code does not subscribe to resources yet (CHANGELOG,
watches), so a push would never wake the agent; the blocking wait covers the same ground in one
call.
