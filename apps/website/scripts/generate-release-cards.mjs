/**
 * One social card per release, for the link to /changelog/<version>.
 *
 *   pnpm cards           # render every card that is missing or stale
 *   pnpm cards --check   # fail if one is, without rendering anything
 *
 * A release gets a card when its CHANGELOG section opens with a summary — a
 * `**Title.** description` paragraph, see `Summary` in scripts/lib/changelog.mjs.
 * Releases before 1.25.0 have none, and their pages fall back to the site card.
 *
 * ## Baked on a Mac, checked anywhere
 *
 * The PNG is rendered here and committed, for the reason `og-image.png` is: the
 * title is set in whatever font the rendering machine resolves, and Linux CI
 * would quietly swap SF Pro for something else. So CI cannot render a card to
 * compare it.
 *
 * What it can do is compose the SVG — that is text, and needs no font — and
 * hash it. `src/data/release-cards.json` records the hash of the SVG each PNG
 * was rendered from, so `--check` catches a card that has fallen behind its
 * title, its date, the brand ground or the layout in `lockup.mjs`, on a machine
 * that could never render it. `make changelog` runs this at release time, which
 * is when a new summary appears.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, plain } from "../../../scripts/lib/changelog.mjs";
import { composeReleaseCard, RELEASE_CARD } from "../../../scripts/lib/lockup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = join(here, "..", "public", "changelog");
const manifestPath = join(here, "..", "src", "data", "release-cards.json");
const check = process.argv.includes("--check");

/** What the card says under the date, at the right. The page it is a picture of. */
const FOOTER = "cupertino.mgcrea.io/changelog";

const read = (path) => readFile(join(root, path), "utf8");

const icon = await read("design/cupertino-icon.svg");
const palette = JSON.parse(await read("design/colors.json"));
// The store plates' ground, as `generate-icons.mjs` reads it for the site card,
// so a release card and the site card cannot quote different gradients.
const ground = JSON.parse(await read("apps/apple/Screenshots/screenshots.config.json"))?.themes
  ?.dark?.background;
if (!ground?.stops?.length) {
  console.error("screenshots.config.json has no themes.dark.background to ground the cards on");
  process.exit(2);
}

const releases = parse(await read("CHANGELOG.md")).filter((r) => !r.unreleased && r.summary);

/** @type {Record<string, string>} */
const recorded = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
/** @type {Record<string, string>} */
const manifest = {};
const stale = [];

for (const release of releases) {
  const svg = composeReleaseCard(icon, palette, {
    ground,
    version: release.version,
    date: release.date,
    title: plain(release.summary.title),
    footer: FOOTER,
  });
  const hash = createHash("sha256").update(svg).digest("hex");
  manifest[release.version] = hash;
  const png = join(out, `${release.version}.png`);
  if (recorded[release.version] === hash && existsSync(png)) continue;
  stale.push(release.version);
  if (check) continue;

  // Imported here rather than at the top so `--check`, which renders nothing,
  // does not need sharp's native binary — CI's test job runs it.
  const { default: sharp } = await import("sharp");
  await mkdir(out, { recursive: true });
  await writeFile(
    png,
    // Density 200 then back down, as the site card is: crisp edges at 1200×630.
    await sharp(Buffer.from(svg), { density: 200 })
      .resize(RELEASE_CARD.WIDTH, RELEASE_CARD.HEIGHT)
      .png({ palette: true })
      .toBuffer(),
  );
  console.log(`  changelog/${release.version}.png`);
}

if (check) {
  if (stale.length > 0) {
    console.error(
      `release cards out of date: ${stale.join(", ")} — run \`pnpm -C apps/website cards\` on a Mac and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`release cards: ${releases.length} up to date`);
  process.exit(0);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release cards: ${stale.length} rendered, ${releases.length - stale.length} unchanged`);
