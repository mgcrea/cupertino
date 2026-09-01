/**
 * Renders the Safari extension's icons from `design/cupertino-icon.svg`.
 *
 * That file is itself generated — `make icon` builds it from
 * `design/cupertino-mark.svg`, the same geometry compiled into the app's Icon
 * Composer bundle — so the chain stays one mark end to end:
 *
 *   design/cupertino-mark.svg --make icon--> design/cupertino-icon.svg
 *                              --make extension-icons--> Resources/images/*
 *
 * ## Why the SVG and not appshot's .appiconset
 *
 * The first version rendered an .appiconset and sized its largest slot down.
 * The mark bleeds past the plate's corners by design, and macOS masks an app
 * icon to the squircle for free — but these PNGs are drawn in browser chrome
 * that masks nothing, so the hills spilled out of the corners. `--corner-radius`
 * does not help: appshot documents it as "corner radius of an .svg plate", and
 * it has no effect on a raster set.
 *
 * `design/cupertino-icon.svg` already carries the clip, applied by `make icon`
 * for exactly this reason — nothing masks an SVG on a web page either. So the
 * right source was already sitting there.
 *
 * ## Why these are round and the app icon is not
 *
 * The same PNGs serve two places, and one of them is Safari's toolbar. Every
 * other button up there is a monochrome SF Symbol on no plate at all, so a
 * squircle reads as a sticker somebody pasted into the chrome — the one shape
 * in the row with corners. A disc is the closest this mark gets to the round
 * bounding shape the toolbar already uses, and it stays the app's own artwork
 * rather than a second, flattened glyph nobody would keep in step.
 *
 * The app icon is untouched. macOS masks it to the platform squircle and it is
 * shown next to other app icons, where a disc would be the odd one out for the
 * mirrored reason.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// sharp is the website's dependency, not the root's, and pnpm does not hoist it.
// Reaching through that package rather than adding a second copy at the root:
// one renderer, one version, and `pnpm icons` and this command cannot disagree
// about how the same SVG rasterises.
const require = createRequire(import.meta.url);
const sharp = (
  await import(
    require.resolve("sharp", {
      paths: [join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "website")],
    })
  )
).default;

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "design", "cupertino-icon.svg");
const out = join(here, "..", "apps", "apple", "CupertinoSafariExtension", "Resources", "images");

/** The sizes `Resources/manifest.json` names. scripts/verify-extension.sh fails the build if they disagree. */
const SIZES = [48, 96, 128, 256, 512];

/**
 * How much of the canvas the plate spans, with transparency around it.
 *
 * macOS builds this inset into the icon grid — an app icon's rounded square
 * occupies 824 of 1024 points and the rest is padding, which is why every icon
 * in a Dock or a preferences list optically matches its neighbours. A web
 * extension icon is a plain PNG with no grid applied, so drawing the plate
 * edge to edge makes it read heavier and larger than every peer beside it in
 * Safari's Extensions pane, even at identical pixel dimensions.
 */
const PLATE_SPAN = 824 / 1024;

const svg = (await readFile(source)).toString();

/**
 * The corner radius `make icon` clipped the plate to, as a fraction of its own
 * side — parsed rather than assumed, because it is `ICON_RADIUS` in the
 * Makefile and a hard-coded copy here would drift the moment it changed.
 *
 * appshot writes it twice: once on the plate rect, once on the bleed clipPath
 * that keeps the hills off the corners. Both have to become the disc, so the
 * count is asserted — if a future appshot emits a `path` instead, this fails
 * loudly here rather than silently rendering a squircle again.
 */
const radii = [...svg.matchAll(/rx="(\d+(?:\.\d+)?)"/g)];
if (radii.length !== 2) {
  throw new Error(
    `expected 2 rx="…" in ${source} (plate + bleed clip), found ${radii.length} — ` +
      "appshot's output shape changed; the disc rewrite below no longer applies",
  );
}
const cornerRadius = Number(radii[0][1]) / 1024;

/**
 * A rect's `rx` is clamped to half its width, so `rx="512"` on the 1024 square
 * is an exact circle — one substitution turns both the plate and the bleed clip
 * into the disc, and librsvg draws it as vector at the density below. Masking
 * the rendered squircle with a circle instead would multiply two antialiased
 * edges where they run tangent at the four side midpoints, and notch it.
 */
const disc = svg.replace(/rx="\d+(?:\.\d+)?"/g, 'rx="512"');

/**
 * The disc is drawn *larger* than the squircle it replaces: 0.888 of the canvas
 * against 0.805.
 *
 * Not a nudge — it is the diameter at which the disc covers the same area as
 * the rounded square did, so it carries the same optical weight beside its
 * peers and the inset above still means what it meant. A disc inscribed in the
 * squircle's own box loses the four corners and reads visibly lighter and
 * smaller than every icon around it, which is the failure the inset exists to
 * avoid in the first place.
 */
const plateArea = PLATE_SPAN ** 2 * (1 - (4 - Math.PI) * cornerRadius ** 2);
const DISC_SPAN = Math.sqrt((4 * plateArea) / Math.PI);

await mkdir(out, { recursive: true });
for (const size of SIZES) {
  const plate = Math.round(size * DISC_SPAN);
  // Split the remainder so an odd difference does not shift the mark off centre.
  const before = Math.floor((size - plate) / 2);
  const after = size - plate - before;
  // density matches apps/website/scripts/generate-icons.mjs: rasterise well
  // above the target and let sharp downsample, or the curves alias.
  const png = await sharp(Buffer.from(disc), { density: 400 })
    .resize(plate, plate)
    .extend({
      top: before,
      bottom: after,
      left: before,
      right: after,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  await writeFile(join(out, `icon-${size}.png`), png);
}
console.log(
  `  rendered ${SIZES.length} round extension icon(s) from ${source.split("/").slice(-2).join("/")}`,
);
