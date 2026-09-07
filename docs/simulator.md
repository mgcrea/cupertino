# The iOS Simulator is a Mac window: what the desktop surface reaches inside it

[`desktop.md`](desktop.md) opens by calling the surface "the macOS analogue of what WebDriverAgent
gives `mcp-ios-device`". This is the other direction of that sentence, and it turns out not to be an
analogy: **Simulator.app bridges the simulated device's accessibility tree into the Mac's**, so
`apple_desktop_ui_tree` reads an iOS app's controls and `apple_desktop_press` presses them, with no
WebDriverAgent, no `xcodebuild`, and no runner process anywhere.

Measured **2026-09-06, macOS 26.6 (Darwin 25.6.0)**, against an **iPhone 17 Pro on iOS 26.5**
(402x874 pt) in Simulator.app, with `@mgcrea/mcp-ios-simulator` 0.2.0 and WebDriverAgent 16.12.3
answering on 8100 for the comparison. Two walks on the Photos grid, stable between them; one on
Settings.

**Verdict: a real capability, and NOT a replacement for WebDriverAgent.** It reaches a strict subset
of what WDA reaches — but a subset that is 100% named, an order of magnitude smaller, and that
contradicts WDA on the one thing WDA gets wrong. ~~The simulator is not in the brokered table, so all
of this needs **Reach any application** switched on.~~ **Superseded 2026-09-07:** it is a surface of
its own now — see [What shipped](#what-shipped) — and Simulator.app is a brokered application.

## The device screen is an `AXGroup` sized like the device

Inside `AXWindow "iPhone 17 Pro – iOS 26.5"`, past the bezel buttons and the toolbar, sits an
`AXGroup` whose size is exactly the simulated display in points. Its children are the iOS app's own
elements:

```
AXWindow "iPhone 17 Pro – iOS 26.5" [231,142 456x972]
  AXButton "Action" / "Volume Up" / "Volume Down" / "Sleep/Wake"   <- Simulator's bezel
  AXGroup [258,222 402x874]                                        <- THE DEVICE SCREEN
    AXStaticText "“Photos” Would Like to Send You Notifications"
    AXButton "Don’t Allow" [315,716 140x48]
    AXButton "Allow"      [463,716 140x48]
  AXToolbar [231,142 456x52]                                       <- Simulator's toolbar
```

Finding it is a size match rather than a path walk, because the chrome around it moves with the
window and the device kind. **AX frames are Mac-screen absolute**, so the iOS point space every
`mcp-ios-simulator` tool speaks is the frame minus that group's origin — here `(258, 222)`.
Subtracting it put the photo cells at `[0,136 132x133]`, against WDA's `[0,136,133,133]` for the
same cell. One point of rounding, same space.

## The write lane works

`AXUIElementPerformAction(kAXPressAction)` on the alert's `Don’t Allow` returned `.success` and the
alert went away. The button advertised `AXPress, AXScrollToVisible, AXCancel, AXShowMenu` — ordinary
AX actions on an element that belongs to a process running inside a virtual machine.

## Measured against WebDriverAgent, same screen, same minute

Both columns answer "get me this screen's addressable elements". The AX column is a **whole walk**;
the WDA column is a **single `GET /source` round trip** that returns the whole tree. Per
[`desktop.md`](desktop.md)'s warning these are not per-round-trip figures and must not be divided
into one.

**Photos, Library grid, nine photos:**

|           | `apple_desktop_ui_tree` | WDA `/source` |
| --------- | ----------------------- | ------------- |
| nodes     | 12                      | 83            |
| depth     | 1                       | 18            |
| pressable | 9                       | 17            |
| named     | 9 (100%)                | 17 (100%)     |
| payload   | in-process              | 125,451 bytes |
| time      | 0.142 s / 0.137 s       | 0.749 s       |

**Settings, root list:**

|           | `apple_desktop_ui_tree` | WDA `/source` |
| --------- | ----------------------- | ------------- |
| nodes     | 15                      | 168           |
| depth     | 1                       | 20            |
| pressable | 14                      | 49            |
| named     | 14 (100%)               | 28 (**57%**)  |
| payload   | in-process              | 339,656 bytes |
| time      | 0.286 s                 | 0.723 s       |

The shape is the same on both: AX returns a flat, fully-named list of what a person would actually
reach for; WDA returns the view hierarchy, deeper, larger, and on Settings only 57% named across
340 KB. Settings through AX is fourteen rows, every one addressable by name:

```
AXButton "General"                    [16,293 370x52]
AXButton "Accessibility"              [16,345 370x52]
AXButton "Apple Intelligence & Siri"  [16,449 370x52]
AXTextField "Search | Search"         [32,803 336x38]
```

## The finding: AX contradicts WDA's visibility flag

On the Photos grid the nine elements AX returns are a strict subset of WDA's seventeen — but they
are exactly the nine WDA reports as **`isVisible: "0"`**.

`mcp-ios-simulator` 0.2.0 ships a fix for the consequence of that flag: its `ui_tree` filters
invisible elements out by default, so a photo picker answered eleven elements of chrome and nothing
else, and the caller could not tell a filtered screen from a bare one. That release added a
`filtered` tally to say so. **This lane is the independent confirmation the flag is simply wrong**:
the same cells arrive here as first-class named pressables, each advertising `AXPress`. No press on
a cell was staged, so this is the read lane contradicting the flag, not a round trip through it.

So the two lanes are not ranked. They disagree, and on this screen AX is right.

## What it does not reach, and this was tested rather than assumed

AX misses the chrome that WDA sees: `Sort and Filter` and `Select` in the navigation bar, and
`Library`, `Collections` and `Search` in the tab bar. Those are five real buttons, and they are the
ones a caller taps most.

[`ax-lane.md`](ax-lane.md) requires that a negative be proven rather than inferred, so the tab bar
was pushed on:

```
AXGroup "Tab Bar" [0,791 402x83]
  AXChildren                    0
  AXChildrenInNavigationOrder   0
  AXVisibleChildren/AXContents/AXRows/AXTabs/AXSelectedChildren   absent or empty
  actions                       AXScrollToVisible, AXCancel, AXShowMenu   (no AXPress)
  AXCustomRotors/AXCustomActions   absent
  AXChildren after setting AXFocused = true   0
```

And on the screen group itself, `AXChildren` and `AXChildrenInNavigationOrder` both answer 11, so
there is no richer tree behind the ordering attribute. ~~The container is genuinely childless, not
merely unwalked, and `apple_desktop_expand` has nothing to expand.~~ **Wrong, and corrected below
on 2026-09-07: the container is childless by its `AXChildren` link and not by any other measure.
The attribute readings above are all still true; the conclusion drawn from them was not.**

**Two screens is a small sample and the coverage differed between them** — Settings gave essentially
everything useful, Photos gave the content and none of the chrome. What decides which is not
established here. A third screen with a known control set would settle it; this probe did not stage
one.

## The tab bar was there, 2026-09-07

The section above pushed on every children attribute the group offers and found them all empty. It
did not push on the one thing that does not go through the parent: **hit-testing**.
`AXUIElementCopyElementAtPosition` across the tab bar's frame returns four real elements —

```
AXRadioButton  desc=Garden    id=leaf
AXRadioButton  desc=Today     id=checkmark.circle
AXRadioButton  desc=Calendar  id=calendar
AXRadioButton  desc=Rescue    id=cross.case
```

— and each one, asked for `AXParent`, names the tab bar group; the chain continues up to the window
and the application. So the edge is one-way: the children know their parent, and the parent does
not list them. They are not hidden and not absent, they are **orphaned**. And they are drivable:
`AXPress` on one switched the app's tab, confirmed by screenshot.

This is therefore a limitation of the walker, not of the Simulator. `AccessibilityDriver.walk`
descended `kAXChildrenAttribute` and nothing else, so a container with a broken children link was a
dead end that reported nothing — a `maxDepth: 30` walk of this screen visited 36 nodes with no
`stoppedBy`, because it genuinely had nowhere left to go. Verified with a raw AX probe that bypasses
the driver, so this is not the driver misreporting.

**Fixed in the walker.** When a container's children link is empty, its frame is swept with
hit-tests and every distinct hit whose parent chain leads back to the container is walked as one of
its children; the deepest hit is climbed to the element directly under the container so the tree
stays a tree. `expand` on such a handle does the same. The answer carries `recovered` when it
happened. Measured before shipping it everywhere: a hit-test costs 0.3–3 ms (Safari 0.29,
Simulator 3.06), and across Finder, Notes, Maps, Safari, System Settings and Messages a whole tree
holds between zero and five childless containers that pass the gate — so the sweep is on for every
walk, with no switch. Finder's and Safari's whole windows walked with `recovered: 0` and no
measurable change.

On the screen that found it, same device, `apple_simulator_ui_tree { detail: "all" }`:

|             | before | after     |
| ----------- | ------ | --------- |
| elements    | 8      | 17        |
| `recovered` | —      | 9         |
| seconds     | 0.109  | 0.35–0.45 |

The nine are the tab bar's four items and five more from the **navigation bar**, whose group had the
same broken link: a heading, a search field and three toolbar buttons (`action.identify`,
`action.addPlant`, `action.more`). That is the shape of the Photos finding above — `Sort and
Filter` and `Select` in the navigation bar, `Library`, `Collections` and `Search` in the tab bar —
and the reason to expect it now closes too; that re-measurement has not been made.

**The handle this gives is better than WebDriverAgent's.** The recovered tab items carry their SF
Symbol name as `AXIdentifier`, and a symbol name is not localised: `cross.case` is `cross.case` on a
French device whose label reads `Sauvetage`. WDA sees the same tabs and gives them no identifier at
all, only the translated label. So a tab bar is addressable by a stable id through this lane and
not through the runner — which partly inverts the verdict at the top of this file, on this one
point.

What the sweep does not recover: children of a container that is scrolled or covered. A hit-test
sees what is on screen, which is the same limit a finger has, and `recovered` in the answer is how
a caller knows those nodes came that way.

## Why this cannot move into `mcp-ios-simulator`

The obvious product idea — teach the simulator server to drive through AX and drop the WebDriverAgent
dependency — is closed by [`surfaces.json`](../surfaces.json), which already says why `desktop` has a
null `npmName`:

> The grant lands on the RESPONSIBLE GUI ANCESTOR — measured: an unsigned `main.swift` in
> `/var/folders` answered `AXIsProcessTrusted()` true by inheriting the editor that started the
> chain. A published package would ask a person to grant their editor the right to drive every app
> on the Mac.

`@mgcrea/mcp-ios-simulator` is a published npm package started as a child process, so an
Accessibility grant would attribute to whatever launched it. **The probe behind this document is
itself the demonstration**: [`probe-desktop.swift`](../scripts/probe-desktop.swift) run with `swift`
from a terminal answers `AXIsProcessTrusted() == true` having been granted nothing, by inheriting the
terminal's grant — its own header records the same result for an unsigned `main.swift` in
`/var/folders`. That
is the misattribution [`alternatives.md`](alternatives.md) names as the thing no competitor solves,
and shipping it in an npm package would be committing it deliberately.

It would also need a Swift helper inside a server whose whole design is plain Node with no native
CLI beside it.

So the lane belongs here, in a signed bundle that holds its own grant, and nowhere else.

## What this is good for

Not replacing WebDriverAgent. What it adds is a lane with **no process to keep alive** — which is
the failure WDA actually produces in practice, since the runner is an XCTest session that dies with
the terminal that started it, and a dead runner is what `ios_simulator_diagnostics` exists to name.
Against that, this needs a one-time machine-level grant and a scope switch.

Concretely, with **Reach any application** on and no runner running at all:

- read the current screen's named, pressable elements, at a seventh to an eleventh of WDA's node
  count
- press one of them
- do it while `mcp-ios-simulator`'s own `screenshot`, `install`, `launch`, `add_media`,
  `set_environment` and `push` keep working, since none of those needs WDA either

That is enough to drive a simple app end to end, and enough to answer "what is on screen right now"
when the runner is down. (The paragraph above describes the Desktop route; the `simulator` surface
below does the same with the coordinates already converted and no scope switch.)

## Reproducing

Requires Accessibility on the running bundle. **Reach any application** was required when this was
written and is not any more — Simulator.app is brokered since the `simulator` surface — but the
Desktop route still works as recorded:

```
xcrun simctl boot <udid> && open -a Simulator
apple_desktop_list_windows { bundleId: "com.apple.iphonesimulator" }
apple_desktop_ui_tree      { bundleId: "com.apple.iphonesimulator", detail: "all", maxDepth: 20 }
```

Find the `AXGroup` whose width and height equal the device's point size — `ios_simulator_diagnostics`
reports it as `display.pointWidth` / `pointHeight` — and subtract its origin from every frame to get
the iOS point space.

Poll rather than settle, the same trap [`desktop.md`](desktop.md) records: the simulator's window
appears well before the booted device draws anything into it.

## What shipped

**Status: BUILT, 2026-09-07.** `simulator` is in `surfaces.json` and served in-process by
`SimulatorServer.swift`, over the same `AccessibilityDriver` Desktop uses, with the reach pinned to
`com.apple.iphonesimulator` the way `ServerHost` pins a lend. No gate widens it. Everything above
is the measurement that justified it; what follows is what the build measured on top, by
[`scripts/spike-simulator-drive.swift`](../scripts/spike-simulator-drive.swift) (`make simulator-spike`),
same machine, same iPhone 17 Pro on iOS 26.5, Settings on screen.

| Tool                            | Gated         | Answers                                                                 |
| ------------------------------- | ------------- | ----------------------------------------------------------------------- |
| `apple_simulator_list_devices`  | no            | CoreSimulator's devices, and each open window's device screen geometry  |
| `apple_simulator_ui_tree`       | no            | the device screen's elements, in iOS points, bezel and toolbar excluded |
| `apple_simulator_find_elements` | no            | the same, filtered by id, role, name or pressability                    |
| `apple_simulator_diagnostics`   | no            | grant, Simulator running, windows resolved, scale, writes, reach        |
| `apple_simulator_press`         | `allowWrites` | AXPress by handle — no activation needed                                |
| `apple_simulator_tap`           | `allowWrites` | activate, then click at an iOS point                                    |
| `apple_simulator_swipe`         | `allowWrites` | activate, then drag between two iOS points                              |
| `apple_simulator_type`          | `allowWrites` | activate, then one key code per character                               |
| `apple_simulator_key`           | `allowWrites` | one unmodified device key from a short allowlist                        |
| `apple_simulator_press_button`  | `allowWrites` | home, lock, rotate_left, rotate_right — the Simulator's chords, by name |

Deliberately absent: boot, shutdown, erase, install, launch, terminate, open_url, push, add_media,
set_environment, screenshot, wait_for_element. None needs a grant, and
[`@mgcrea/mcp-ios-simulator`](https://github.com/mgcrea/mcp-ios-simulator) does them through
`simctl` and WebDriverAgent. The point of this surface is the one lane that server cannot have.

### The coordinate contract

Every `rect` and `point` is in iOS points with the device screen's top-left as origin — the space
`ios_simulator_tap` and `ios_simulator_screenshot` use. Verified live against WDA on Settings' root
list: `General` at `[16, 293.3, 370, 52]` here, `[16, 293, 370, 53]` there. `screenPoint` carries the
Mac-screen point beside it for anyone driving through Desktop.

**The scale is measured, never assumed.** The device screen is the `AXGroup` child of the window
whose size, divided by the device type's portrait point size in either orientation, gives the same
ratio for width and height within 1%. That ratio is the window scale. The point size comes from
CoreSimulator's own plists — `~/Library/Developer/CoreSimulator/Devices/<udid>/device.plist` names
the device type, `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/<type>.simdevicetype/
Contents/Resources/profile.plist` gives `mainScreenWidth 1206`, `mainScreenHeight 2622`,
`mainScreenScale 3`, so 402x874 — the same files `mcp-ios-simulator` reads. The Simulator's own
`WindowScale` preference is reported by diagnostics as a cross-check and never trusted over the
measured group: it was `1` on the probed device and `0.68` on another that day, so any factor is
possible. Landscape is the same match with width and height swapped; an iPad rotated mid-session is
re-resolved on the next call, because nothing is cached across calls.

The window title names the device — `iPhone 17 Pro – iOS 26.5`, with an en dash — and is matched
against CoreSimulator's booted devices by name and runtime label. A title that matches nothing is
tried against every booted device's profile, and two open windows are reported as ambiguous rather
than guessed between; `device` disambiguates.

### Measured while building it

**A click lands only once the Simulator is frontmost.** The first tap leg posted a `CGEvent` click
at `General`'s centre with VS Code frontmost: nothing happened on the device in four seconds, and
the click went to whatever covered the window. With `activate()` first the same click opened
`General` in 733 ms. So every synthetic verb here activates and WAITS — `activateAndWait` polls the
window server's focused application through Accessibility, because `NSWorkspace.frontmostApplication`
is fed by KVO and answers from before the activation — and refuses to post when the Simulator did not
come to the front. Activation took ~105 ms on every trial, in both `activate()` forms.

**`AXPress` needs no activation.** The same run pressed the back button by handle with the editor
frontmost and Settings returned to its root list. That is why `press` is the verb the guide prefers.

**A drag is a touch pan.** A 400-point drag over 400 ms scrolled `General` off the root list; over
120 ms it did too; dragging back restored it to `y = 293.3`. What this run did NOT establish is where
the scroll/fling boundary lies — both durations moved a full screen — so `durationMs` is honoured
as wall-clock and described as "shorter is more of a fling" without a number.

**The Simulator forwards key codes, not characters.** The driver's `type(text:)` puts a unicode
string on one event with virtual key 0, which every Mac application reads. Settings' search field
received a single **"Q"** — key 0 on the AZERTY layout it was typed from. So `apple_simulator_type`
sends one key code per character, resolved against the Mac's current layout by the same
`UCKeyTranslate` map `apple_desktop_key` uses, with shift for an uppercase letter, and reports back
the characters the layout has no key for. **The per-key path is implemented and not yet measured
end to end**: the run that would have measured it was stopped because the person at the keyboard
was using the Mac, which is exactly the collision the driving notice exists for. `make
simulator-spike SPIKE_ARGS="--type"` is the measurement, and it needs Settings' root list on screen.

**Command-L locks; home does not unlock.** Command-L brought up the lock screen (`Monday,
September 7, 11:00`). Command-shift-H on that screen did not unlock a Face ID device; a swipe up
from `(201, 868)` to `(201, 300)` did, in 62 ms. `press_button`'s description says so, and the guide
sends a caller to `swipe`. The home chord itself — leaving an app for the springboard — is in the
same unmeasured state as typing, for the same reason, and `--home` is the leg that measures it.

**The depth cap truncated siblings.** The first geometry pass listed the window's children with
`maxDepth: 1` and got one child back — `AXButton "Action"` — with `stoppedBy: depth(1)`. The walk
set the same flag for the depth bound as for the node and time bounds, and returns on that flag
before visiting the next node, so the first branch to reach the cap ended the walk for every sibling
after it. The comment beside it said the opposite. Fixed in `AccessibilityDriver.walk`: the cap is
reported and stops nothing. Desktop had shipped with this; a default walk of depth 12 lost every
sibling after the first subtree deep enough to hit it.

**`NSWorkspace.frontmostApplication` does not move in a process with no run loop.** Six activation
trials reported "frontmost after 0.0 ms" because the value was read once at launch and never again.
The measurement, and the server, ask `AXUIElementCreateSystemWide()` for `AXFocusedApplication`
instead — the window server's own answer, and the one that decides where a keystroke lands.

**Swift serialises equal dictionaries in different key orders.** `dispatch-check` compared two
`tools/list` replies as text and they differed at byte 22; this surface, the first with no gate, was
the first to fail the "no gate changes nothing" assertion honestly. The check compares canonical
JSON now, which also makes the "a gate changes something" assertion mean something for the surfaces
that have one.

### What Simulator.app being brokered changes

The manifest entry gives Simulator.app a `bundleId`, and `AccessibilityDriver.brokeredBundleIds`
and `ScreenCapture.targets` both read `Surface.all`. So, by design and pinned in `simulator-check`:
Desktop reaches the Simulator under its default scope, `apple_screen_capture_surface { surface:
"simulator" }` photographs its window (chrome included, at window scale — for the device's screen in
points use `ios_simulator_screenshot`), and every "the N applications Cupertino brokers" string says
nine. The alternative — a `capability` with a literal bundle id in the server — was weighed and
rejected because it would have left the Simulator refused by Desktop for no reason a user could act
on.

### Still open

- The two unmeasured legs above: typing by key code, and the home chord. Both are implemented; both
  need a run with nobody at the keyboard.
- Whether a mouse scroll-wheel event maps to anything inside the Simulator. Not shipped, and not
  needed while a swipe scrolls.
- A device window at a non-integer scale has not been driven, only resolved on numbers. The 1%
  tolerance is a guess that fits 0.68; a Fit Screen window is the next measurement.
