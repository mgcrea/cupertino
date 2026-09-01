#!/usr/bin/env node
// Generate every copy of the release version from the root `package.json`.
//
// This is `generate-surfaces.mjs` applied to the other thing the repo had
// copied everywhere. The number lived in eleven places — eight
// `packages/*/package.json` files, `APP_VERSION` in the website config, the tag
// examples in README.md and CHANGELOG.md — and the release commit bumped ten of
// them. The website kept saying 1.2.0 while the app shipped 1.2.2, which is the
// one copy a visitor actually reads.
//
// ## Why the root package.json and not the tag
//
// `apps/website/src/config.ts` used to say the `app-v*` tag was the authority,
// and for what people are RUNNING it still is: CI reads `MARKETING_VERSION` out
// of the tag name (the release-app job in .github/workflows/ci.yml), because
// nothing bumps the pbxproj default. But a tag cannot be the source these files
// generate from — they have to be correct in the commit the tag points AT, and
// the website builds from a shallow clone with no tags at all.
//
// So the root `version` is the source, and the tag is checked against it: the
// release-app job refuses to build when `app-v$X` points at a commit whose root
// package.json does not say `$X`. The tag stays authoritative about what
// shipped; this file makes the repo agree with it before it exists.
//
// The root package is private, so its `version` had no other job. It was 0.0.0.
//
// ## What is deliberately NOT generated
//
// `DemoSeed.swift`'s `version` is pinned by hand and must stay that way — its
// own comment explains why: it is the number the marketing images show, and
// tying it to the release would churn the golden-image gate on every tag and
// claim a version before the store listing showing it had caught up.
//
// Prose about past releases ("shipped alongside Messages in 1.2.0", "1.0.0,
// 1.1.0 and 1.2.0 all shipped seven servers that died") is history, not a copy
// of the current version. It is correct precisely because it does not move.
//
// ## --check
//
// Same contract as the surfaces generator: regenerate into memory, exit
// non-zero on any difference, write nothing. CI runs it on every push, so a
// release commit that forgets a copy is a red build rather than a stale site.
//
//   node scripts/generate-version.mjs            # write
//   node scripts/generate-version.mjs --check    # verify, write nothing

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes("--check");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ─── the source ──────────────────────────────────────────────────────────────

const VERSION = JSON.parse(read("package.json")).version;

/**
 * A bare `MAJOR.MINOR.PATCH`, with the prerelease/build tail semver allows.
 *
 * The same shape the release-app job enforces on the tag, for the same reason:
 * this string becomes `MARKETING_VERSION`, and `CFBundleShortVersionString` is
 * not free-form — a version Apple will not accept fails at notarization, long
 * after the tag is public.
 */
if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$/.test(VERSION ?? "")) {
  console.error(
    `package.json version is not a bare semver version: ${JSON.stringify(VERSION)}\n` +
      `  It becomes MARKETING_VERSION and every published package's version.`,
  );
  process.exit(2);
}

// ─── marked regions ──────────────────────────────────────────────────────────

const BANNER = "generated from package.json by `make version` — do not edit by hand";

/** Byte-identical to the surfaces generator's, and for the same reasons. */
const region = (source, open, close, body, label) => {
  const start = source.indexOf(open);
  const end = source.indexOf(close);
  if (start === -1 || end === -1 || end < start) {
    console.error(`${label}: could not find the generated region (${open.trim()})`);
    process.exit(3);
  }
  return source.slice(0, start + open.length) + body + source.slice(end);
};

const targets = [];
const target = (path, next) => targets.push({ path, next });

// ─── 1..N. The published packages ────────────────────────────────────────────

/**
 * Read from the directory, not from `surfaces.json`.
 *
 * The manifest lists surfaces; `packages/` also holds `core`, which is
 * published on the same lockstep version and is not a surface. Anything else
 * that lands in there is published too, so discovering them is the behaviour
 * that stays right.
 *
 * The edit is textual — a two-space-indented `"version"` line, which at that
 * indent is the top-level field and not one nested in `dependencies` — rather
 * than a parse-and-reserialize. Rewriting the JSON would reflow key order and
 * spacing across eight files on the first run and bury the one line that
 * actually changed.
 */
const publishedPackages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .toSorted();

if (!publishedPackages.length) {
  console.error("packages/ holds no package directories — refusing to run.");
  process.exit(3);
}

for (const name of publishedPackages) {
  const path = `packages/${name}/package.json`;
  target(path, (src) => {
    const pattern = /^  "version": "[^"]*",$/m;
    if (!pattern.test(src)) {
      console.error(`${path}: no top-level "version" line to rewrite`);
      process.exit(3);
    }
    return src.replace(pattern, `  "version": "${VERSION}",`);
  });
}

// ─── The registry's server.json, where there is one ──────────────────────────

/**
 * Each published surface also describes itself to the MCP Registry, and the
 * registry checks the version it is handed against the npm package it names —
 * so a `server.json` left at the previous release does not drift quietly, it
 * fails the publish.
 *
 * That is two more copies per surface, both of which had to say the same thing
 * as the `package.json` beside them: the top-level `version`, and the one
 * inside `packages[0]` naming the npm tarball. Sixteen new places for the
 * number to live is exactly what this file exists to prevent, which is why they
 * are generated rather than bumped by the release commit.
 *
 * Discovered from disk like the packages above, and deliberately not from
 * `surfaces.json`: `core` is published on the same lockstep version but is not
 * a server and has no `server.json`, so presence of the file is the test.
 * Textual for the same reason as above — a reserialize would reflow all eight.
 */
for (const name of publishedPackages) {
  const path = `packages/${name}/server.json`;
  if (!existsSync(join(ROOT, path))) continue;
  target(path, (src) => {
    // Two indents, two meanings: two spaces is the server's own version, six is
    // the npm package's inside `packages[0]`. Anchored so neither can match the
    // other, and both are required — a file carrying only one of them is a
    // `server.json` this generator no longer understands.
    const top = /^  "version": "[^"]*",$/m;
    const pkg = /^      "version": "[^"]*",$/m;
    if (!top.test(src) || !pkg.test(src)) {
      console.error(`${path}: expected both a top-level and a packages[] "version" line`);
      process.exit(3);
    }
    return src
      .replace(top, `  "version": "${VERSION}",`)
      .replace(pkg, `      "version": "${VERSION}",`);
  });
}

// ─── The Safari extension's manifest ─────────────────────────────────────────

/**
 * The WebExtension manifest carries its own `version`, and it drifted to 1.0
 * while the appex around it tracked the app correctly — the bundle version
 * comes from MARKETING_VERSION at build time, so Safari and `pluginkit` always
 * showed the right number and nothing ever surfaced the stale one.
 *
 * It is not cosmetic. `browser.runtime.getManifest().version` is what the
 * extension's own code reads to stamp what it writes, and a version that never
 * moves cannot tell a stale content script from a current one — which is
 * exactly the state an open tab is left in by an update.
 *
 * MV3 constrains this field harder than semver does: one to four dot-separated
 * integers, nothing else. A pre-release like `1.7.0-beta.1` is INVALID and
 * Safari would reject the whole manifest, so the suffix is dropped rather than
 * copied. That loses the distinction between a beta and its release inside the
 * manifest alone; the bundle version beside it keeps the full string.
 */
target("apps/apple/CupertinoSafariExtension/Resources/manifest.json", (src) => {
  const manifestVersion = VERSION.split("-")[0];
  if (!/^\d+(\.\d+){0,3}$/.test(manifestVersion)) {
    console.error(
      `manifest.json: "${manifestVersion}" is not a valid MV3 version (1-4 dot-separated integers)`,
    );
    process.exit(3);
  }
  const pattern = /^  "version": "[^"]*",$/m;
  if (!pattern.test(src)) {
    console.error(
      'apps/apple/CupertinoSafariExtension/Resources/manifest.json: no top-level "version" line to rewrite',
    );
    process.exit(3);
  }
  return src.replace(pattern, `  "version": "${manifestVersion}",`);
});

// ─── The website's APP_VERSION ───────────────────────────────────────────────

target("apps/website/src/config.ts", (src) =>
  region(
    src,
    `// <generated:version> ${BANNER}\n`,
    `// </generated:version>`,
    `export const APP_VERSION = "${VERSION}";\n`,
    "website config.ts",
  ),
);

// ─── The README's tag examples ───────────────────────────────────────────────

/**
 * The open marker carries the blank line after it on purpose.
 *
 * `oxfmt` treats an HTML comment as a block and puts a blank line between it
 * and the paragraph below, so a region opened with a single newline is
 * reformatted the moment anyone runs `pnpm format` — and then `--check` fails
 * on a file nobody edited. The generator writes what the formatter wants.
 *
 * Both regions cover the WHOLE paragraph for a related reason: a comment on its
 * own line in the middle of one ends it, so a marker placed mid-sentence splits
 * the rendered text in two.
 */

target("README.md", (src) =>
  region(
    src,
    `<!-- <generated:version> ${BANNER} -->\n\n`,
    `<!-- </generated:version> -->`,
    `Releases are tagged per package, so a tag names what it publishes: \`mail-v${VERSION}\`,\n` +
      `\`reminders-v${VERSION}\`, \`calendar-v${VERSION}\`, \`core-v${VERSION}\`. The app is tagged ` +
      `\`app-v${VERSION}\` and releases on its own lane —\n` +
      `a signed, notarized \`Cupertino.zip\` attached to the GitHub release, plus its SHA-256. See\n` +
      `[docs/distribution.md](docs/distribution.md).\n`,
    "README.md",
  ),
);

// ─── The CHANGELOG's tag examples ────────────────────────────────────────────

target("CHANGELOG.md", (src) =>
  region(
    src,
    `<!-- <generated:version> ${BANNER} -->\n\n`,
    `<!-- </generated:version> -->`,
    `Releases are tagged per artifact, and a tag names what it publishes: \`mail-v${VERSION}\`,\n` +
      `\`notes-v${VERSION}\`, \`reminders-v${VERSION}\`, \`core-v${VERSION}\` for the npm packages, and ` +
      `\`app-v${VERSION}\` for the\n` +
      `signed macOS app. GitHub release notes are generated from commits; this file is the curated\n` +
      `summary.\n`,
    "CHANGELOG.md",
  ),
);

// ─── run ─────────────────────────────────────────────────────────────────────

let changed = 0;
for (const { path, next } of targets) {
  let before;
  try {
    before = read(path);
  } catch (err) {
    console.error(`missing target: ${path} (${String(err)})`);
    process.exit(3);
  }
  const after = next(before);
  if (before === after) continue;
  changed += 1;
  if (CHECK) {
    console.error(`  drifted: ${path}`);
  } else {
    writeFileSync(join(ROOT, path), after);
    console.log(`  updated: ${path}`);
  }
}

if (CHECK && changed) {
  console.error(
    `\n${changed} file(s) do not match package.json. Run \`make version\` and commit the result.`,
  );
  process.exit(1);
}

/**
 * The CHANGELOG heading is checked, never written.
 *
 * `make release-notes` feeds the Sparkle appcast by slicing `## [$version]` out
 * of this file, and it already fails loudly when the section is missing — but
 * it fails at RELEASE time, with the tag pushed and the build running. The same
 * condition is knowable in the release commit, so it is checked here too.
 *
 * Writing it is not on the table: the section is the curated summary of what
 * changed, and a generated empty heading would satisfy every check while
 * telling every updating user nothing.
 */
const changelog = read("CHANGELOG.md");
const hasSection = new RegExp(`^## \\[${VERSION.replace(/[.+]/g, "\\$&")}\\]`, "m").test(changelog);
if (!hasSection) {
  const what = CHECK ? "" : "\n  Everything else was still written.";
  console.error(
    `CHANGELOG.md has no "## [${VERSION}]" section.\n` +
      `  \`make release-notes\` slices that section into the Sparkle appcast, so app-v${VERSION}\n` +
      `  would ship an update dialog with nothing in it.${what}`,
  );
  process.exit(1);
}

if (CHECK) {
  console.log(`version: ${targets.length} targets match package.json (${VERSION})`);
} else if (changed === 0) {
  console.log(`version: already up to date (${VERSION})`);
} else {
  console.log(`\nversion: ${changed} file(s) updated from package.json (${VERSION}).`);
}
