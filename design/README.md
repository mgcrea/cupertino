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
grid drawn at 18pt — so 2 units = 1pt, and the coordinates in the file are the ones in the design,
unscaled. Keeping the grid is what makes a change in the canvas transcribable rather than
re-derived.

Two shapes, two weights: the disc is solid, the horizon is a 1.8-unit stroke. The disc is what you
see first and the horizon is what tells you it is a horizon — matched weights read as tramlines
rather than as a scene, which is what the earlier ridge pairs did.

### The cut is a clip, not a mask

The canvas draws the disc's cut as a `<mask>`: a 6-wide black stroke run along the horizon. **Do not
transcribe that literally.** Rendered through `NSImage`'s SVG rep — the same path the menu bar
takes — the mask's soft edge leaves roughly 25% residual alpha the whole length of the cut, and that
residue bridges the disc to the horizon. The glyph comes out as one connected shape instead of two.

The file uses a `<clipPath>` instead, which cuts hard. Its path is the horizon offset 3 units
straight up. That is a vertical offset rather than a true normal offset, which is only legitimate
because the curve is shallow: its steepest slope is `dy/dx = -0.2`, so the normal offset there is
2.94 where the vertical one is 3.00 — 0.03pt, which never reaches a pixel.

### Measurements

Geometric, on the 36-unit grid, against `tray.full` — the SF Symbol the menu bar icon replaced:

|                    | ink              | canvas     | strokes |
| ------------------ | ---------------- | ---------- | ------- |
| `tray.full` @ 18pt | 21.00 × 16.00 pt | 25 × 18 pt | —       |
| this glyph         | 16.90 × 8.25 pt  | 18 × 18 pt | 0.90 pt |
| connected state    | 16.90 × 10.25 pt | 18 × 18 pt | 0.90 pt |

F3 is wide and short where E2c, the variant it replaced, was nearly square (16.10 × 14.15 pt). That
is the shape of a horizon and it is deliberate, not a shrunk glyph. Horizontally the ink is the same
width and dead centred: the horizon's round caps reach 1.1 and 34.9, midpoint exactly 18.
Vertically, see "Sitting it down" — the disc crowns at 10.8 and the caps bottom out at 27.3.

Two numbers are worth keeping in view:

- **1.05pt of sky** between the disc's cut (y22.2 at the centre) and the top of the horizon's stroke
  (y24.3). That gap is the glyph. Lose it and the sun welds to the horizon and the mark is a blob.
- **0.55pt of gutter** at left and right, down from E2c's 0.95pt. The horizon runs the full 32-unit
  live area and its caps spill 0.9 past each end. Nothing clips at 1x, but there is no room left to
  widen it.

### The connected state

The halo is `r11.4`, stroke 1.6, inside the same clip as the disc — so the ring sets behind the same
horizon and both terminate on one line.

Its 2.4-unit gap was swept, not chosen. Counting connected components at 18pt/2x: at a 2.0-unit gap
the disc's antialiased edge still meets the ring's diagonally and the two fuse; at 2.2 they
separate. 2.4 sits one step clear of that boundary rather than balanced on it.

That the ring can be this generous is the point of moving to F3. E2c put its sun at `cy9.5` with 3.7
units of headroom, which forced a 1.1-unit stroke across a 1.65-unit gap — and measured, **that ring
never actually separated from its sun at 2x**, whatever its file claimed. F3 puts the sun mid-canvas
with 10.8 units above it.

The ring is also what makes this state ride higher than the idle one: it adds 4 units above the disc
and nothing below, because its lower half is clipped away by the horizon. There is no symmetric halo
to be had for a sun that sets behind something, which is what the next section is about.

### Sitting it down

Both files draw the glyph **1 unit (0.5pt) below F3's own coordinates.** Change it in both or not at
all.

At F3's coordinates the idle bounding box is exactly centred and the glyph still reads high: the
disc is a solid mass in the upper half against a 0.9pt line below it, so the eye centres on the disc
rather than on the box. The connected state was worse and measurably so — the halo's one-sided
4 units left it 2.5pt clear of the top against 4.5pt clear of the bottom.

One offset has to serve both, because the disc and the horizon are identical in the two files by
design — drift there reads as the mark twitching when a client connects rather than as a state
changing. So this cannot centre both states, and the choice is where to put the error:

| shift       | idle          | connected      |
| ----------- | ------------- | -------------- |
| 0 units     | centred       | 2.0pt high     |
| **+1 unit** | **0.5pt low** | **0.5pt high** |
| +1.5 units  | 0.75pt low    | centred        |

+1 splits it evenly, and it moves the idle glyph's mass down, which is the direction optical
centring wanted anyway.

### Component counts

The check, at 18pt, counting 8-connected components of the rendered alpha at a threshold of 32:

| state     | 2x                      | 1x             |
| --------- | ----------------------- | -------------- |
| idle      | 2 — disc, horizon       | 1 — all merged |
| connected | 3 — halo, disc, horizon | 1 — all merged |

Both hold at 16pt as well as 18pt, and identically whether measured on the SVG or on the rendition
`actool` compiles into `Assets.car`.

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
