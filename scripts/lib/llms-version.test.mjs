import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { stampLlmsVersion } from "./llms-version.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The sentence as llms.txt has carried it, wrapped where the file wraps it. */
const LLMS = `Unofficial. Not affiliated with Apple. macOS 26 or later, and macOS only. Shipped at 1.0.0, and at
1.26.0 as of October 2026: the signed app ships from GitHub releases. The \`@mgcrea/mcp-apple-*\`
packages are MIT and on npm.
`;

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.27.0] - 2026-11-02

**Something.** Shipped.

## [1.26.0] - 2026-10-06
`;

describe("stampLlmsVersion", () => {
  // Every minor release used to need a hand edit here, and the test that asked
  // for it went red in CI first (8802834 is one of those follow-ups).
  it("names the release package.json names, dated by its CHANGELOG heading", () => {
    const out = stampLlmsVersion(LLMS, "1.27.0", CHANGELOG);
    assert.match(out, /Shipped at 1\.0\.0, and at\n1\.27\.0 as of November 2026: the signed app/);
    assert.equal(out.replace("1.27.0 as of November", "1.26.0 as of October"), LLMS);
  });

  it("changes nothing when the file already says so", () => {
    assert.equal(stampLlmsVersion(LLMS, "1.26.0", CHANGELOG), LLMS);
  });

  it("refuses a file that no longer carries the sentence", () => {
    assert.throws(
      () => stampLlmsVersion("Shipped a while ago.\n", "1.27.0", CHANGELOG),
      /llms\.txt/,
    );
  });

  // A release with no section yet is reported by generate-version's own
  // CHANGELOG check, with the reason; this leaves the file alone for it.
  it("leaves the file alone while the release has no CHANGELOG section", () => {
    assert.equal(stampLlmsVersion(LLMS, "1.28.0", CHANGELOG), LLMS);
  });

  it("refuses a section with no date to give", () => {
    assert.throws(() => stampLlmsVersion(LLMS, "1.27.0", "## [1.27.0]\n"), /no date/);
  });

  it("matches the llms.txt the site serves", () => {
    const real = readFileSync(join(root, "apps", "website", "public", "llms.txt"), "utf8");
    assert.doesNotThrow(() => stampLlmsVersion(real, "9.9.9", "## [9.9.9] - 2030-01-15\n"));
    assert.match(
      stampLlmsVersion(real, "9.9.9", "## [9.9.9] - 2030-01-15\n"),
      /\b9\.9\.9 as of January 2030\b/,
    );
  });
});
