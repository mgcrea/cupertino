// Tests for the lockup composition.
//
// The failure this guards against is not a crash — it is a banner that renders,
// looks roughly right, and carries an older mark than the app ships. That is the
// exact incident apps/website/CLAUDE.md records, and it went unnoticed for two
// revisions because nothing asserted the artwork's provenance.
//
// So the assertions are about inheritance rather than appearance: the mark's
// shapes have to arrive from the icon file unmodified, and anything that would
// let them arrive mangled has to throw instead. Appearance is checked by looking
// at the render, which no test can do for you.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { composeCard, composeLockup, LOCKUP, SOCIAL_CARD, wordmarkWidth } from "./lockup.mjs";

const design = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "design");
const icon = readFileSync(join(design, "cupertino-icon.svg"), "utf8");
const palette = JSON.parse(readFileSync(join(design, "colors.json"), "utf8"));

describe("composeLockup", () => {
  const svg = composeLockup(icon, palette);

  it("inherits the mark's geometry verbatim from the icon", () => {
    // The three shapes of design/cupertino-mark.svg, character for character. If
    // one of these ever needs updating here, the lockup has stopped inheriting.
    for (const shape of [
      'cx="512" cy="424" r="124"',
      "M-40 744 Q256 536 552 744 T1120 744 V1064 H-40 Z",
      "M-40 848 Q320 660 660 848 T1120 824 V1064 H-40 Z",
    ]) {
      assert.ok(svg.includes(shape), `missing ${shape}`);
    }
  });

  it("namespaces the icon's ids so nothing collides with the wash gradient", () => {
    assert.ok(svg.includes('id="icon-appshot-plate"'));
    assert.ok(svg.includes("url(#icon-appshot-plate)"));
    assert.ok(svg.includes('id="icon-c"'));
    assert.ok(svg.includes('clip-path="url(#icon-c)"'));
    // The bare ids must be gone, not merely accompanied by prefixed ones.
    assert.doesNotMatch(svg, /\bid="c"/);
    assert.doesNotMatch(svg, /url\(#c\)/);
    assert.ok(svg.includes('id="wash"'), "the lockup's own gradient survived");
  });

  it("centres the icon and the word as one block", () => {
    const block = LOCKUP.ICON + LOCKUP.GAP + LOCKUP.TEXT_WIDTH;
    const iconX = Math.round((LOCKUP.WIDTH - block) / 2);
    assert.ok(
      svg.includes(`translate(${iconX} ${Math.round((LOCKUP.HEIGHT - LOCKUP.ICON) / 2)})`),
      "the icon is not where centring the block puts it",
    );
    assert.ok(svg.includes(`x="${iconX + LOCKUP.ICON + LOCKUP.GAP}"`), "the word follows the gap");
    // Equal margins either side is the whole claim.
    assert.equal(iconX, LOCKUP.WIDTH - (iconX + block));
  });

  it("pins the wordmark's width so a fallback font cannot reflow it", () => {
    assert.ok(svg.includes(`textLength="${LOCKUP.TEXT_WIDTH}"`));
    assert.ok(svg.includes('lengthAdjust="spacingAndGlyphs"'));
    assert.ok(svg.includes(">Cupertino</text>"));
  });

  it("takes its colours from colors.json rather than repeating them", () => {
    assert.ok(svg.includes(`fill="${palette.colors.ink}"`));
    assert.ok(svg.includes(`stop-color="${palette.gradients.wash.stops[0].color}"`));
    assert.ok(svg.includes(`stop-color="${palette.gradients.wash.stops[1].color}"`));
  });

  it("carries one accessible name, not the icon's as well", () => {
    assert.equal(svg.match(/<title>/g).length, 1);
    assert.ok(svg.includes('role="img"'));
    assert.ok(svg.includes('aria-label="Cupertino"'));
  });

  it("escapes a word that would otherwise break the document", () => {
    const quoted = composeLockup(icon, palette, 'A & B "<>"');
    assert.ok(quoted.includes(">A &amp; B &quot;&lt;&gt;&quot;</text>"));
  });

  describe("refuses to guess", () => {
    const cases = [
      ["input that is not an SVG", () => composeLockup("not an svg", palette)],
      [
        "an icon with no viewBox",
        () => composeLockup(icon.replace(/viewBox="[^"]*"/, ""), palette),
      ],
      [
        "a non-square icon",
        () => composeLockup(icon.replace(/viewBox="[^"]*"/, 'viewBox="0 0 1024 512"'), palette),
      ],
      [
        "an icon whose shapes went missing",
        () => composeLockup(icon.replace(/<path\b/g, "<rect"), palette),
      ],
      ["a palette with no ink", () => composeLockup(icon, { ...palette, colors: {} })],
      [
        "a wash gradient that is no longer vertical",
        () =>
          composeLockup(icon, {
            ...palette,
            gradients: { wash: { ...palette.gradients.wash, angle: 90 } },
          }),
      ],
    ];
    for (const [name, run] of cases) {
      it(name, () => assert.throws(run, /cupertino-lockup:/));
    }
  });
});

describe("composeCard", () => {
  const copy = {
    ground: "#0b0c0f",
    headline: "Mail, Notes, Reminders and Calendar, for Claude",
    subhead: "One Full Disk Access grant instead of four",
  };
  const svg = composeCard(icon, palette, copy);

  it("carries the same mark as the README lockup, not a copy of it", () => {
    // Both compositions go through embedIcon, so the geometry is one string in
    // one file. If this ever diverges, the artwork has forked.
    assert.ok(svg.includes("M-40 848 Q320 660 660 848 T1120 824 V1064 H-40 Z"));
    assert.ok(svg.includes('cx="512" cy="424" r="124"'));
  });

  it("reverses the wordmark out in the palette's light, over the site's ground", () => {
    assert.ok(svg.includes(`fill="${palette.colors.sun}"`));
    assert.ok(svg.includes(`fill="${copy.ground}"`));
    // The ink colour is for the light plate; it has no business on a dark card.
    assert.ok(!svg.includes(`fill="${palette.colors.ink}"`));
  });

  it("keeps every mark clear of the band X crops away", () => {
    // X renders summary_large_image at 2:1; og:image is 1.91:1, so it trims this
    // much off each edge. The inset has to cover it with room to spare.
    const trimmed = (SOCIAL_CARD.HEIGHT - SOCIAL_CARD.WIDTH / 2) / 2;
    assert.ok(trimmed < SOCIAL_CARD.SAFE_INSET, "the inset must cover the real crop");

    // Only card-space coordinates: the y inside the icon group belongs to the
    // icon's own 1024 grid and means nothing here.
    const [, iconTop] = /translate\(\d+ (\d+)\)/.exec(svg);
    const baselines = [...svg.matchAll(/<text[^>]*\by="(\d+)"/g)].map((m) => Number(m[1]));
    const sizes = [...svg.matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(baselines.length, 3, "wordmark, headline, subhead");

    const top = Number(iconTop);
    // Descenders reach roughly a quarter of the em below the baseline.
    const bottom = Math.max(...baselines.map((y, i) => y + (sizes[i] ?? 0) * 0.25));
    assert.ok(top >= SOCIAL_CARD.SAFE_INSET, `the artwork starts at y=${top}`);
    assert.ok(
      bottom <= SOCIAL_CARD.HEIGHT - SOCIAL_CARD.SAFE_INSET,
      `the copy reaches y=${Math.round(bottom)}`,
    );
  });

  it("centres the lockup as one block, as the banner does", () => {
    const block = SOCIAL_CARD.ICON + SOCIAL_CARD.GAP + wordmarkWidth(SOCIAL_CARD.WORD);
    const iconX = Math.round((SOCIAL_CARD.WIDTH - block) / 2);
    assert.ok(svg.includes(`translate(${iconX} `), "the icon is not where centring puts it");
    assert.equal(iconX, SOCIAL_CARD.WIDTH - (iconX + block));
  });

  it("centres the two copy lines without pinning them", () => {
    // The wordmark is pinned because a READER's font substitutes; these two are
    // baked to PNG at build time, so pinning would only distort them.
    assert.equal(svg.match(/text-anchor="middle"/g).length, 2);
    assert.ok(svg.includes(`>${copy.headline}</text>`));
    assert.ok(svg.includes(`>${copy.subhead}</text>`));
    assert.equal(svg.match(/textLength=/g).length, 1, "only the wordmark is pinned");
  });

  describe("refuses to guess", () => {
    const cases = [
      ["a ground that is not a colour", () => composeCard(icon, palette, { ...copy, ground: "" })],
      [
        "a palette with no light to reverse out in",
        () => composeCard(icon, { ...palette, colors: {} }, copy),
      ],
      ["copy with no subhead", () => composeCard(icon, palette, { ...copy, subhead: "" })],
    ];
    for (const [name, run] of cases) {
      it(name, () => assert.throws(run, /cupertino-lockup:/));
    }
  });
});
