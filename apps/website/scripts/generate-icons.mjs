import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regenerates every raster the site serves from the two SVG marks in public/.
 *
 * The marks themselves are copied in from `.idea/design/logo/`, which is
 * gitignored — so these outputs stay committed. A checkout without the design
 * directory still builds, and `pnpm icons` is only needed when the mark changes.
 */
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");

const render = async (src, out, size, background) => {
  const svg = await readFile(join(pub, src));
  let img = sharp(svg, { density: 400 }).resize(size, size, {
    fit: "contain",
    background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
  });
  if (background) img = img.flatten({ background });
  await writeFile(join(pub, out), await img.png().toBuffer());
  console.log(`  ${out}  ${size}×${size}`);
};

// The OG card is the mark centred on the page's own background, so a shared
// link matches the site it opens.
const og = async () => {
  const [w, h] = [1200, 630];
  const mark = await sharp(await readFile(join(pub, "app-icon.svg")), { density: 400 })
    .resize(300, 300)
    .png()
    .toBuffer();
  const buf = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 11, g: 12, b: 15, alpha: 1 } },
  })
    .composite([{ input: mark, top: (h - 300) / 2, left: (w - 300) / 2 }])
    .png()
    .toBuffer();
  await writeFile(join(pub, "og-image.png"), buf);
  console.log(`  og-image.png  ${w}×${h}`);
};

console.log("icons →");
// 16–64px is the small mark's job per the brand README; the touch icon is
// larger, so it takes the full two-hill art.
await render("icon-small.svg", "favicon-32.png", 32);
await render("app-icon.svg", "apple-touch-icon.png", 180);
await og();
