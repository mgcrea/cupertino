import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse, renderHTML } from "./changelog.mjs";

/**
 * The failures these guard against are silent in both directions.
 *
 * Two consumers read this parse — the Sparkle appcast every user sees when they
 * update, and the generated What's New pane inside the app — and a shape neither
 * anticipated does not crash: it drops a bullet from one of them while the other
 * keeps rendering. Nobody notices for a release or two.
 *
 * The fixture is not a tidy example. It is the awkward shapes the real
 * CHANGELOG.md actually contains:
 *
 *   - a `###` group whose prose sits between the heading and the first bullet
 *   - a bullet with NO bold headline at all
 *   - a bold headline with a code span inside it
 *   - a bullet with a second paragraph after a blank line
 *   - a bare number, which the placeholder restoration once ate as an index
 *   - a `## [Unreleased]` heading, which carries no date
 */
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const FIXTURE = `# Changelog

Intro prose that belongs to no release.

<!-- <generated:version> generated from package.json by \`make version\` -->

## [Unreleased]

### Changed

- **Something.** In flight.

## [1.2.0] - 2026-03-04

### Fixed

Not every fix here is a bullet; this line is the group's own lead.

- **A surface that shells out to \`node\` could not find it.** From March 2026
  onward the gateway answers 400 and keeps serving.

  A second paragraph, after a blank line.

- **Plain.** One line only.

### Note for 1.0.0 users

- No headline on this one at all.

## [1.0.0] - 2026-01-31

### Added

- **First.** It shipped.
`;

describe("parse", () => {
  const releases = parse(FIXTURE);

  it("reads every section newest first, and skips the intro and its generated region", () => {
    assert.deepEqual(
      releases.map((r) => r.version),
      ["Unreleased", "1.2.0", "1.0.0"],
    );
    assert.equal(releases[0].unreleased, true);
    assert.equal(releases[0].date, "");
    assert.equal(releases[1].unreleased, false);
    assert.equal(releases[1].date, "2026-03-04");
  });

  it("keeps a group's lead prose", () => {
    const fixed = releases[1].groups[0];
    assert.equal(fixed.name, "Fixed");
    assert.deepEqual(fixed.lead, [
      "Not every fix here is a bullet; this line is the group's own lead.",
    ]);
  });

  it("splits a bold headline off, code span and all", () => {
    const [first] = releases[1].groups[0].entries;
    assert.equal(first.headline, "A surface that shells out to `node` could not find it.");
    assert.deepEqual(first.body, [
      "From March 2026 onward the gateway answers 400 and keeps serving.",
      "A second paragraph, after a blank line.",
    ]);
  });

  it("joins continuation lines with a single space", () => {
    const [first] = releases[1].groups[0].entries;
    assert.equal(
      first.paragraphs[0],
      "**A surface that shells out to `node` could not find it.** From March 2026 onward the gateway answers 400 and keeps serving.",
    );
  });

  it("allows a bullet with no headline, under a freely named section", () => {
    const notes = releases[1].groups[1];
    assert.equal(notes.name, "Note for 1.0.0 users");
    assert.equal(notes.entries[0].headline, null);
    assert.deepEqual(notes.entries[0].body, ["No headline on this one at all."]);
  });
});

describe("renderHTML", () => {
  const [, release] = parse(FIXTURE);
  const html = renderHTML(release);

  it("renders the whole section exactly", () => {
    assert.equal(
      html,
      [
        "<h3>Fixed</h3>",
        "<p>Not every fix here is a bullet; this line is the group's own lead.</p>",
        "<ul>",
        "<li><p><strong>A surface that shells out to <code>node</code> could not find it.</strong> " +
          "From March 2026 onward the gateway answers 400 and keeps serving.</p>" +
          "<p>A second paragraph, after a blank line.</p></li>",
        "<li><p><strong>Plain.</strong> One line only.</p></li>",
        "</ul>",
        "<h3>Note for 1.0.0 users</h3>",
        "<ul>",
        "<li><p>No headline on this one at all.</p></li>",
        "</ul>",
      ].join("\n"),
    );
  });

  it("does not eat a bare number as a code-span placeholder", () => {
    // The placeholder is delimited by private-use characters for exactly this
    // reason. With spaces, "March 2026 onward" rendered as
    // "Marchundefinedonward" — there is no 2026th code span.
    assert.match(html, /March 2026 onward/);
    assert.match(html, /answers 400 and/);
    assert.doesNotMatch(html, /undefined/);
  });
});

describe("the real CHANGELOG.md", () => {
  const releases = parse(readFileSync(join(root, "CHANGELOG.md"), "utf8"));

  it("parses into dated releases with entries", () => {
    assert.ok(releases.length > 5);
    for (const release of releases.filter((r) => !r.unreleased)) {
      assert.match(release.version, /^\d+\.\d+\.\d+$/);
      assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(release.groups.length > 0, `${release.version} has no sections`);
    }
  });

  it("renders every section to HTML with no markdown left over", () => {
    for (const release of releases) {
      const html = renderHTML(release);
      assert.doesNotMatch(html, /\*\*/, `${release.version}: bold markers reached the appcast`);
      assert.doesNotMatch(html, /^- /m, `${release.version}: a literal bullet reached the appcast`);
    }
  });

  it("round-trips every code span, over the whole file", () => {
    // Not `doesNotMatch(/undefined/)`: 1.3.0's prose is ABOUT a field that read
    // back as `undefined`, so the blunt check fails on a correct render. What
    // actually needs asserting is that no placeholder was eaten — every code
    // span in the source has to come out the other side as a <code>.
    for (const release of releases) {
      const sources = [
        ...release.lead,
        ...release.groups.flatMap((group) => [
          group.name,
          ...group.lead,
          ...group.entries.flatMap((entry) => entry.paragraphs),
        ]),
      ];
      const spans = sources.reduce((n, text) => n + (text.match(/`[^`]+`/g) ?? []).length, 0);
      const rendered = (renderHTML(release).match(/<code>/g) ?? []).length;
      assert.equal(rendered, spans, `${release.version}: ${spans - rendered} code span(s) lost`);
    }
  });
});
