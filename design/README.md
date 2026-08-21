# Cupertino icon

Direction `1f` — the place the app is named for: two hills, one low sun.

One source, three renderings, one command:

```bash
make icon
```

| File                                     | Role                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `cupertino-mark.svg`                     | **the source.** Sun and hills on a transparent sky, 1024×1024. Edit this. |
| `colors.json`                            | palette and gradients                                                     |
| `cupertino-icon.svg`                     | _generated_ — plated vector for the web/README/docs                       |
| `../apps/apple/Cupertino/Cupertino.icon` | _generated_ — the Icon Composer bundle Xcode compiles                     |

`make icon` writes both generated files and audits the bundle. Never hand-edit them: the mark is
the only geometry, which is the whole point of generating the rest from it.

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

`cupertino-menubar.svg` is the mark reduced to three shapes — a filled sun over the back ridge and
the front hill. It is a **template image**: pure black plus alpha, no colour, so AppKit tints it for
light menu bars, dark menu bars and the highlighted state instead of us shipping three renderings.

It is variant **E2c** ("big sun, thin wave") from the menu bar canvas, kept at that canvas's own
36-unit grid drawn at 18pt — so 2 units = 1pt, and the coordinates in the file are the ones in the
design, unscaled. Keeping the grid is what makes a change in the canvas transcribable rather than
re-derived.

The three shapes carry three different weights on purpose: one heavy (the sun), one light (the
stroked back ridge), one solid (the filled front hill). Matched weights read as tramlines rather
than as a scene receding, which is what the earlier equal-ridge pairs did. The front hill is a
filled region closed along the bottom edge, not a second stroke — the fill keeps its own silhouette
however the thin stroke above it antialiases.

Measured against `tray.full`, the SF Symbol it replaced:

|                    | ink              | canvas     | strokes |
| ------------------ | ---------------- | ---------- | ------- |
| `tray.full` @ 18pt | 21.00 × 16.00 pt | 25 × 18 pt | —       |
| this glyph         | 16.10 × 14.15 pt | 18 × 18 pt | 1.10 pt |

Ink is centred in the canvas: the back ridge's round caps reach 1.9 and 34.1 on the 36-unit grid,
so the horizontal midpoint is exactly 18. The caps are what set the horizontal extent, and they sit
0.95pt inside the edge — a real gutter, so nothing clips at 1x, but there is no room to widen the
ridge without eating it.

At 18pt the two waves merge into one connected shape at 1x and separate into three at 2x. That is
the baseline, not a regression: counting connected components in the rendered slots, the ridge-pair
glyph this replaced did exactly the same. Re-run the count after any change to the ridges rather
than trusting the 2x render — at 1x the failure mode is the sun touching the wave, and it is
invisible at the size you will be looking at it.

`actool` reads the SVG directly and preserves the vector representation, so there are no PNG slots
to keep in step. `make icon` copies the file into `MenuBarIcon.imageset`, which is why that copy is
listed as generated above.

## Not generated from here

The horizontal lockup still lives in the design canvas, not in this folder.
