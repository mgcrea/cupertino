# Cupertino icon

Direction `1f` — the place the app is named for: two hills, one low sun.

One source, three renderings, one command:

```bash
make icon
```

| File                              | Role                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `cupertino-mark.svg`              | **the source.** Sun and hills on a transparent sky, 1024×1024. Edit this. |
| `colors.json`                     | palette and gradients                                                     |
| `cupertino-icon.svg`              | _generated_ — plated vector for the web/README/docs                       |
| `../app/Cupertino/Cupertino.icon` | _generated_ — the Icon Composer bundle Xcode compiles                     |

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

## Not generated from here

The menu bar glyph and the horizontal lockup still live in the design canvas, not in this folder.
