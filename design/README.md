# Cupertino icon

Direction `1f` — the place the app is named for: two hills, one low sun.

One source, four renderings, one command:

```bash
make icon
```

| File                                     | Role                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `cupertino-mark.svg`                     | **the source.** Sun and hills on a transparent sky, 1024×1024. Edit this. |
| `colors.json`                            | palette and gradients                                                     |
| `cupertino-icon.svg`                     | _generated_ — plated vector for the web/README/docs                       |
| `cupertino-lockup.svg`                   | _generated_ — the icon and the word, banner for the README                |
| `../apps/apple/Cupertino/Cupertino.icon` | _generated_ — the Icon Composer bundle Xcode compiles                     |
| `cupertino-menubar.svg`                  | **a second source.** The menu bar glyph, authored not composed.           |
| `cupertino-menubar-active.svg`           | **a second source.** The same glyph plus a halo, for the connected state. |
| `…/MenuBarIcon{,Active}.imageset/*.svg`  | _generated_ — copies of the two above, which Xcode needs in place         |

`make icon` writes every generated file and audits the bundle. Never hand-edit them: the mark is
the only geometry, which is the whole point of generating the rest from it.

The menu bar glyph is the one exception — it is drawn, not derived. At 18pt the mark's own geometry
has nothing left to reduce, so those two files are sources you edit and `make icon` only copies them
into the imagesets that need them alongside.

## Why the sky is a flag and not artwork

The mark carries no background. `make icon` passes the sky as `--plate-gradient
'#FFD08A,#F2895C' --plate-angle 90`, so appshot writes the `.icon` as **two layers** — `mark.png`
over an opaque `plate.png`. macOS 26 lights and parallaxes them independently; a single flattened
bitmap gets one specular sweep across the whole icon and reads flat.

`icon.json`'s `layers` array runs **front to back**, so the plate is the _last_ entry. Backwards is
silent: the bundle still compiles and installs, and renders as a bare plate with no mark.

## Why the hills bleed off the edges

They are landscape, not a centred glyph — `M-40 744 … T1120 744` deliberately overruns the canvas
on three sides, so the mark goes in at `--mark-fraction 1.0` and maps 1:1. The usual 70–80%
glyph-to-plate band does not apply to a scene icon; measured against Notes and Podcasts, all three
sit at the same plate size and the same clamped 80% glyph figure.

The overrun is why `make icon` clips the generated SVG afterwards. macOS masks the `.icon` to its
own squircle for free, but nothing masks an SVG on a web page — without the clip the hills square
off the plate's bottom two corners.

## Small sizes

The `.icon` format carries one artwork for every size. At 32px both hills still separate; at 16px
they merge into a single silhouette, which degrades to roughly the one-hill reading the old
`cupertino-icon-small.svg` drew by hand. That is the intended failure, so there is no second
geometry to keep in step.

## Palette

| Token      | Hex       | Role                               |
| ---------- | --------- | ---------------------------------- |
| sky top    | `#FFD08A` | icon background, top               |
| sky bottom | `#F2895C` | icon background, bottom            |
| sun        | `#FFF8EC` | sun, light text on warm fills      |
| hill mid   | `#B0532F` | back hill (at 90% over the sky)    |
| hill fore  | `#7A2F1C` | front hill, headings on warm fills |
| ink        | `#1B1C1F` | wordmark, body text                |

The gradient is always vertical, top light → bottom warm. Don't rotate it, don't add a third stop.

## Deriving other assets

`appshot icon build --out <path>` picks its format from the extension. For an `apple-touch-icon`,
pass `--corner-radius 0` — iOS applies its own mask, and a rounded source gets double-rounded.

## The menu bar glyph

`cupertino-menubar.svg` is the mark reduced to two shapes — a filled disc setting behind a horizon.
It is a **template image**: pure black plus alpha, no colour, so AppKit tints it for light menu
bars, dark menu bars and the highlighted state instead of us shipping three renderings.
`cupertino-menubar-active.svg` is the same glyph plus a halo, shown while a client is connected.

It is variant **F3** ("setting sun") from the menu bar canvas, kept at that canvas's own 36-unit
grid drawn at 18pt — so 2 units = 1pt. Keeping the grid is what makes a change in the canvas
transcribable rather than re-derived, and it is the same grid Bastion's glyph uses, so the two are
comparable without conversion.

The coordinates are **no longer F3's own**. Three numbers were resized against Bastion's glyph — see
"The family" — and everything else in this section is unchanged.

Two shapes, two weights: the disc is solid, the horizon is a 1.8-unit stroke. The disc is what you
see first and the horizon is what tells you it is a horizon — matched weights read as tramlines
rather than as a scene, which is what the earlier ridge pairs did.

### The cut is a clip, not a mask

The canvas draws the disc's cut as a `<mask>`: a 6-wide black stroke run along the horizon. **Do not
transcribe that literally.** Rendered through `NSImage`'s SVG rep — the same path the menu bar
takes — the mask's soft edge leaves roughly 25% residual alpha the whole length of the cut, and that
residue bridges the disc to the horizon. The glyph comes out as one connected shape instead of two.

The file uses a `<clipPath>` instead, which cuts hard.

### The clip is a true normal offset

It used to be the horizon shifted **straight up** by 3 units, which is only correct while the curve
is shallow. Once the hill became the icon's wave (below) it stopped being shallow: the wave puts a
`0.43` slope directly under the sun, where a vertical shift measures only **2.75** units of sky
perpendicular instead of 3.00. At the icon's own 2.6 amplitude it would be 2.45 — a quarter of the
sky gone, in the one place that cannot afford it.

So the clip is the horizon pushed 3 units along its **own perpendicular**, fitted as two cubics.
Three things were checked rather than assumed:

- **Max deviation from the exact offset is 0.025 units = 0.013pt** — tighter than the 0.03pt the old
  vertical shortcut carried even on the shallow dome.
- **It cannot cusp.** A normal offset self-intersects if it exceeds the curve's radius of curvature;
  the minimum here is 15.55 units against a 3-unit offset.
- **The sky is now exactly `3 − 0.9 = 2.10` units = 1.05pt at every point**, at any amplitude,
  rather than only where the curve happens to be flat. Resize the hill or the sun freely; leave the
  3 and the 1.8 alone.

The clip is still **extended flat past the horizon's ends**, because the horizon does not span the
canvas but the cut has to be continuous everywhere the disc and its halo reach.

### The hill is the icon's

It was a symmetric dome, which the icon's ridge never was. `cupertino-mark.svg` draws an S-wave —
`M-40 744 Q256 536 552 744 T1120 744` — crest left, trough right, and the glyph now carries that
curve at the same proportions:

|          | across the span | at           |
| -------- | --------------- | ------------ |
| crest    | 25.5%           | 10.90, 27.01 |
| crossing | 51.0%           | 18.30, 28.61 |
| trough   | 76%             | 25.55, 30.21 |

Only the **amplitude** is dialled down: 1.6 units against the 2.6 a proportional transcription would
give. 2.6 holds together and was rendered — but its trough reaches y32.0, and at 18pt the sun starts
reading as sliding off to the right rather than setting behind a ridge. Keep the proportions and
move the amplitude alone.

One consequence worth knowing: an asymmetric hill puts the ink **mass** about 0.44 units right of
centre, where the old dome was centred. The ink _bounding box_ is still symmetric (x2.5–33.5), which
is what AppKit centres the status item on, so nothing shifts in the bar. The icon's own ridge is
asymmetric in exactly the same direction.

### Measurements

Geometric on the 36-unit grid, against `tray.full` — the SF Symbol the menu bar icon replaced.
`ink %` is the rendered alpha as a fraction of the whole 18×18
tile — the number that actually says which of two glyphs looks heavier in a bar:

|                    | ink             | ink % | ink mass cy | strokes |
| ------------------ | --------------- | ----- | ----------- | ------- |
| `tray.full` @ 18pt | 21.00 × 16.00pt | —     | —           | —       |
| this glyph         | 15.50 × 9.90pt  | 22.5  | 21.10       | 0.90pt  |
| connected state    | 15.50 × 11.90pt | 28.6  | 19.74       | 0.90pt  |
| Bastion, idle      | 11.50 × 9.10pt  | 22.4  | 21.09       | —       |
| Bastion, active    | 15.75 × 12.40pt | 29.7  | 19.77       | 0.80pt  |

Wide and short is still the shape of a horizon and still deliberate — but it is no longer _only_
that. The ink sits within about a point of Bastion's in both states, which is the whole intent. The
ink box is dead centred horizontally: the horizon's round caps reach 2.6 and 33.4, midpoint exactly 18. Vertically the disc crowns at 11.66 and the trough's cap bottoms out at 31.11.

Three numbers are worth keeping in view:

- **1.05pt of sky** between the disc's cut and the top of the horizon's stroke, at every point along
  the curve. That gap is the glyph. Lose it and the sun welds to the horizon and the mark is a blob.
  It is **structural, not tuned** — see "The clip is a true normal offset" above.
- **1.30pt of gutter** at left and right, up from 0.55pt. The horizon used to run the full live area
  with its caps spilling to 1.1 and 34.9 and no room left; it now has room on both sides.
- **11.7 units of headroom** above the disc, which is what lets the halo be generous.

### The family

These are two apps by one author and their glyphs sit in the same menu bar, so they are measured
against each other rather than admired separately. Against Bastion's fort this glyph used to be a
third lighter and much wider — 34.0 × 16.8 units at 16.8% ink, against 23.0 × 18.2 at 22.4% —
because its width was all horizon: a thin rule running nearly edge to edge past a small sun. Side by
side they did not read as one family; they read as a block and a line.

What changed, and nothing else did:

|         | before                                       | after                                                  |
| ------- | -------------------------------------------- | ------------------------------------------------------ |
| horizon | x2..x34 (32 units), symmetric dome, rise 1.6 | **x3.5..x32.5 (29), the icon's S-wave, amplitude 1.6** |
| sun     | r8.2                                         | **r10.2**                                              |
| halo    | r11.4                                        | **r13.4**                                              |
| clip    | horizon offset vertically                    | **true normal offset**                                 |

The halo moved only to hold its 2.4-unit gap against the bigger sun; see below. The clip had to
change because the hill did. Both stroke weights are untouched, and so is every invariant above.

### The connected state

The halo is `r13.4`, stroke 1.6, inside the same clip as the disc — so the ring sets behind the same
horizon and both terminate on one line.

Its 2.4-unit gap was swept, not chosen. Counting connected components at 18pt/2x: at a 2.0-unit gap
the disc's antialiased edge still meets the ring's diagonally and the two fuse; at 2.2 they
separate. 2.4 sits one step clear of that boundary rather than balanced on it.

`r13.4` is derived, not chosen: `10.2 + 2.4 + 0.8`. The sun has grown twice while this glyph was
matched to Bastion's mass, and both times the ring followed it out. Re-derive it that way if the sun
changes again rather than nudging it — the gap and the stroke are the numbers being kept.

The sun's **sink is proportional to its radius** — it sits `0.378r` above the cut — so growing it
cannot quietly turn a setting sun into a rising one. Keep that ratio on any resize.

That the ring can be this generous is the point of moving to F3. E2c put its sun at `cy9.5` with 3.7
units of headroom, which forced a 1.1-unit stroke across a 1.65-unit gap — and measured, **that ring
never actually separated from its sun at 2x**, whatever its file claimed. F3 leaves 11.7 units above
the disc.

The ring is also what makes this state ride higher than the idle one: it adds 4.0 units above the
disc and nothing below, because its lower half is clipped away by the horizon. There is no symmetric
halo to be had for a sun that sets behind something, which is what the next section is about.

### Sitting it down

Both files seat the glyph so its **ink mass** — not its bounding box — lands where Bastion's does.
Change it in both or not at all.

|                        | this glyph | Bastion |
| ---------------------- | ---------- | ------- |
| idle, ink mass cy      | 21.10      | 21.09   |
| connected, ink mass cy | 19.74      | 19.77   |

Mass rather than box, for the reason it was always mass here: the disc is a solid shape in the upper
half against a 0.9pt line below it, so the eye follows the disc and a box-centred glyph reads high.
The old file made that judgement by eye and expressed it as "1 unit below F3's coordinates"; this
one makes the same judgement against a measured target, and replaces it.

One seat has to serve both states, because the disc and the horizon are identical in the two files
by design — drift there reads as the mark twitching when a client connects rather than as a state
changing. The halo's 4.0 units are one-sided, so the two states cannot both be centred; matching
Bastion state-for-state is what resolves that, since Bastion's wall is one-sided in the same
direction and by nearly the same amount.

**A caveat worth reading before anybody moves this again.** Measured off a real menu bar screenshot
— thresholding the rendered pixels and taking each status item's ink mass — macOS's own glyphs sit
on a line this one used to be almost exactly on, and Bastion sits about 0.8pt below it:

|                                | ink mass, px from the top of the bar |
| ------------------------------ | ------------------------------------ |
| macOS status items (28 glyphs) | 32.4 mean, 29.5–35.3 spread          |
| this glyph, before any of this | 33.3                                 |
| this glyph, now                | 35.1                                 |
| Bastion                        | 34.6 connected / 35.7 idle           |

So matching Bastion moved this glyph _off_ the platform's line rather than onto it. That was a
deliberate call — two marks by one author aligning with each other reads better than either aligning
with the wifi glyph — but it is the wrong half of the pair to have moved on the platform's terms. If
it is ever revisited, the cheaper fix is to raise **Bastion** 1.5 units and bring this one back up
by the same amount; the geometry above does not change either way.

### Component counts

The check, at 18pt, counting 8-connected components of the rendered alpha at a threshold of 32:

| state     | 2x                      | 1x             |
| --------- | ----------------------- | -------------- |
| idle      | 2 — disc, horizon       | 1 — all merged |
| connected | 3 — halo, disc, horizon | 1 — all merged |

Measured across sizes, for the connected state, which is the demanding one:

| size | components | note                                              |
| ---- | ---------- | ------------------------------------------------- |
| 20pt | 3          |                                                   |
| 18pt | 3          | **the size the menu bar draws**                   |
| 16pt | 2          | halo and hill merge — see below                   |
| 14pt | 1          | the size the website draws; the dome did this too |

**Do not tune against 16pt.** The result there is not monotonic in amplitude — sweeping it, 0.9 and
1.1 separate while 0.6, 1.3 and 1.6 do not — which means it is pixel-phase luck at a 32×32 raster
rather than a real margin. 18pt is the size that ships and it holds at every amplitude tried. 14pt
merges for the dome as well, so the website's small rendering is unchanged by any of this.

At 1x everything merges into one silhouette and the connected state reads as ringed-and-fatter
rather than as separate shapes. That is the intended degradation, not a bug to chase: retina is the
design target, and 1x still changes visibly, which is what the state needs to do.

Re-run the count on a real render after any edit rather than trusting the 2x picture — at 1x the
failure mode is the disc touching the horizon, and it is invisible at the size you will be looking
at it.

`actool` reads the SVG directly and preserves the vector representation, so there are no PNG slots
to keep in step. `make icon` copies both files into their imagesets, which is why those copies are
listed as generated above.

## The horizontal lockup

`cupertino-lockup.svg` sets the plated icon beside the word on the `wash` gradient from
`colors.json`, and it is **composed from `cupertino-icon.svg`, not drawn beside it** — the generator
embeds that file whole and scales it, so the sky, the squircle and the bleed clip are inherited
rather than repeated.

That is not fussiness. The lockup that lived in the design canvas was hand-drawn alongside the mark,
and its hills had been a single simplified path for two revisions before anyone noticed. A lockup
nothing generates is a lockup nothing checks.

One number is not inherited: `textLength`. GitHub serves the file inside an `<img>`, so the wordmark
resolves against the reader's fonts — SF Pro Display on a Mac, something else everywhere else,
measuring differently and pushing the composition off its own plate. The run is pinned to the width
it was laid out for and `lengthAdjust="spacingAndGlyphs"` absorbs the difference. The value is a
CoreText measurement of the string at the size it is set in, so changing either means re-measuring
it; `scripts/lib/lockup.mjs` says so where the constant is defined.
