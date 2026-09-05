# Driving apps natively: what an Accessibility surface would cost

Phase-0 probe for the proposed `desktop` surface — a generic UI driver over the Accessibility API,
the macOS analogue of what WebDriverAgent gives `mcp-ios-device`. Measured on **macOS 26.6 (Darwin
25.6.0), Swift 6.3.3, 2026-09-05**, by [`scripts/probe-desktop.swift`](../scripts/probe-desktop.swift).

**Verdict: GO.** 27x cheaper per round trip than the lane this repo rejected, 86% of pressable
elements carry a stable name, and two of the three documents that closed this lane were measuring
something else.

## The finding: every rejection measured the transport, not the API

This repo closed the Accessibility lane three times, on two different grounds:

| Where                         | Claim                                                         |
| ----------------------------- | ------------------------------------------------------------- |
| [`docs/safari.md`](safari.md) | "~206 elements at 33.6 ms a round trip, ~14 s, no bulk fetch" |
| [`docs/maps.md`](maps.md)     | "the Accessibility lane this replaced needed ~14 s"           |
| [`docs/safari.md`](safari.md) | "does not reach the page at all. Not slowly — **at all**"     |

Every one of those numbers came through `osascript` + JXA + System Events.
[`scripts/spike-maps-ax-write.mjs`](../scripts/spike-maps-ax-write.mjs) imports `osascript` from
`probe-kit.mjs` and drives `Application("System Events")`;
[`packages/mail/src/client/jxa/core.ts`](../packages/mail/src/client/jxa/core.ts) walks the composer
with `el.uiElements()` and `kids[i].role()` — one **Apple Event per call**, bounded at depth 6
purely to survive the cost.

So 33.6 ms is the price of an Apple Events IPC round trip, not the price of
`AXUIElementCopyAttributeValue`. "No bulk fetch" is a property of System Events. The lane was never
measured without that layer in the way.

## Measured

Every surface app that was running, one full-depth walk each, six round trips per node (role,
identifier, title, description, actions, children):

| Surface              | Nodes     | Walk        | Round trips | **ms / round trip** | Pressable | Anonymous | A role filter misses |
| -------------------- | --------- | ----------- | ----------- | ------------------- | --------- | --------- | -------------------- |
| safari               | 694       | 0.091 s     | 4164        | **0.022**           | 50        | 3         | 37 of 50             |
| mail                 | 510       | 0.327 s     | 3060        | **0.107**           | 61        | 12        | 14 of 61             |
| calendar             | 222       | 0.224 s     | 1332        | **0.169**           | 65        | 4         | 52 of 65             |
| maps _(card staged)_ | 160       | 0.177 s     | 960         | **0.185**           | 131       | 3         | 113 of 131           |
| reminders            | 203       | 0.673 s     | 1218        | **0.552**           | 53        | 11        | 26 of 53             |
| notes                | 9770      | 37.088 s    | 58620       | **0.633**           | 20        | 8         | 4 of 20              |
| contacts             | 2401      | 65.356 s    | 14406       | **4.537**           | 25        | 15        | 12 of 25             |
| **total**            | **13960** | **103.9 s** | **83760**   | **1.241**           | **405**   | **56**    | —                    |

**27x cheaper per round trip than System Events**, and 86% of pressable elements (349 of 405) carry
an identifier, title or description rather than needing coordinates.

### Cost is counted in round trips, and that is not a pedantic distinction

A per-node figure is not comparable to 33.6 ms and quietly rewards a walker that reads less. This
walker spends six round trips a node; the same walk reported per node reads 7.4 ms and looks like a
failure. Per round trip it is 1.2 ms. **Any future measurement here must state which it is.**

### The Maps card is the like-for-like comparison

`docs/maps.md` priced a place card at **~14 s** through System Events. Staged the same way — the
combined `maps://?q=<name>&ll=<lat>,<lon>` form, because a coordinate positions the map and a _name_
selects a place — the same card walks natively in **0.177 s**, and finds **131 pressable elements of
which 128 are named**.

That is the whole argument for this surface in one row.

### The spread across apps is 206x, and it is the real design constraint

Safari answers at 0.022 ms a round trip; Contacts at 4.537 ms. Same API, same machine, same run.
Electron and WebKit answer from an in-process cache; a native AppKit app with a large list does not.

**So a node cap does not bound the time.** 2401 nodes cost Contacts 65 s while 9770 cost Notes 37 s —
the smaller tree took nearly twice as long. Only a wall-clock budget bounds a walk, and the driver
needs one alongside the depth and node caps.

Where a depth cap would have to sit to keep a default response near 500 nodes:

| notes   | contacts | safari  | mail     | calendar · reminders · maps |
| ------- | -------- | ------- | -------- | --------------------------- |
| depth 3 | depth 4  | depth 9 | depth 10 | whole tree is under 500     |

## What this overturns elsewhere

### `docs/safari.md` — the page IS reachable, and this is the bigger correction

That document's strongest claim is that Safari page content is "an absence rather than a price",
evidenced by a System Events census of **ten elements, max depth 3, `AXWebArea` count 0**.

Measured natively against the same Safari, one window:

```
AXWebArea               1        <- docs/safari.md measured 0
AXLink                  26
AXHeading               17
AXStaticText with text  343 nodes, 10735 chars
total nodes             694
max depth               12
```

The page is there — 69x more elements than System Events exposed, and ten kilobytes of readable
text. `docs/safari.md` was right that the content exists and reasoned to the wrong door:

> "VoiceOver reads web pages, so the content is in the accessibility API — just not through this
> door."

Correct, and the door is `AXUIElement` rather than `AXManualAccessibility`. **This is the same
mistake as the cost figure, in a stronger form**: an absence really cannot be engineered around, so
stating one is a much more expensive thing to get wrong than quoting a slow number. `docs/safari.md`
needs amending, and `packages/safari` may have a read lane it was told it could not have.

### `docs/maps.md` — the role trap is worse than recorded

`docs/maps.md` found that filtering by role saw 15 pressable elements where there were 236. Re-tested
natively across seven apps, that trap is not a Maps quirk — it is the norm:

| Maps    | Calendar | Safari | Reminders | Contacts | Mail | Notes |
| ------- | -------- | ------ | --------- | -------- | ---- | ----- |
| **86%** | 80%      | 74%    | 49%       | 48%      | 23%  | 20%   |

Share of pressable elements a `role == "AXButton"` filter would miss. Maps reports 94 of its 160
nodes as `AXGenericElement`. The rule stands exactly as written: **ask what has `AXPress`, never what
calls itself a button.**

## Traps found

**Counting nodes instead of round trips produced a confident NO-GO.** The first instrumented run
reported 7.3 ms "per element" against System Events' 33.6 ms — a 4x win, marginal enough to argue
about. The walker was spending six round trips a node and the report was dividing by nodes. The real
figure is 27x. Nothing about the measurement changed except what it was divided by.

**The census reported a superset as a subset.** `withIdentifier` counts every node; it was printed
indented under `pressable`, so Notes read "pressable 20 / carrying AXIdentifier 7394". Nonsense on
its face, and it would have been quoted.

**`-25205` and `-25212` are not errors.** A healthy 13,960-node walk produced 19,903
`attributeUnsupported` and 12,893 `noValue` — an element without that attribute, a leaf without
children. They outnumber the nodes. A driver that surfaces them as failures makes every working tree
look broken. Only two codes are worth reporting to a caller:

| Code     | Meaning                        | Treatment                                              |
| -------- | ------------------------------ | ------------------------------------------------------ |
| `-25211` | `kAXErrorAPIDisabled`          | No grant. Real setup message.                          |
| `-25204` | `kAXErrorCannotComplete`       | Busy, hung, or the messaging timeout fired. Retryable. |
| `-25205` | `kAXErrorAttributeUnsupported` | Normal. Silent.                                        |
| `-25212` | `kAXErrorNoValue`              | Normal. Silent.                                        |

`kAXErrorFailure` (`-25200`) also appeared, 30 times in 83,760 round trips. Rare enough to log and
not to model.

**A probe must not provoke the prompt, and must not rearrange the machine either.** Without the grant
this stops rather than calling `AXIsProcessTrustedWithOptions`, for the reason
[`docs/alternatives.md`](alternatives.md) gives — the prompt is attributed to the responsible process,
and granting a terminal the right to drive every app is the misattribution the project exists to
avoid. Staging the Maps card is behind `--stage-maps` for the weaker version of the same rule.

**The grant is on the responsible GUI ancestor, not on anything this repo ships.** An unsigned
`main.swift` in `/var/folders` answered `AXIsProcessTrusted() == true` by inheriting the editor that
started the chain. Homebrew's `node` is ad-hoc signed (`flags=0x2(adhoc)`, no team identifier), so a
grant resting on it dies at the next upgrade. **This is why `desktop` cannot be an npm package**, the
same argument [`docs/screen.md`](screen.md) makes for `screen`, and it is why every number here is
about the identity that ran the probe rather than about `Cupertino.app`.

## The write lane, proven — and four things it falsified

`docs/maps.md:619` left "a write half is now plausible and unbuilt". It is built and it works: a
place was saved and deleted end to end, driven entirely through `AccessibilityDriver`, addressing
controls by identifier and by name. Favourites were 26 before and 26 after, and the store is back to
where it started.

What the run cost the plan is that **almost every assumption `docs/maps.md` recorded about this
control was wrong**, and none of it was visible from a read-only tree dump.

### 1. `FavoriteButton` does not write a favourite

Pressing it opens a **"Name This Location" sheet** — a text field, Cancel and Save. Nothing is
written until Save. Then the place lands as an **unfiled saved place** (`p1:c:` in the maps
surface's refs), and `ZFAVORITEITEM` never changes: `apple_maps_list_favorites` returned 26 before
the press and 26 after.

So the write this repo planned — press `FavoriteButton`, check `ZFAVORITEITEM` gained a row — would
have pressed the right control, produced a real change, and then failed its own verification.

### 2. It is not a toggle, and the second press does not undo the first

|                        |                                                        |
| ---------------------- | ------------------------------------------------------ |
| Press 1, not saved     | naming sheet → Save → row created                      |
| Press 2, already saved | **no sheet**, row's `modified` bumped, row still there |

`docs/maps.md` called the toggle "the assumption the design is built to survive". It does not
survive. The removal path is `MoreButton` → the menu item whose identifier is `delete_from_places`,
which took `AddButton`'s name from "Added" back to "Add" and cleared the row.

### 3. The state bit exists — on the other button

`docs/maps.md:457` is headed "There is no favourite-state bit in the Accessibility tree", on the
strength of `FavoriteButton` reporting identical attributes for saved and unsaved places. That is
true of `FavoriteButton` and false of the card:

    AddButton   name = "Add"      place is not saved
    AddButton   name = "Added"    place is saved

Observed in both directions in one session. The finding was right about the control it examined and
wrong about the tree — which is the same shape of error as measuring AX through System Events, one
level down.

### 4. A modal sheet replaces the window list

While "Name This Location" was up, a full walk of `com.apple.Maps` returned **19 elements** — the
sheet, and nothing else. The place card behind it was not in the tree at all. A driver that had
cached "the window" would have been holding a window the app no longer offered.

And the sheet's `Save` button carries **no `AXIdentifier`** — the anonymous case, 14% of pressable
elements in the census above. Addressing had to fall back to the name. This is the concrete argument
for `find_elements` accepting `name` as well as `id`.

**There are two modal shapes, and they do not behave the same.** The naming sheet replaced the window
list entirely. The delete confirmation is an `AXSheet` _inside_ the window, with `SceneWindow` still
present — a 15-element tree rather than a 19-element one:

    AXSheet  id=_NS:87            name=alert
    AXButton id=action-button--998 name=Cancel
    AXButton id=action-button--999 name=Delete

Those identifiers are generated and positional; `action-button--999` is not something to match on
across releases. Name is the stable handle here, which is the second independent argument for
addressing by name as a first-class path rather than a fallback.

**And `delete_from_places` does not always confirm.** The first deletion took effect immediately; the
second raised the alert above. Same menu item, same place, same session. A driver cannot assume
either, which is the general form of the lesson: after any press, look at what is on screen rather
than at what the last run did.

### The trap that cost the most: the control must be polled for, not waited for

A single read four seconds after opening the URL found `FavoriteButton` on one run and not the next.
Both runs had the card: `PlaceCardViewController`, `CardButtonTypeShare` and `CardButtonTypeClose`
were all in the tree. What was missing was the card's _content_ — a screenshot showed the panel
rendered blank while its chrome already existed.

So the chrome appearing is not the card being ready, and no fixed settle time is correct. Poll for
the control, exactly as `findBodyArea` waits for Mail's composer in
`packages/mail/src/client/jxa/core.ts`. Cheap here: a whole Maps walk is ~0.2 s, and the successful
run waited 0.5 s.

### An aside the maps surface should look at

Maps' own Guides picker lists a **"Favorites" guide with 3 places**.
`apple_maps_list_collections` does not return it. Not this surface's bug, but this surface is how it
was found.

## Still open

- **The hosted case — half answered.** Every number above was taken from a terminal. The surface has
  since been built and handshaken through the bridge from the Debug bundle, which confirmed the part
  that needs no grant: `apple_desktop_list_apps` returned all 23 running applications and
  `apple_desktop_diagnostics` reported `accessibility: not granted` rather than failing blank. That
  is the observe-half claim proven in the hosted case.

  What is still unmeasured is a hosted AX **read**, because `io.mgcrea.cupertino.debug` is a TCC
  identity of its own and nobody has granted it. Granting it is a System Settings toggle, and the
  measurement it unlocks is the walk timings above taken as the app rather than as a terminal.

  That separate identity also produced the first real bug this surface shipped and fixed: the
  diagnostics note hardcoded `io.mgcrea.cupertino`, so a Debug build told you to reset a grant that
  was not the one failing. It reads `Bundle.main.bundleIdentifier` now. Same family of mistake as
  granting again on top, which is what the note exists to prevent.

- **Whether a reported-settable value actually lands.** `AXUIElementIsAttributeSettable(kAXValue)`
  returned `true` on the first text field of all seven apps, which proves the write path is permitted
  and not that any app honours it — `jxa/core.ts:299` documents a value that reports itself settable
  and then does nothing. That needs a controlled write, which is a check and not a probe.
- **Why Contacts costs 4.5 ms a round trip.** 420 of its 2401 nodes are `AXUnknown`. Unexplained.
- **Nothing has been pressed.** The first controlled write should be the Maps `FavoriteButton`, whose
  `AXIdentifier` is unlocalised and whose state must be read from the file lane first — `docs/maps.md`
  found no favourite-state bit anywhere in the tree, so a blind press on an already-saved place would
  silently delete it.
