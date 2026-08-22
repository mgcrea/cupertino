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

import { composeLockup, LOCKUP } from "./lockup.mjs";

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
