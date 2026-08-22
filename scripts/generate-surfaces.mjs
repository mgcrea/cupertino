#!/usr/bin/env node
// Generate every copy of the surface list from `surfaces.json`.
//
// docs/surfaces.md set the threshold and the repo crossed it: the list lived in
// ten places, Calendar went in by hand touching all of them, and the note said
// to generate them from one manifest before adding a fifth. This is that script.
//
// ## How it writes
//
// Not whole files. Each target carries a MARKED REGION and only the region is
// replaced, because every one of these files has hand-written prose around the
// list that is worth more than the list is — Surfaces.swift opens with the
// closed-table invariant, tsdown.servers.config.ts explains why it bundles
// differently from the per-package config. Generating those away to save four
// lines of repetition would be a bad trade.
//
// Two targets cannot carry a comment and are handled structurally instead:
// `.mcp.json` is parsed and its `cupertino-*-dev` keys are rewritten (anything
// else in it, like the Stripe entry, is preserved), and `project.pbxproj` has
// its Apple Events usage string replaced by pattern — BOTH copies, Debug and
// Release, because shipping a Release whose consent prompt is wrong is exactly
// the bug this file exists to prevent.
//
// ## --check
//
// The point of the whole exercise. `--check` regenerates into memory and exits
// non-zero if any target differs, so CI fails on drift rather than trusting
// anyone to remember. A generator without it is a convenience; with it, the
// manifest is actually the source of truth.
//
//   node scripts/generate-surfaces.mjs            # write
//   node scripts/generate-surfaces.mjs --check    # verify, write nothing

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK = process.argv.includes("--check");

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ─── the manifest ────────────────────────────────────────────────────────────

const manifest = JSON.parse(read("surfaces.json"));

/**
 * Validate before writing anything.
 *
 * A generator that happily writes a malformed id into ten files at once is worse
 * than ten hand-edits, because the blast radius is the whole repo. The id rule
 * is the strict one: it becomes a directory name, a wire argument, an env prefix
 * and a JSON key.
 */
const validate = (surfaces) => {
  const problems = [];
  const seen = new Set();
  for (const [i, s] of surfaces.entries()) {
    const at = `surfaces[${i}]${s.id ? ` (${s.id})` : ""}`;
    if (!/^[a-z][a-z0-9-]*$/.test(s.id ?? "")) problems.push(`${at}: id must be kebab-case`);
    if (seen.has(s.id)) problems.push(`${at}: duplicate id`);
    seen.add(s.id);
    for (const key of ["displayName", "npmName", "bundleId", "envPrefix"]) {
      if (typeof s[key] !== "string" || !s[key]) problems.push(`${at}: ${key} is required`);
    }
    for (const key of ["usesAppleEvents", "supportsWrites"]) {
      if (typeof s[key] !== "boolean") problems.push(`${at}: ${key} must be a boolean`);
    }
    if (s.storePath !== null && typeof s.storePath !== "string") {
      problems.push(`${at}: storePath must be a string or null`);
    }
    if (!["full-disk-access", "contacts"].includes(s.storePermission)) {
      problems.push(`${at}: storePermission must be "full-disk-access" or "contacts"`);
    }
    if (s.envPrefix !== `APPLE_${s.id?.toUpperCase().replaceAll("-", "_")}_`) {
      problems.push(`${at}: envPrefix must be APPLE_<ID>_ — the servers derive it that way`);
    }
    if (!Array.isArray(s.notes)) problems.push(`${at}: notes must be an array of strings`);
  }
  if (problems.length) {
    console.error("surfaces.json is invalid:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    process.exit(2);
  }
};

const surfaces = manifest.surfaces;
validate(surfaces);

const ids = surfaces.map((s) => s.id);
const scriptable = surfaces.filter((s) => s.usesAppleEvents);

/** "Mail, Notes, Reminders and Calendar" — the form every prose string wants. */
const andList = (names) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// ─── marked regions ──────────────────────────────────────────────────────────

const BANNER = "generated from surfaces.json by `make surfaces` — do not edit by hand";

/**
 * Replace the content between the markers, preserving everything outside them.
 *
 * The markers stay in the file so the boundary is visible to a reader who has
 * never heard of this script, and so a merge conflict lands inside a region
 * rather than silently reordering it.
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

const targets = [];
/**
 * `opts.checked: false` writes the file but never fails `--check`.
 *
 * Only `.mcp.json` uses it, and for a specific reason: it is gitignored. It is a
 * developer's local working config, so CI has no copy to verify and a developer
 * who has customised theirs should not get a red build for it.
 */
const target = (path, next, opts = {}) =>
  targets.push({ path, next, checked: opts.checked !== false, optional: opts.optional === true });

// ─── 1. Surfaces.swift ───────────────────────────────────────────────────────

const swiftString = (v) => JSON.stringify(v);

const swiftSurface = (s) => {
  const lines = [];
  for (const note of s.notes) lines.push(note ? `      // ${note}` : "      //");
  return [
    `    Surface(`,
    `      id: ${swiftString(s.id)},`,
    `      displayName: ${swiftString(s.displayName)},`,
    ...(lines.length ? lines : []),
    `      bundleID: ${swiftString(s.bundleId)},`,
    `      usesAppleEvents: ${s.usesAppleEvents},`,
    `      supportsWrites: ${s.supportsWrites},`,
    `      storePath: ${s.storePath === null ? "nil" : swiftString(s.storePath)},`,
    `      storePermission: .${s.storePermission === "contacts" ? "contacts" : "fullDiskAccess"},`,
    `      envPrefix: ${swiftString(s.envPrefix)}`,
    `    ),`,
  ].join("\n");
};

target("apps/apple/Cupertino/Surfaces.swift", (src) =>
  region(
    src,
    `  // <generated:surfaces> ${BANNER}\n`,
    `  // </generated:surfaces>`,
    `  static let all: [Surface] = [\n${surfaces.map(swiftSurface).join("\n")}\n  ]\n`,
    "Surfaces.swift",
  ),
);

// ─── 2. CupertinoBridge/main.swift ───────────────────────────────────────────

target("apps/apple/CupertinoBridge/main.swift", (src) =>
  region(
    src,
    `// <generated:surfaces> ${BANNER}\n`,
    `// </generated:surfaces>`,
    `let known = [${ids.map(swiftString).join(", ")}]\n`,
    "main.swift",
  ),
);

// ─── 3 & 4. Makefile ─────────────────────────────────────────────────────────

target("Makefile", (src) => {
  let out = region(
    src,
    `# <generated:surfaces> ${BANNER}\n`,
    `# </generated:surfaces>`,
    `SURFACES     := ${ids.join(" ")}\n`,
    "Makefile SURFACES",
  );
  // The screenshot toggles: Mail on, everything else off, and a surface with no
  // write tools is omitted rather than set to NO — a default that gates nothing
  // would imply the toggle exists.
  //
  // One line, and its own variable in the Makefile. A `#` comment cannot sit
  // inside a backslash continuation, so a generated region in the middle of
  // SHOT_ARGS is a `missing separator` error.
  const toggles = surfaces
    .filter((s) => s.supportsWrites)
    .map((s, i) => `-allowWrites.${s.id} ${i === 0 ? "YES" : "NO"}`);
  return region(
    out,
    `# <generated:surfaces-shot> ${BANNER}\n`,
    `# </generated:surfaces-shot>`,
    `SHOT_WRITES  := ${toggles.join(" ")}\n`,
    "Makefile SHOT_ARGS",
  );
});

// ─── 5. CI handshake loop ────────────────────────────────────────────────────

target(".github/workflows/ci.yml", (src) =>
  region(
    src,
    `          # <generated:surfaces> ${BANNER}\n`,
    `          # </generated:surfaces>`,
    `          for server in ${ids.join(" ")}; do\n`,
    "ci.yml",
  ),
);

// ─── 6. Server bundler entries ───────────────────────────────────────────────

target("apps/apple/tsdown.servers.config.ts", (src) =>
  region(
    src,
    `    // <generated:surfaces> ${BANNER}\n`,
    `    // </generated:surfaces>`,
    surfaces
      .map((s) => `    "${s.id}/dist/cli": here("../../packages/${s.id}/src/cli.ts"),\n`)
      .join(""),
    "tsdown.servers.config.ts",
  ),
);

// ─── 7 & 8. The Apple Events usage string, in BOTH build configurations ──────

/**
 * Only the surfaces that actually send an Apple Event are named.
 *
 * A consent prompt that lists an app this code never talks to is asking for a
 * permission it does not need, which is the opposite of what the closed table
 * and the whole one-grant argument are for.
 */
const usageDescription =
  `Cupertino controls ${andList(scriptable.map((s) => s.displayName))} on behalf of the MCP ` +
  `servers it hosts, so the AI assistant you connect can read and act on that data.`;

target("apps/apple/Cupertino.xcodeproj/project.pbxproj", (src) => {
  const pattern = /INFOPLIST_KEY_NSAppleEventsUsageDescription = "[^"]*";/g;
  const found = src.match(pattern) ?? [];
  if (found.length !== 2) {
    console.error(
      `project.pbxproj: expected 2 copies of the usage description (Debug and Release), found ${found.length}. ` +
        `Shipping a Release whose consent prompt is wrong is exactly what this check exists to catch.`,
    );
    process.exit(3);
  }
  return src.replaceAll(
    pattern,
    `INFOPLIST_KEY_NSAppleEventsUsageDescription = "${usageDescription}";`,
  );
});

// ─── 9. wiring-check.swift ───────────────────────────────────────────────────

target("scripts/wiring-check.swift", (src) => {
  const rows = surfaces.map(
    (s) => `    (id: ${swiftString(s.id)}, label: ${swiftString(s.displayName)}),`,
  );
  return region(
    src,
    `  // <generated:surfaces> ${BANNER}\n`,
    `  // </generated:surfaces>`,
    `  static let surfaces = [\n${rows.join("\n")}\n  ]\n`,
    "wiring-check.swift",
  );
});

// ─── 10. The website's id union ──────────────────────────────────────────────

/**
 * Only the TYPE, not the entries.
 *
 * The tool names in `surfaces.ts` are transcribed from `packages/<id>/src/tools/`
 * and checked against the tree, because a wrong name there is a claim the
 * servers do not honour — that file's own header says so. The manifest does not
 * know them and should not pretend to. What it does know is which surfaces
 * exist, so generating the union makes a missing entry a type error at build
 * time instead of a card nobody notices is absent.
 */
target("apps/website/src/data/surfaces.ts", (src) =>
  region(
    src,
    `  // <generated:surfaces> ${BANNER}\n`,
    `  // </generated:surfaces>`,
    `  id: ${ids.map(swiftString).join(" | ")};\n`,
    "website surfaces.ts",
  ),
);

// ─── 11. .mcp.json ───────────────────────────────────────────────────────────

/**
 * Structural rather than textual: JSON has no comments to mark a region with.
 *
 * Only `cupertino-*-dev` keys are touched. Anything else in the file — the
 * Stripe server, whatever someone adds tomorrow — is preserved exactly, because
 * this is a developer's working config and not a generated artifact.
 */
target(
  ".mcp.json",
  (src) => {
    const doc = JSON.parse(src);
    const servers = doc.mcpServers ?? {};
    const bridge =
      Object.values(servers).find(
        (v) => typeof v?.command === "string" && v.command.includes("cupertino-bridge"),
      )?.command ??
      join(
        ROOT,
        "apps/apple/.build/Build/Products/Debug/Cupertino.app/Contents/Helpers/cupertino-bridge",
      );
    const rest = Object.fromEntries(
      Object.entries(servers).filter(([k]) => !/^cupertino-.*-dev$/.test(k)),
    );
    const generated = Object.fromEntries(
      ids.map((id) => [`cupertino-${id}-dev`, { command: bridge, args: [`--server=${id}`] }]),
    );
    doc.mcpServers = { ...generated, ...rest };
    return `${JSON.stringify(doc, null, 2)}\n`;
  },
  { checked: false, optional: true },
);

// ─── run ─────────────────────────────────────────────────────────────────────

let drifted = 0;
let checkedCount = 0;
for (const { path, next, checked, optional } of targets) {
  let before;
  try {
    before = read(path);
  } catch (err) {
    if (optional) continue;
    console.error(`missing target: ${path} (${String(err)})`);
    process.exit(3);
  }
  if (checked) checkedCount += 1;
  const after = next(before);
  if (before === after) continue;
  if (CHECK) {
    if (!checked) continue;
    drifted += 1;
    console.error(`  drifted: ${path}`);
  } else {
    writeFileSync(join(ROOT, path), after);
    console.log(`  updated: ${path}`);
  }
}

if (CHECK) {
  if (drifted) {
    console.error(
      `\n${drifted} file(s) do not match surfaces.json. Run \`make surfaces\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`surfaces: ${checkedCount} targets match surfaces.json (${ids.length} surfaces)`);
} else if (drifted === 0) {
  console.log(`surfaces: already up to date (${ids.length} surfaces)`);
} else {
  console.log(`\nsurfaces: ${drifted} file(s) updated from surfaces.json.`);
}
