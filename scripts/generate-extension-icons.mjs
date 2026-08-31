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
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * How much of the canvas the squircle spans, with transparency around it.
 *
 * macOS builds this inset into the icon grid — an app icon's rounded square
 * occupies 824 of 1024 points and the rest is padding, which is why every icon
 * in a Dock or a preferences list optically matches its neighbours. A web
 * extension icon is a plain PNG with no grid applied, so drawing the plate
 * edge to edge makes it read heavier and larger than every peer beside it in
 * Safari's Extensions pane, even at identical pixel dimensions.
 */
const PLATE_SPAN = 824 / 1024;

const svg = await readFile(source);
await mkdir(out, { recursive: true });
for (const size of SIZES) {
  const plate = Math.round(size * PLATE_SPAN);
  // Split the remainder so an odd difference does not shift the mark off centre.
  const before = Math.floor((size - plate) / 2);
  const after = size - plate - before;
  // density matches apps/website/scripts/generate-icons.mjs: rasterise well
  // above the target and let sharp downsample, or the curves alias.
  const png = await sharp(svg, { density: 400 })
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
console.log(`  rendered ${SIZES.length} extension icon(s) from ${source.split("/").slice(-2).join("/")}`);
