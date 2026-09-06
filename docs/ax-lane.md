# The apps with no other lane: what Accessibility reaches

[`docs/surfaces.md`](surfaces.md) files Freeform, Journal, Books, Podcasts, Weather and News under
"the grant is the _only_ way in — the most differentiated value and the highest maintenance risk,
since **there is no fallback lane**." That sentence was true when it was written and is not any
more: [`desktop.md`](desktop.md) built the lane. This is what it finds on the six.

Measured **2026-09-06, macOS 26.6**, through `apple_desktop_ui_tree` against the shipped
`AccessibilityDriver`, hosted by the Debug bundle with Accessibility granted and
**Reach any application** switched on — none of these apps is a surface, so none is in
`brokeredBundleIds`, and the scope gate is what keeps them out of reach by default.

**Verdict: two clear GOs, one partial, three not measurable on this Mac.** The most valuable result
is Home, because it answers something the file lane structurally cannot.

## Measured

| App          | nodes | seconds | pressable | named | named % | text nodes | chars | depth |
| ------------ | ----- | ------- | --------- | ----- | ------- | ---------- | ----- | ----- |
| **Freeform** | 203   | 0.165   | 42        | 35    | 83%     | 40         | 458   | 6     |
| **Journal**  | 31    | 0.042   | 13        | 10    | 77%     | 1          | 7     | 5     |
| **Books**    | 27    | 0.045   | 9         | 6     | 67%     | 0          | 0     | 8     |
| **Podcasts** | 52    | 0.076   | 34        | 31    | 91%     | 1          | 2     | 8     |
| **Weather**  | 94    | 0.121   | 66        | 62    | 94%     | 11         | 565   | 11    |
| **Home**     | 85    | 0.120   | 71        | 67    | 94%     | 8          | 24    | 8     |

Two runs each, stable between them. Every walk completed: no `stoppedBy`, nothing truncated, so
these are whole trees rather than bounded ones.

**These are seconds per WALK, not milliseconds per round trip**, and the two must not be confused —
[`desktop.md`](desktop.md) records a confident wrong NO-GO produced by dividing by the wrong thing.
A per-round-trip figure cannot be derived from outside the driver, because the tool does not report
how many attribute reads it made. What the column does support is the only claim needed here: none
of these trees is expensive.

**News is not installed on the probed machine** and was not measured. `open -b com.apple.news`
returns not-found.

## Home is the result worth having

[`home.md`](home.md) probed the file lane and found a real limit that shapes the product:

> `ZMKFCHARACTERISTIC` carries a value RANGE rather than a current value, so this is
> **configuration only** — a static inventory that cannot say whether a light is on. Live values
> arrive over HAP and stay in `homed`'s memory.

**The Accessibility tree carries them.** Observed live, with names redacted:

```
AXButton  name="Show Climate, 19,0–25,0°"        <- live range, formatted
AXButton  name="Show Lights, All Off"            <- live aggregate
AXButton  name="Show Security, 3 Open"           <- live count
AXButton  name="<accessory>"  value="On"         <- live per-accessory state
```

Seven accessories carried an `On`/`Off` value, five category status buttons carried a formatted
summary, and thirteen rooms were named. So the two lanes are complementary rather than redundant in
exactly the way `home.md` framed as impossible: **the store answers what exists, and this answers
what it is doing.** That is a stronger case than any of the other five, because it is the only one
where the AX lane is not a substitute for a missing lane but the answer to a question no other lane
can reach.

The values are rendered for a person, not for a caller — `"19,0–25,0°"` is localised, comma-decimal
and unit-suffixed — so anything built on this parses display strings. That is a real cost and it is
the reason this is a finding rather than a surface.

## Weather is a GO, and it needs no store at all

94 nodes, 0.121 s, and the forecast is simply there:

```
AXHeading  name="MY LOCATION, <place>, 18 degrees Celsius, Partly Cloudy, High: 26…, Low: 12…"
AXStaticText  name="Cloudy conditions expected around 12:00. Wind gusts are up to 25 km/h."
AXButton  name="Now, Partly Cloudy, 18°"
AXButton  name="13, Mostly Cloudy, 23°"
```

Current conditions, the narrative summary and the hourly series, all named. Weather has no scripting
dictionary and no useful store, so this is the whole lane rather than a supplement to one. Same
caveat as Home: these are display strings in the user's locale.

## Freeform is partial, and the reason is worth stating

203 nodes and 458 characters — the chrome, the toolbar and the board list, addressable and named at
83%. What is **not** in it is the content of a board: shapes, notes and drawings on the canvas. That
is consistent with a canvas app rather than surprising, and it means Freeform is reachable as
something to _drive_ and not as something to _read_. Judging the read half needs a board open with
known content on it, which this probe did not stage.

## Journal, Books and Podcasts: NOT MEASURED, which is not the same as thin

Their trees came back small — 31, 27 and 52 nodes, with almost no text. It would be easy to write
that down as "the API exposes little", and it would be exactly the mistake
[`surfaces.md`](surfaces.md) has already made three times in this repo:

> "'Absent' and 'EPERM' are different findings."

The same shape applies here. **A library with no books in it produces an empty tree whatever the API
does**, and nothing in these numbers separates an app that exposes nothing from an app that has
nothing to expose on this particular Mac. Books returned zero text nodes, which is far likelier to
mean an empty library than an inaccessible one.

Deciding these three needs a machine with known content in each, and the probe must assert that
content is present before reporting a negative — the procedural rule
`scripts/spike-maps-store.mjs` already applies to gated stores, which "refuses to report a negative
unless it can open them".

## What this does and does not license

It does **not** make any of these a surface. `docs/distribution.md`'s cost for one is ~2k LOC, and
nothing here has been probed for write safety, for a stable addressing scheme across releases, or
for behaviour under localisation — the last of which these six will feel more than any shipped
surface does, because every value above is a display string.

What it settles is narrower and was the point: the sentence "there is no fallback lane" is retired.
Home and Weather are reachable today through a surface that already ships, behind two switches that
ship off, and Home reaches a class of answer the file lane was measured to be incapable of.

## Reproducing

Requires Accessibility on the running bundle and **Reach any application** on for Desktop, since
none of these is brokered:

```
open -b com.apple.freeform -g   # and com.apple.journal, com.apple.iBooksX,
                                # com.apple.podcasts, com.apple.weather, com.apple.Home
apple_desktop_ui_tree { bundleId, detail: "all", maxDepth: 20, maxNodes: 4000 }
```

Poll rather than settle: the first run of this probe read Books and Podcasts before their content
had loaded and got different text counts, which is [`desktop.md`](desktop.md)'s trap — the chrome
appearing is not the content being ready.
