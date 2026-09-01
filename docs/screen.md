# Screen capture: what a `screen` surface would cost

Phase-0 probe for the proposed capture surface. Measured on **macOS 26.6 (Darwin 25.6.0),
2026-09-01**, by [`scripts/probe-screen.swift`](../scripts/probe-screen.swift).

**Status: BUILT.** `screen` is in `surfaces.json` and served by the app. What is below is the
measurement that justified it; [What shipped](#what-shipped) is the result.

**Verdict: GO. One question left, and it shapes copy rather than architecture.**

ScreenCaptureKit does everything the design needs, at ~30 ms a window, and it composites a window
that is 100% covered by another app — so capture is passive observation and never has to raise
anything. The grant behaves exactly as [distribution.md](distribution.md) needs it to: an
`LSUIElement` Developer-ID bundle holds `kTCCServiceScreenCapture`, its grandchildren inherit it,
and it survives both re-signing and the bundle moving.

What is left is whether macOS 26 re-prompts periodically — see [Still open](#still-open). That
changes what the Permissions pane has to say, not whether this can be built.

## The lane

A fifth lane, and it is neither of the two [surfaces.md](surfaces.md) tabulates. Apple Events is
irrelevant, the file lane is irrelevant, and the app has to link a framework for the first time —
which the surfaces table calls the "neither" row and no surface has yet needed.

`ScreenCaptureKit is unreachable from node`, and that is not a preference. `ServerLocator.environment`
hands a server `PATH=/usr/bin:/bin` and `HOME` and nothing else, so `/usr/sbin/screencapture` is not
even callable. Capture has to run in the Swift host, which is what makes this the first surface with
no npm package.

## Measured

| Question                                         | Answer                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **Occlusion** — does a covered window composite? | **Yes.** 7 of 7 targets were **100% covered** and every one returned its own content |
| **Cost**                                         | **29–94 ms** per window                                                              |
| **PNG size**                                     | 446 KB – **18.6 MB** (Maps, satellite imagery)                                       |
| **Enumeration leak**                             | 504 windows, **169 carrying titles**, longest 84 chars                               |
| Displays / apps visible                          | 2 / 68                                                                               |

### Occlusion is the finding, and it was confirmed twice

The plan's blocking question was whether capture is passive observation or something that has to
raise windows. It is passive.

`SCContentFilter(desktopIndependentWindow:)` composites the window itself. Both displays were
covered by editor windows at capture time — one 3008x1662 at (0,30), a second 1728x1084 at
(-1728,265) — putting every surface window fully behind them in z-order. All seven still captured
their own content.

Two independent confirmations, because one was not enough:

- **Geometry.** `CGWindowListCopyWindowInfo` returns on-screen windows front-to-back; sampling a
  64x64 grid over each target's frame against everything listed ahead of it gives 100% covered.
- **Pixels.** The Maps capture was opened and shows the Maps window with a place card, not the
  editor that was on top of it.

### Cost is not the constraint; size might be

30 ms is nothing next to the ~14 s that disqualified the Accessibility lane for Maps
([maps.md](maps.md)). But **one Maps window is an 18.6 MB PNG** — 40x the Notes window — because
satellite imagery does not compress. A capture tool that returns a path is unaffected in context
terms and still writes 18 MB to `~/Downloads` per call. Downscaling, or JPEG for photographic
content, is a real decision rather than a refinement.

## Traps found

Each of these was got wrong first, in the repo's tradition of writing down which.

**Off-screen is not occluded, and conflating them produced a confident NO-GO.** The first run of
this probe reported that capture "cannot see an unraised window" and set a blocker. It had captured
three windows that came back byte-identical at 20,355 bytes and one flat colour — from three
different applications, which is impossible for real windows. `SCWindow.isOnScreen` is false for a
**minimised or never-drawn** window; a window buried behind another app is still `isOnScreen == true`.
The probe was measuring never-drawn helper windows and answering a question nobody asked. The real
occlusion test needs z-order, not `isOnScreen`, and the probe now computes it.

**A raw enumeration is not a target list.** Mail reports **16 windows** and has one. The rest are
shadows, toolbars and helper layers. Filtering to `windowLayer == 0`, at least 100x100, and
`isOnScreen || title != nil` takes the table to one real window per app. `list_targets` has to make
the same distinction or its counts are nonsense to a model.

| surface  | raw | real |
| -------- | --- | ---- |
| mail     | 16  | 3    |
| notes    | 12  | 1    |
| safari   | 15  | 2    |
| maps     | 10  | 1    |
| messages | 11  | 1    |

**Enumerable is not capturable.** A titled, off-screen Mail window enumerates fine and then fails
`SCScreenshotManager` with `SCStreamErrorDomain -3811`. So `list_targets` must not promise a window
that `capture_surface` cannot grab, and the capture path needs a real error rather than an empty PNG.

**A blank capture does not throw.** A never-drawn window returns pixels — one flat colour, 20 KB.
Counting distinct colours in a 32x32 downsample separates "captured something" from "captured
nothing". Without it, capture silently succeeds and hands back an empty image.

**But `isOnScreen == false` does NOT mean blank, and a later run falsified the claim that it did.**
An earlier note here said a minimised or never-drawn window "does not composite". A Mail window that
was off-screen for its whole run captured at full size with 290 colours. The blanks were never-drawn
1000x1000 helper windows specifically — and the title-or-on-screen filter above already excludes
those. So the blank check stays as a guard on the RESULT, and nothing should be predicted from
`isOnScreen`: a window the app has actually drawn composites whether it is on screen or not. Being
wrong in this direction is cheap; the earlier wording would have had `capture_surface` refuse a
window it could have grabbed.

**Window titles are the data.** 169 of 504 titles were readable — a mail subject, a chat
participant, a document name. Same rule `~/Library/HomeKit` taught in [surfaces.md](surfaces.md):
a name can be the payload. The probe withholds titles unless `--unsafe-titles` is passed, and
`list_targets` should default the same way.

**A probe must not provoke the prompt.** Reaching `SCShareableContent` without a grant makes macOS
offer one — to the **responsible process**, which from a terminal is the editor. Granting Screen
Recording to VS Code is precisely the misattribution [alternatives.md](alternatives.md) names as the
one thing no competitor solves. The probe stops at `CGPreflightScreenCaptureAccess` unless `--force`.

On the machine this was measured on, **the editor already holds the grant** — which is how this run
got its numbers, and is itself the problem stated as a fact.

## What the allowlist is doing

Also running at capture time, with windows open: **Passwords.app** and **Keychain Access**. Neither
is in the closed table, so neither is reachable — not by policy, by construction.

That is the argument for scoping stated concretely, and it is worth being exact about what it buys.
`kTCCServiceScreenCapture` is per-process and all-or-nothing: macOS has no per-target scoping, and
capturing Mail needs the identical grant as capturing the display Passwords is sitting on. Scoping
buys **auditability, not a smaller grant** — the same trade the closed table already makes for Full
Disk Access.

The honest limit in the other direction: **Safari is in the table**, and a Safari window renders
one-time codes, web vaults and banking. Capture supersedes `APPLE_SAFARI_ALLOW_CODES` whatever that
flag says. See [passwords.md](passwords.md).

## What shipped

One surface, `screen`, served **in-process by the app** — the first with `runtime: "swift"` and no
npm package. `ServerHost` answers JSON-RPC for it directly instead of spawning node. The bridge
cannot tell: it never parses JSON-RPC, so `--server=screen` arrives by exactly the path
`--server=mail` does, and `make smoke` handshakes all nine surfaces identically.

An npm package is not merely absent but impossible. The Screen Recording grant lives in the app, so
a published `@mgcrea/mcp-apple-screen` could do nothing — publishing one would be an empty-handed
claim.

| Tool                           | Gated                              | Notes                                                     |
| ------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `apple_screen_list_targets`    | no                                 | Capturable surfaces and window counts. Never titles.      |
| `apple_screen_diagnostics`     | no                                 | Answers with no grant at all, like every other surface's. |
| `apple_screen_capture_surface` | **`allowCapture`, off by default** | Writes a PNG, returns a path.                             |

**The tool list is a pure function of the gate.** With `allowCapture` off,
`apple_screen_capture_surface` is not registered — invisible to the model rather than refused when
called, which is the property [alternatives.md](alternatives.md) claims as a differentiator.
Verified: `tools/list` returns two tools with the gate off and three with it on.

**A caller names a surface, never a window.** `Surface.named` resolves the argument against the
closed table before anything reaches `SCContentFilter`, and the tool's own schema enumerates the
allowed ids. Measured against a machine with Passwords.app open:

```
surface: "passwords" → No surface named 'passwords'. Capture is limited to the surfaces Cupertino brokers.
surface: "screen"    → The 'screen' surface cannot be captured — it has no app behind it.
surface: "mail"      → Screen Recording is not granted to Cupertino. …
```

No display capture and no region capture. Those are the general-vision feature, and shipping them
means the allowlist never existed; widening later is deleting a check.

### Two things the implementation had to get right

**`targets: null`, never `[]`, when the window list cannot be read.** An empty array reads as "no
surface is capturable" when the truth is "we could not look" — the absent-versus-EPERM conflation
this repo has recorded getting wrong three times about the Maps store. Diagnostics distinguishes
them.

**The website guard had to learn about a Swift server.**
`scripts/lib/website-tools.test.mjs` scans `packages/*/src/tools/` for `registerTool`. A surface
with no package is invisible to it, so the suite would have PASSED while covering nothing — the site
lists no tools, the scan finds no tools, and the two agree by both being empty. That is worse than a
failure. It now scans `ScreenServer.swift` too, and the coverage was checked by deleting a tool name
from the site and confirming a red suite.

## Still open

The three identity questions, none of them answered by the run above, because it ran as a child of
the editor rather than of the app:

1. ~~**Does an `LSUIElement` Developer-ID app get and keep the grant?**~~ **Answered — yes**, see below.
2. ~~**Does the grant survive `make install` moving the bundle?**~~ **Answered — yes**, see below.
3. **Is there periodic re-consent on macOS 26?** Needs elapsed time, not another run. This is the
   only one left, and it shapes copy rather than architecture.

### Measured under the app's own identity, 2026-09-01

The spike bundle was built, granted nothing, and run. Both signals agreed:

```
CGPreflightScreenCaptureAccess   denied
SCShareableContent               DENIED — SCStreamErrorDomain -3801 (userDeclined)
```

That measured nothing about ScreenCaptureKit, which is what the probe says. It did measure one
thing worth keeping: **the editor on this machine holds Screen Recording and the app did not
inherit it.** Full Disk Access, Apple Events and Accessibility all came back granted in the same
run, through the same bundle, because they had been granted to it. Screen capture is keyed to the
identity like the rest, and a grant held by whatever launched the app does not reach the app.

`-3801` returns immediately whether a prompt is waiting or a denial is recorded, so that run did not
establish whether an `LSUIElement` bundle gets an actionable prompt. It was granted by hand instead —
which is the normal way Screen Recording is granted, and it takes effect on **relaunch**.

**Granted, and then everything works.** Same bundle, same lane, after adding "Cupertino Spike.app"
to the Screen Recording list:

```
CGPreflightScreenCaptureAccess   granted
SCShareableContent               ok
```

That answers the question the design rests on. `probe-screen` is a **grandchild** of the app
(app → `spike.sh` → `probe-screen`), so **Screen Recording is inherited by spawned processes exactly
as Full Disk Access, Apple Events and Accessibility are** — and it is held by an `LSUIElement`
Developer-ID bundle with no dock icon. Occlusion re-confirmed under this identity: 6 windows 100%
covered, all returning their own content, at 23–35 ms.

Recorded as a MEASUREMENT of one service, not as a generalisation. That is the mistake this
document keeps pointing at, and the `-3801` run above is why: the same bundle held three other
grants and did not hold this one.

**It survives re-signing, and it survives the bundle moving.** Both measured after the grant landed:

| Change                                              | Grant survives? |
| --------------------------------------------------- | --------------- |
| Same path, rebuilt and re-signed (new content hash) | **yes**         |
| New path, same identifier and certificate           | **yes**         |

The move was done as a `mv`, not a `cp`. That distinction is the whole reason this result can be
stated: [`scripts/spike-app-tcc`](../scripts/spike-app-tcc/README.md) records an earlier claim that
Full Disk Access does NOT survive a move, retracted because it tested a COPY while the original had
silently lost its grant — so the copy was denied for having no grant at all, not for having moved.
With the original gone there is no second identity to confuse it with. The bundle ran from
`~/Library/Caches/` and reported `granted` / `ok`.

So `kTCCServiceScreenCapture` keys on identifier + certificate exactly as Full Disk Access does, and
moving Cupertino to /Applications after granting is safe.

**Do not answer these by generalising from that spike.** It measured FDA and Apple Events, the
codebase generalised the verdict to every TCC service, and it was wrong for Accessibility — a day
went to a machine holding four Accessibility rows for one identifier. A screen-recording lane is
wired into `spike.sh.in` for exactly that reason:

```sh
scripts/spike-app-tcc/build.sh          # compiles probe-screen into the bundle
# grant Screen Recording to "Cupertino Spike.app", then:
scripts/spike-app-tcc/build.sh run
```

Read it as two columns that are allowed to disagree, the same way the accessibility lane is read:

| `CGPreflight…` | `SCShareableContent` | means                                                                 |
| -------------- | -------------------- | --------------------------------------------------------------------- |
| granted        | ok                   | the grant reaches a child of the app                                  |
| granted        | DENIED               | the four-grants state — `tccutil reset ScreenCapture`, never re-grant |
| denied         | —                    | this identity has no grant; the run measured nothing                  |
