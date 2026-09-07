#!/usr/bin/env node
// One CHANGELOG section, as HTML for the Sparkle appcast.
//
// Sparkle renders an item's `<description>` as HTML in a WKWebView, and `make
// appcast` used to slice the raw markdown straight into the CDATA. Every user's
// update dialog therefore showed literal `###` headings, `- ` bullets and `**`
// around the lead of each entry — the release notes somebody reads before
// agreeing to replace an app that holds Full Disk Access, rendered as source.
//
// ## Why a renderer here rather than a dependency
//
// The release path must not gain one for this. `make appcast` runs in CI
// between notarization and the upload, on a checkout whose node_modules exist
// for the packages rather than for the Makefile, and a markdown library is a
// supply-chain edge on the one target that signs a release. What the CHANGELOG
// actually uses is small and stable: `###` headings, bullets with continuation
// paragraphs, bold, italic, code spans and links. Anything richer — nested
// bullets, fenced code, tables — renders as its own source rather than
// wrongly, which is the failure this replaces and is why the omission is
// tolerable.
//
// The parse and the renderer now live in `lib/changelog.mjs`, shared with the
// generator behind the app's What's New pane so that the two cannot disagree
// about what a bullet is. What stays here is what is true of this caller and
// not of markdown: which section to take, the guards below, and escaping `]]>`.
//
// ## Why the version is an argument
//
// The Makefile matched `## [$version]` rather than taking the top section, and
// failed the build when nothing matched, on the reasoning that a heading typo —
// `## [1.1]` against `## [1.1.0]` — would otherwise ship an update dialog with
// nothing in it. That guard moved in here with the slicing it guards, so the
// two cannot drift apart: this exits non-zero rather than printing an empty
// description, and `make appcast` has no fallback that would paper over it.
//
//   node scripts/changelog-notes.mjs <version> [CHANGELOG.md]
import { readFileSync } from "node:fs";

import { parse, renderHTML } from "./lib/changelog.mjs";

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
  console.error("usage: changelog-notes.mjs <version> [CHANGELOG.md]");
  process.exit(2);
}

// Matched on the bracketed version alone so the ` - <date>` that follows it does
// not have to be known.
const release = parse(readFileSync(file, "utf8")).find((r) => r.version === version);
if (!release) {
  console.error(`no ${file} section '## [${version}]' — the update dialog would show nothing`);
  process.exit(1);
}

// A section that matched its heading but holds nothing renderable is the same
// empty dialog the heading guard exists to stop, reached a different way.
const out = renderHTML(release);
if (!/\S/.test(out)) {
  console.error(
    `${file} section '## [${version}]' is empty — the update dialog would show nothing`,
  );
  process.exit(1);
}

// A `]]>` in the notes would end the CDATA section the Makefile wraps this in.
process.stdout.write(`${out.replaceAll("]]>", "]]]]><![CDATA[>")}\n`);
