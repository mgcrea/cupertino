#!/usr/bin/env node
// Generate the app's What's New pane from `CHANGELOG.md`.
//
// The same pattern as `generate-surfaces.mjs`, for the same reason: the release
// notes users read inside the app have to be the release notes the repository
// wrote, and the only way to guarantee that is to have one of them come out of
// the other with a `--check` gate behind it.
//
// The parse is shared with `changelog-notes.mjs`, which renders the top section
// as HTML for the Sparkle appcast. One file, one parser — see the header of
// `lib/changelog.mjs` for why that matters more than it looks.
//
// ## What is dropped, and where
//
// Two things, both here rather than in SwiftUI, so that the bytes never reach
// the binary and the decision is visible where the data is discarded:
//
//   - `### Internal` sections. Repo-facing prose about CI and generators; a user
//     asking what changed in the app gets nothing from it.
//   - Everything past the most recent `SHOWN` releases. This is the pane you
//     open after updating, not an archive.
//
// `## [Unreleased]` is kept, but emitted separately as `Changelog.unreleased`
// and shown only in debug builds. A generator that silently discarded it would
// be one whose --check could not tell you what went missing, and it genuinely
// describes what a `make run` build contains. The debug gate is doing real work
// rather than belt-and-braces: CI's release job asserts only that a
// `## [<version>]` section EXISTS (ci.yml), not that it is the top one, so an
// `[Unreleased]` left in place above it would otherwise ship.
//
//   node scripts/generate-changelog.mjs            # write
//   node scripts/generate-changelog.mjs --check    # verify, write nothing
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "./lib/changelog.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes("--check");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/** How many released versions reach the app. Raising it is this line. */
const SHOWN = 5;

/** Sections that exist for the repository rather than for the user. */
const HIDDEN_SECTIONS = new Set(["Internal"]);

const BANNER = "generated from CHANGELOG.md by `make changelog` — do not edit by hand";

/**
 * Replace a marked region, leaving the prose around it alone.
 *
 * Twelve lines copied from `generate-surfaces.mjs` rather than imported from it:
 * that module validates `surfaces.json` at import time and exits the process on
 * a bad manifest, which is not a thing an unrelated generator should inherit.
 * If a third generator ever wants this, it moves to `lib/`.
 */
const region = (source, open, close, body, label) => {
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    console.error(`${label}: could not find the generated region (${open.trim()})`);
    process.exit(3);
  }
  return source.slice(0, start + open.length) + body + source.slice(end);
};

// ─── the parse ───────────────────────────────────────────────────────────────

const all = parse(read("CHANGELOG.md"));

const visible = (release) => ({
  ...release,
  sections: release.groups
    .filter((group) => !HIDDEN_SECTIONS.has(group.name))
    .filter((group) => group.lead.length > 0 || group.entries.length > 0),
});

const unreleased = all.find((r) => r.unreleased);
const released = all.filter((r) => !r.unreleased);

if (released.length === 0) {
  console.error("CHANGELOG.md: no released sections found — expected `## [1.2.3] - YYYY-MM-DD`");
  process.exit(2);
}
for (const release of released) {
  if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^\d{4}-\d{2}-\d{2}$/.test(release.date)) {
    console.error(
      `CHANGELOG.md: \`## [${release.version}] - ${release.date}\` is not a release heading`,
    );
    process.exit(2);
  }
}

const shown = released.slice(0, SHOWN).map(visible);

// ─── Swift ───────────────────────────────────────────────────────────────────
//
// Every generated declaration carries `// swift-format-ignore`, and that is
// load-bearing rather than tidy. `make format` and `make changelog-check` must
// never be able to fight over this file: without the directive the formatter
// rewraps long string arguments and restyles trailing commas, which turns the
// drift gate red on a file nobody edited, and `make changelog` then puts it
// straight back. The directive also silences `AlwaysUseLowerCamelCase` on the
// `v1_13_0` names, which read as versions precisely because they are not
// camelCase. The prose and the types above the region stay formatted and linted
// exactly like the rest of the app — only the generated text is exempt.

// JSON and Swift agree on `\"`, `\\`, `\n` and `\uXXXX`, which is what the
// catalog generator relies on too. Non-ASCII (em dashes, «», typographic
// quotes) is emitted literally as UTF-8.
const swiftString = (v) => JSON.stringify(v);

const swiftStrings = (xs, indent) =>
  xs.length === 0
    ? "[]"
    : `[\n${xs.map((x) => `${indent}  ${swiftString(x)},`).join("\n")}\n${indent}]`;

const swiftEntry = (entry, ordinal) =>
  [
    `          Entry(`,
    `            ordinal: ${ordinal},`,
    `            headline: ${entry.headline === null ? "nil" : swiftString(entry.headline)},`,
    `            body: ${swiftStrings(entry.body, "            ")}),`,
  ].join("\n");

const swiftSection = (section, nextOrdinal) =>
  [
    `      Section(`,
    `        name: ${swiftString(section.name)},`,
    `        lead: ${swiftStrings(section.lead, "        ")},`,
    section.entries.length === 0
      ? `        entries: []),`
      : `        entries: [\n${section.entries.map((e) => swiftEntry(e, nextOrdinal())).join("\n")}\n        ]),`,
  ].join("\n");

/** A `let` per release, each with an explicit type annotation. */
const swiftRelease = (name, release) => {
  // Numbered across the whole release, not per section.
  //
  // `Entry.id` is this number, and SwiftUI flattens the section/entry ForEach
  // pair in a Form — so per-section ordinals collide the moment a release has
  // two sections, and the pane renders the first section's bullet again in
  // place of the second's. That is what shipped for exactly one build.
  let counter = 0;
  const nextOrdinal = () => counter++;
  return [
    `  // swift-format-ignore`,
    `  private static let ${name}: Release = Release(`,
    `    version: ${swiftString(release.version)},`,
    `    date: ${swiftString(release.date)},`,
    release.sections.length === 0
      ? `    sections: [])`
      : `    sections: [\n${release.sections.map((s) => swiftSection(s, nextOrdinal)).join("\n")}\n    ])`,
  ].join("\n");
};

/**
 * The name of a release's `let`. `v1_13_0`, so the generated file reads as a
 * list of versions rather than a list of indices.
 */
const letName = (version) => `v${version.replaceAll(".", "_")}`;

const body = [
  "",
  `  /// The most recent ${shown.length} releases, newest first.`,
  "  ///",
  "  /// Split into one `let` per release rather than a single nested literal.",
  "  /// Swift's expression type-checker is superlinear in the depth of an array",
  "  /// literal, and this one is releases of sections of entries of strings — the",
  "  /// exact shape that turns into a multi-second type-check with no diagnostic.",
  "  // swift-format-ignore",
  `  static let releases: [Release] = [${shown.map((r) => letName(r.version)).join(", ")}]`,
  "",
  ...shown.map((release) => `${swiftRelease(letName(release.version), release)}\n`),
  "  /// Work that is written down but not shipped.",
  "  ///",
  "  /// `nil` in any tagged build: CI asserts the CHANGELOG's head section is the",
  "  /// tag's version, so there is no `[Unreleased]` left to emit by then. The",
  "  /// pane shows it in debug builds only, where it is true of what is running.",
  unreleased && visible(unreleased).sections.length > 0
    ? `${swiftRelease("unreleasedRelease", { ...visible(unreleased), version: "Unreleased", date: "" })}\n\n  // swift-format-ignore\n  static let unreleased: Release? = unreleasedRelease`
    : "  static let unreleased: Release? = nil",
  "",
].join("\n");

const targets = [
  {
    path: "apps/apple/Cupertino/Changelog.swift",
    next: (src) =>
      region(
        src,
        `  // <generated:changelog> ${BANNER}\n`,
        `  // </generated:changelog>`,
        body,
        "Changelog.swift",
      ),
  },
];

// ─── write or check ──────────────────────────────────────────────────────────

let drifted = 0;
for (const { path, next } of targets) {
  const before = read(path);
  const after = next(before);
  if (before === after) continue;
  if (CHECK) {
    console.error(`drift: ${path}`);
    drifted += 1;
  } else {
    writeFileSync(join(ROOT, path), after);
    console.log(`updated ${path}`);
  }
}

if (CHECK) {
  if (drifted) {
    console.error(
      `\n${drifted} file(s) out of date — run \`make changelog\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`CHANGELOG.md: ${shown.length} of ${released.length} releases up to date`);
}
