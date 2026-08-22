// The horizontal lockup: the plated icon and the word, on one warm plate.
//
// This is composed, never drawn. `design/README.md` states the rule the whole
// icon system is built on — `cupertino-mark.svg` is the only geometry — and the
// lockup is the one asset that historically broke it. The copy in the design
// canvas was hand-drawn beside the mark rather than from it, and its hills are
// now a single simplified path that the mark has not had for two revisions.
// Nobody noticed, because a lockup nothing generates is a lockup nothing checks.
//
// So this does not redraw the sun, the hills, the sky gradient or the squircle.
// It embeds `design/cupertino-icon.svg` whole and scales it. Everything that can
// drift is inherited, and the only numbers here are layout.
//
// Layout, and one defence. GitHub serves the file inside an `<img>`, so the
// wordmark resolves against the READER's fonts, not ours: SF Pro Display on a
// Mac, a fallback everywhere else, measuring differently. A composition centred
// on the Mac width would sit off-centre or overrun the plate for everyone else.
// `textLength` pins the run to the width the layout was computed for, and
// `lengthAdjust="spacingAndGlyphs"` spends the difference on the fallback's
// glyphs. It also makes `letter-spacing` redundant — the pinned width IS the
// tracking, which is why there is no tracking attribute below.
//
// Dependency-free, like everything else under scripts/lib.

/** The canvas. 1200×320 renders at 560px wide in the README with room to spare. */
const WIDTH = 1200;
const HEIGHT = 320;
const RADIUS = 40;

/**
 * The icon's rendered size, and the gap between it and the word — a quarter of
 * the icon, the same ratio the nav lockup uses. 45 rather than 44 so that
 * ICON + GAP + TEXT_WIDTH is even and the block centres on the canvas exactly;
 * at 44 the two margins differ by a pixel, which is invisible but untestable.
 */
const ICON = 176;
const GAP = 45;

const FONT_SIZE = 104;
const FONT_WEIGHT = 600;
/**
 * The width "Cupertino" is pinned to: its natural advance in SF Pro Display
 * semibold at FONT_SIZE, tightened by the 2% tracking the wordmark carries
 * everywhere else. Measured with CoreText rather than guessed — 457.5 natural,
 * 441.0 tracked — because there is no font metric available at render time to
 * derive it from, and a wrong value here shows up as a stretched or squeezed
 * word rather than as an error. Re-measure if the string or the size changes.
 */
const TEXT_WIDTH = 441;

/**
 * SF's cap height as a fraction of the em, measured (73.3 at 104). The word is
 * optically centred on its caps rather than on its baseline: "Cupertino" has one
 * descender and eight glyphs that stop at the baseline, so baseline-centring
 * reads high.
 */
const CAP_RATIO = 0.705;

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Throws rather than passing the artwork through, in the spirit of
 * `replaceOnce` in apps/website/scripts/generate-icons.mjs. Every assertion here
 * guards something that would otherwise fail silently and ship a broken banner.
 */
const expect = (condition, message) => {
  if (!condition) throw new Error(`cupertino-lockup: ${message}`);
};

const escapeXml = (text) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );

/**
 * Pulls the drawable body out of an SVG file — everything between the root
 * `<svg>` tag and its close. Regex rather than a parser because the input is one
 * known generated file, and because a parser is a dependency this does not need.
 */
const bodyOf = (svg) => {
  const match = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg);
  expect(match, "the icon does not look like an SVG document");
  return match[1];
};

/**
 * Renames every id in the embedded fragment and every `url(#…)` that points at
 * one. The icon ships ids as generic as `c`; the lockup adds its own gradient,
 * and two documents that never met are about to share one id space.
 */
const namespaceIds = (body, prefix) => {
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(ids.length > 0, "the icon defines no ids — has its structure changed?");
  return ids.reduce(
    (text, id) =>
      text
        .replaceAll(`id="${id}"`, `id="${prefix}${id}"`)
        .replaceAll(`url(#${id})`, `url(#${prefix}${id})`),
    body,
  );
};

/** Reads the square viewBox the scale factor is derived from. */
const viewBoxOf = (svg) => {
  const match = /\bviewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  expect(match, 'the icon has no `viewBox="0 0 w h"` to scale from');
  const [width, height] = [Number(match[1]), Number(match[2])];
  expect(width === height, `the icon is not square (${width}×${height})`);
  return width;
};

/**
 * Composes the lockup from the generated icon and the shared palette.
 *
 * @param {string} iconSvg contents of `design/cupertino-icon.svg`
 * @param {object} palette parsed `design/colors.json`
 * @param {string} [word] the wordmark; re-measure TEXT_WIDTH if you change it
 * @returns {string} the lockup SVG
 */
export const composeLockup = (iconSvg, palette, word = "Cupertino") => {
  const ink = palette?.colors?.ink;
  const wash = palette?.gradients?.wash;
  expect(ink, "colors.json has no `colors.ink`");
  expect(wash?.stops?.length === 2, "colors.json has no two-stop `gradients.wash`");
  expect(wash.angle === 180, `the wash gradient is not vertical (angle ${wash.angle})`);

  const source = viewBoxOf(iconSvg);
  const scale = ICON / source;

  const body = namespaceIds(bodyOf(iconSvg), "icon-")
    // The icon's own provenance comment and group title belong to that file, not
    // to this one — a nested <title> would give the group a second, competing
    // accessible name inside a document that already has one.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/^\s*\n/gm, "")
    .trimEnd();
  expect(body.includes("<circle"), "the sun is missing from the icon body");
  expect((body.match(/<path\b/g) ?? []).length >= 2, "the hills are missing from the icon body");

  // The pair is centred as one block, not centred individually: the eye reads
  // the icon and the word as a single object, so the whitespace belongs outside.
  const blockWidth = ICON + GAP + TEXT_WIDTH;
  const iconX = Math.round((WIDTH - blockWidth) / 2);
  const iconY = Math.round((HEIGHT - ICON) / 2);
  const textX = iconX + ICON + GAP;
  const baseline = Math.round(HEIGHT / 2 + (CAP_RATIO * FONT_SIZE) / 2);

  const indented = body
    .split("\n")
    .map((line) => (line.trim() ? `    ${line.trim()}` : ""))
    .filter(Boolean)
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"
     viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(word)}">
  <!-- GENERATED by scripts/generate-lockup.mjs — do not edit. -->
  <title>${escapeXml(word)}</title>
  <defs>
    <linearGradient id="wash" gradientUnits="userSpaceOnUse" x1="${WIDTH / 2}" y1="0" x2="${
      WIDTH / 2
    }" y2="${HEIGHT}">
      <stop offset="${wash.stops[0].offset}" stop-color="${wash.stops[0].color}"/>
      <stop offset="${wash.stops[1].offset}" stop-color="${wash.stops[1].color}"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="${RADIUS}" fill="url(#wash)"/>
  <g transform="translate(${iconX} ${iconY}) scale(${scale})">
${indented}
  </g>
  <text x="${textX}" y="${baseline}" fill="${ink}"
        font-family='${FONT_STACK}' font-size="${FONT_SIZE}" font-weight="${FONT_WEIGHT}"
        textLength="${TEXT_WIDTH}" lengthAdjust="spacingAndGlyphs">${escapeXml(word)}</text>
</svg>
`;
};

/** Exported for the tests, which assert the geometry rather than re-derive it. */
export const LOCKUP = { WIDTH, HEIGHT, RADIUS, ICON, GAP, TEXT_WIDTH, FONT_SIZE };
