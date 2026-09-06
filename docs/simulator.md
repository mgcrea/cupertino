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
contradicts WDA on the one thing WDA gets wrong. The simulator is not in the brokered table, so all
of this needs **Reach any application** switched on.

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
there is no richer tree behind the ordering attribute. The container is genuinely childless, not
merely unwalked, and `apple_desktop_expand` has nothing to expand.

**Two screens is a small sample and the coverage differed between them** — Settings gave essentially
everything useful, Photos gave the content and none of the chrome. What decides which is not
established here. A third screen with a known control set would settle it; this probe did not stage
one.

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
when the runner is down.

## Reproducing

Requires Accessibility on the running bundle and **Reach any application**, since
`com.apple.iphonesimulator` is not a brokered surface:

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
