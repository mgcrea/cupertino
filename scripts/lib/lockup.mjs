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
 * The advance of "Cupertino" per em of font size, in SF Pro Display semibold,
 * tightened by the 2% tracking the wordmark carries everywhere else. Measured
 * with CoreText at 104px rather than guessed — 457.5 natural, 441.0 tracked —
 * because there is no font metric available at render time to derive it from,
 * and a wrong value shows up as a stretched or squeezed word rather than as an
 * error. Re-measure if the STRING changes; the size is free, because this is a
 * ratio and `wordmarkWidth` scales it.
 */
const WORDMARK_EM = 441 / 104;

/**
 * SF's cap height as a fraction of the em, measured (73.3 at 104). The word is
 * optically centred on its caps rather than on its baseline: "Cupertino" has one
 * descender and eight glyphs that stop at the baseline, so baseline-centring
 * reads high.
 */
const CAP_RATIO = 0.705;

/** The width the wordmark is pinned to at a given size. */
export const wordmarkWidth = (fontSize) => Math.round(fontSize * WORDMARK_EM);

const TEXT_WIDTH = wordmarkWidth(FONT_SIZE);

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
 * The icon, as a `<g>` ready to drop into a larger document at any size. Both
 * compositions go through here, so neither can acquire its own copy of the
 * artwork — which is the failure this whole module exists to prevent.
 */
const embedIcon = (iconSvg, { x, y, size, indent }) => {
  const source = viewBoxOf(iconSvg);

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

  const pad = " ".repeat(indent);
  const inner = body
    .split("\n")
    .map((line) => (line.trim() ? `${pad}  ${line.trim()}` : ""))
    .filter(Boolean)
    .join("\n");

  return `${pad}<g transform="translate(${x} ${y}) scale(${size / source})">\n${inner}\n${pad}</g>`;
};

/**
 * The wordmark, pinned to its measured width. See WORDMARK_EM for why it is
 * pinned rather than tracked, and why that is not the same decision in a PNG as
 * it is in an SVG the reader's browser lays out.
 */
const wordmark = ({ x, baseline, size, fill, word, indent }) => {
  const pad = " ".repeat(indent);
  return `${pad}<text x="${x}" y="${baseline}" fill="${fill}"
${pad}      font-family='${FONT_STACK}' font-size="${size}" font-weight="${FONT_WEIGHT}"
${pad}      textLength="${wordmarkWidth(size)}" lengthAdjust="spacingAndGlyphs">${escapeXml(
    word,
  )}</text>`;
};

/** The x the icon starts at when icon + gap + word is centred in `canvasWidth`. */
const centredBlock = (canvasWidth, iconSize, gap, fontSize) => {
  const blockWidth = iconSize + gap + wordmarkWidth(fontSize);
  const iconX = Math.round((canvasWidth - blockWidth) / 2);
  return { blockWidth, iconX, textX: iconX + iconSize + gap };
};

/**
 * Composes the lockup from the generated icon and the shared palette.
 *
 * @param {string} iconSvg contents of `design/cupertino-icon.svg`
 * @param {object} palette parsed `design/colors.json`
 * @param {string} [word] the wordmark; re-measure WORDMARK_EM if you change it
 * @returns {string} the lockup SVG
 */
export const composeLockup = (iconSvg, palette, word = "Cupertino") => {
  const ink = palette?.colors?.ink;
  const wash = palette?.gradients?.wash;
  expect(ink, "colors.json has no `colors.ink`");
  expect(wash?.stops?.length === 2, "colors.json has no two-stop `gradients.wash`");
  expect(wash.angle === 180, `the wash gradient is not vertical (angle ${wash.angle})`);

  // The pair is centred as one block, not centred individually: the eye reads
  // the icon and the word as a single object, so the whitespace belongs outside.
  const { iconX, textX } = centredBlock(WIDTH, ICON, GAP, FONT_SIZE);
  const iconY = Math.round((HEIGHT - ICON) / 2);
  const baseline = Math.round(HEIGHT / 2 + (CAP_RATIO * FONT_SIZE) / 2);

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
${embedIcon(iconSvg, { x: iconX, y: iconY, size: ICON, indent: 2 })}
${wordmark({ x: textX, baseline, size: FONT_SIZE, fill: ink, word, indent: 2 })}
</svg>
`;
};

// ── The social card ───────────────────────────────────────────────────────────
//
// What a link to the site looks like on X, Slack, iMessage and everywhere else
// that reads og:image. It was the bare icon on the page's own black, which said
// nothing: the card's title and description render BELOW the image in small
// grey type that truncates on a phone, so the image is the whole message and an
// orange square is not one.
//
// Two constraints shape it, and neither is obvious.
//
// X renders `summary_large_image` at 2:1 and og:image is 1.91:1, so it trims
// roughly 15px off the top and bottom. SAFE_INSET keeps every mark well clear of
// that band — the crop is silent, and a headline losing its descenders is the
// kind of thing nobody sees until it is public.
//
// And unlike the README lockup, this is BAKED: `pnpm icons` renders it to PNG
// once and commits the result, so the font resolves on the machine that ran the
// command rather than on the reader's. That is safe here only because the repo
// is already macOS-only — `make icon` needs appshot, the screenshots need a Mac,
// and package.json declares `"os": ["darwin"]`. Rendering this on Linux CI would
// silently swap the typeface. Nothing enforces that; it is why this comment is.

const CARD = { WIDTH: 1200, HEIGHT: 630, SAFE_INSET: 60 };

/** The card's own scale: a smaller lockup than the README's, over two lines of copy. */
const CARD_ICON = 132;
const CARD_GAP = 33;
const CARD_WORD = 78;
const CARD_HEADLINE = 38;
const CARD_SUBHEAD = 28;

/** Where the lockup's optical centre sits. Above the copy, above the canvas centre. */
const CARD_LOCKUP_MID = 250;
const CARD_HEADLINE_Y = 404;
const CARD_SUBHEAD_Y = 460;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The start and end of a linear ramp across a canvas, in SVG's own y-down user
 * space. A port of appshot's `Compose.gradientAxis`, corner projection and all.
 *
 * It is a port rather than an approximation because the store plates and this
 * card now render the SAME gradient from the SAME definition — see the ground
 * note on `composeCard` — and an axis recomputed "close enough" from the angle
 * would agree with appshot only at the angles somebody happened to try.
 *
 * Degrees CLOCKWISE with y DOWN, which is appshot's convention and NOT the CSS
 * one: here 90 starts at the top and 270 at the bottom, where CSS reads those as
 * 180 and 0. `design/colors.json` uses the CSS convention for `sky` and `wash`,
 * and `composeLockup` asserts `angle === 180` on that basis. The two conventions
 * must not meet: this takes a raw appshot angle, never a palette entry.
 */
const gradientAxis = (angle, w, h) => {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  const [cx, cy] = [w / 2, h / 2];
  const projections = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ].map(([x, y]) => (x - cx) * dx + (y - cy) * dy);
  const low = Math.min(...projections);
  const high = Math.max(...projections);
  return {
    x1: round2(cx + dx * low),
    y1: round2(cy + dy * low),
    x2: round2(cx + dx * high),
    y2: round2(cy + dy * high),
  };
};

/**
 * Resolves the card's ground into a `<defs>` block and the fill that references
 * it. A flat hex still works and stays the simpler answer; an `{ angle, stops }`
 * object becomes a `userSpaceOnUse` linear gradient on the axis above.
 */
const cardGround = (ground, w, h) => {
  if (typeof ground === "string") {
    expect(/^#[0-9a-f]{6}$/i.test(ground), `the card ground is not a hex colour (${ground})`);
    return { defs: "", fill: ground };
  }
  expect(
    Number.isFinite(ground?.angle) && ground?.stops?.length >= 2,
    "the card ground is neither a hex colour nor an { angle, stops } gradient",
  );
  const { x1, y1, x2, y2 } = gradientAxis(ground.angle, w, h);
  const stops = ground.stops
    .map((s) => `      <stop offset="${s.offset}" stop-color="${s.color}"/>`)
    .join("\n");
  return {
    fill: "url(#plate)",
    defs: `  <defs>
    <linearGradient id="plate" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
${stops}
    </linearGradient>
  </defs>
`,
  };
};

const cardLine = ({ text, y, size, fill, weight, opacity }) =>
  `  <text x="${CARD.WIDTH / 2}" y="${y}" fill="${fill}"${
    opacity ? ` opacity="${opacity}"` : ""
  } text-anchor="middle"
        font-family='${FONT_STACK}' font-size="${size}" font-weight="${weight}">${escapeXml(
          text,
        )}</text>`;

/**
 * Composes the og:image card — the lockup reversed out of the site's own
 * background, over a headline and a subhead.
 *
 * The two lines are NOT pinned with `textLength` the way the wordmark is. That
 * pin exists to survive a reader's font substitution; here the font is resolved
 * once at build time, and pinning arbitrary sentences would distort them for no
 * gain. `text-anchor="middle"` keeps them centred whatever they measure.
 *
 * The ground is either a flat hex or the `{ angle, stops }` gradient the store
 * plates are composed on. It is the latter now, and it is not copied here: the
 * caller reads it straight out of `apps/apple/Screenshots/screenshots.config.json`,
 * which is the file appshot itself renders. A card and a store plate that quote
 * the same brand ground from two hand-kept copies is the mark drift this whole
 * module exists to have stopped — see the header of generate-icons.mjs.
 *
 * @param {string} iconSvg contents of `design/cupertino-icon.svg`
 * @param {object} palette parsed `design/colors.json`
 * @param {object} copy `{ ground, headline, subhead }` — the site owns the words
 * @returns {string} the card SVG, for sharp to rasterise
 */
export const composeCard = (
  iconSvg,
  palette,
  { ground, headline, subhead, word = "Cupertino" },
) => {
  const light = palette?.colors?.sun;
  expect(light, "colors.json has no `colors.sun` to reverse the wordmark out in");
  expect(headline && subhead, "the card needs both a headline and a subhead");
  const plate = cardGround(ground, CARD.WIDTH, CARD.HEIGHT);

  const { iconX, textX } = centredBlock(CARD.WIDTH, CARD_ICON, CARD_GAP, CARD_WORD);
  const iconY = Math.round(CARD_LOCKUP_MID - CARD_ICON / 2);
  const baseline = Math.round(CARD_LOCKUP_MID + (CAP_RATIO * CARD_WORD) / 2);

  // The crop is silent, so the check cannot be. Descenders reach roughly a
  // quarter of the em below the baseline.
  const lowest = CARD_SUBHEAD_Y + CARD_SUBHEAD * 0.25;
  expect(iconY >= CARD.SAFE_INSET, "the lockup sits inside the band X crops away");
  expect(
    lowest <= CARD.HEIGHT - CARD.SAFE_INSET,
    `the subhead reaches ${Math.round(lowest)}, inside the band X crops away`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.WIDTH}" height="${CARD.HEIGHT}"
     viewBox="0 0 ${CARD.WIDTH} ${CARD.HEIGHT}" role="img" aria-label="${escapeXml(word)}">
  <!-- GENERATED by apps/website/scripts/generate-icons.mjs — do not edit. -->
  <title>${escapeXml(word)}</title>
${plate.defs}  <rect width="${CARD.WIDTH}" height="${CARD.HEIGHT}" fill="${plate.fill}"/>
${embedIcon(iconSvg, { x: iconX, y: iconY, size: CARD_ICON, indent: 2 })}
${wordmark({ x: textX, baseline, size: CARD_WORD, fill: light, word, indent: 2 })}
${cardLine({ text: headline, y: CARD_HEADLINE_Y, size: CARD_HEADLINE, fill: light, weight: 500 })}
${cardLine({
  text: subhead,
  y: CARD_SUBHEAD_Y,
  size: CARD_SUBHEAD,
  fill: light,
  weight: 400,
  opacity: "0.62",
})}
</svg>
`;
};

/** Exported for the tests, which assert the geometry rather than re-derive it. */
export const LOCKUP = { WIDTH, HEIGHT, RADIUS, ICON, GAP, TEXT_WIDTH, FONT_SIZE };
export const SOCIAL_CARD = { ...CARD, ICON: CARD_ICON, GAP: CARD_GAP, WORD: CARD_WORD };
