#!/usr/bin/env node
// One CHANGELOG section, as HTML for the Sparkle appcast.
//
// Sparkle renders an item's `<description>` as HTML in a WKWebView, and `make
// appcast` used to slice the raw markdown straight into the CDATA. Every user's
// update dialog therefore showed literal `###` headings, `- ` bullets and `**`
// around the lead of each entry — the release notes somebody reads before
// agreeing to replace an app that holds Full Disk Access, rendered as source.
// Bastion hit this first and fixed it the same way; this is that renderer,
// ported.
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

const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
if (!version) {
  console.error("usage: changelog-notes.mjs <version> [CHANGELOG.md]");
  process.exit(2);
}

const lines = readFileSync(file, "utf8").split("\n");

// The `## [<version>]` section, heading excluded. Matched on the bracketed
// version alone so the ` - <date>` that follows it does not have to be known.
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`no ${file} section '## [${version}]' — the update dialog would show nothing`);
  process.exit(1);
}
let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
if (end < 0) end = lines.length;
const section = lines.slice(start + 1, end);

const escape = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Inline markdown. Code spans are lifted out first so nothing inside is touched.
 *
 * The placeholder wraps the index in private-use characters. Bastion's renderer
 * wrapped it in spaces and restored it with `/ (\d+) /`, which also matches any
 * bare number in ordinary prose: "from March 2026 onward" came back as "from
 * Marchundefinedonward", because there is no 2026th code span. This CHANGELOG is
 * full of years and counts, so that is not a corner. U+E000 and U+E001 cannot
 * appear in the source — it is prose, not a font — and no rule below matches
 * one. Private-use rather than NUL so the restore pattern is not a
 * control-character regex, which oxlint rejects.
 */
const inline = (text) => {
  const codes = [];
  let out = escape(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\uE000${codes.length - 1}\uE001`;
  });
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s.,;:)]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out.replace(/\uE000(\d+)\uE001/g, (_, index) => codes[Number(index)]);
};

const html = [];
let bullet = null; // the paragraphs of the bullet being collected
let paragraph = [];
let inList = false;

const flushParagraph = () => {
  if (paragraph.length) {
    bullet.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }
};
const flushBullet = () => {
  if (bullet) {
    flushParagraph();
    html.push(`<li>${bullet.join("")}</li>`);
    bullet = null;
  }
};
const closeList = () => {
  flushBullet();
  if (inList) {
    html.push("</ul>");
    inList = false;
  }
};

for (const raw of section) {
  const line = raw.trimEnd();
  if (line.startsWith("### ")) {
    closeList();
    html.push(`<h3>${inline(line.slice(4))}</h3>`);
  } else if (line.startsWith("- ")) {
    flushBullet();
    if (!inList) {
      html.push("<ul>");
      inList = true;
    }
    bullet = [];
    paragraph = [line.slice(2)];
  } else if (line === "") {
    if (bullet) flushParagraph();
  } else if (bullet) {
    paragraph.push(line.trim());
  } else {
    html.push(`<p>${inline(line.trim())}</p>`);
  }
}
closeList();

// A section that matched its heading but holds nothing renderable is the same
// empty dialog the heading guard exists to stop, reached a different way.
const out = html.join("\n");
if (!/\S/.test(out)) {
  console.error(
    `${file} section '## [${version}]' is empty — the update dialog would show nothing`,
  );
  process.exit(1);
}

// A `]]>` in the notes would end the CDATA section the Makefile wraps this in.
process.stdout.write(`${out.replaceAll("]]>", "]]]]><![CDATA[>")}\n`);
