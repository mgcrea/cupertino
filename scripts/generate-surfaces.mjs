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
    for (const key of ["displayName", "envPrefix"]) {
      if (typeof s[key] !== "string" || !s[key]) problems.push(`${at}: ${key} is required`);
    }
    for (const key of ["usesAppleEvents", "supportsWrites", "defaultEnabled"]) {
      if (typeof s[key] !== "boolean") problems.push(`${at}: ${key} must be a boolean`);
    }
    // Spelled out on every surface rather than defaulted to `true` when absent.
    // A missing key here would read as "on for everyone" — the one answer that
    // must never be given by omission, since it is what lands the surface in
    // somebody's client config on their next Update click.
    // WHEN the events go out, not whether they may. Messages and Contacts read
    // through the file lane and script the app only to write, so on a Mac with
    // writes off they send nothing at all — and the status glyph used to nag
    // for an Automation grant that nothing would ever spend.
    //
    // This narrows what the APP ASKS FOR, never what it MAY ask for. The
    // consent string in project.pbxproj is built from `scriptable` below, which
    // reads `usesAppleEvents` and must keep naming both surfaces: turning
    // writes on has to work without a re-signed binary.
    if (s.usesAppleEvents) {
      if (!["always", "writes"].includes(s.appleEventsScope)) {
        problems.push(`${at}: appleEventsScope must be "always" or "writes"`);
      }
    } else if (s.appleEventsScope !== null) {
      problems.push(`${at}: appleEventsScope must be null — this surface sends no Apple Event`);
    }
    // Which process serves it. Explicit rather than inferred from a missing
    // npmName, so the targets that mean "has a node package" can say so.
    if (!["node", "swift"].includes(s.runtime)) {
      problems.push(`${at}: runtime must be "node" or "swift"`);
    }
    // A swift-hosted surface has no npm package and could not have one — the
    // grant it needs lives in the app, so a published package would be an
    // empty-handed claim. Tie the two together rather than letting them drift.
    if (s.runtime === "swift") {
      if (s.npmName !== null) problems.push(`${at}: a swift surface must have npmName: null`);
    } else if (typeof s.npmName !== "string" || !s.npmName) {
      problems.push(`${at}: npmName is required for a node surface`);
    }
    // An APP brokers one Apple application; a CAPABILITY brokers something the
    // system provides and no app owns. Declared rather than inferred from a
    // missing bundleId: the two happen to coincide today, and the next
    // capability should not have to be recognised by what it lacks.
    if (!["app", "capability"].includes(s.kind)) {
      problems.push(`${at}: kind must be "app" or "capability"`);
    }
    if (s.kind === "app") {
      if (typeof s.bundleId !== "string" || !s.bundleId) {
        problems.push(`${at}: an app surface needs a bundleId`);
      }
      // Its icon comes from LaunchServices. Naming one here as well would be
      // two sources for one picture, and they would disagree eventually.
      if (s.symbol != null || s.iconPath != null) {
        problems.push(
          `${at}: an app surface takes its own icon — symbol and iconPath must be null`,
        );
      }
    } else if (s.kind === "capability") {
      if (s.bundleId !== null)
        problems.push(`${at}: a capability surface must have bundleId: null`);
      if (s.usesAppleEvents) {
        problems.push(`${at}: a capability has no app to send an Apple Event to`);
      }
      // `symbol` is REQUIRED even though `iconPath` is preferred, because
      // iconPath points into /System and Apple renames those: DisplaysExt.appex
      // beside Sound.appex, in the same directory, is the evidence. A missing
      // path must degrade to a chosen symbol rather than to `app.dashed`, which
      // says "this app is not installed" about something that was never an app.
      if (typeof s.symbol !== "string" || !s.symbol) {
        problems.push(
          `${at}: a capability needs a symbol (an SF Symbol name) as its icon fallback`,
        );
      }
      if (s.iconPath !== null && typeof s.iconPath !== "string") {
        problems.push(`${at}: iconPath must be a string or null`);
      }
    }
    if (s.storePath !== null && typeof s.storePath !== "string") {
      problems.push(`${at}: storePath must be a string or null`);
    }
    if (
      !["full-disk-access", "contacts", "screen-recording", "microphone", "accessibility"].includes(
        s.storePermission,
      )
    ) {
      problems.push(
        `${at}: storePermission must be "full-disk-access", "contacts", "screen-recording", ` +
          `"microphone" or "accessibility"`,
      );
    }
    if (s.envPrefix !== `APPLE_${s.id?.toUpperCase().replaceAll("-", "_")}_`) {
      problems.push(`${at}: envPrefix must be APPLE_<ID>_ — the servers derive it that way`);
    }
    if (!Array.isArray(s.notes)) problems.push(`${at}: notes must be an array of strings`);
    // `gates` is optional. A surface with an extra opt-in read declares it here
    // so the toggle, the env var and the capability cache key all come from one
    // place — hardcoding one flag in Swift is the ten-copies problem this
    // manifest exists to end, and it starts with exactly one.
    if (s.gates !== undefined) {
      if (!Array.isArray(s.gates)) {
        problems.push(`${at}: gates must be an array`);
      } else {
        for (const [j, g] of s.gates.entries()) {
          const gat = `${at}.gates[${j}]`;
          if (!/^[a-z][a-zA-Z0-9]*$/.test(g?.id ?? "")) {
            problems.push(`${gat}: id must be lowerCamelCase — it becomes a UserDefaults key`);
          }
          if (!/^[A-Z][A-Z0-9_]*$/.test(g?.envSuffix ?? "")) {
            problems.push(`${gat}: envSuffix must be SCREAMING_SNAKE_CASE`);
          }
          if (g?.envSuffix === "ALLOW_WRITES") {
            problems.push(`${gat}: ALLOW_WRITES is the write gate, not an extra gate`);
          }
          for (const key of ["label", "description"]) {
            if (typeof g?.[key] !== "string" || !g[key])
              problems.push(`${gat}: ${key} is required`);
          }
        }
      }
    }
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
/**
 * The surfaces that are a node package under `packages/<id>`.
 *
 * Not every target that loops over surfaces means this one. The bridge, the
 * closed table, the settings UI and the dev config take EVERY surface, because
 * a swift-hosted surface is reached exactly like the others — the bridge never
 * parses JSON-RPC and cannot tell them apart. What must not include it is
 * anything that reads `packages/<id>`: the bundler's entry map, the CI
 * handshake that runs `node packages/$s/dist/cli.js`, and `make servers`.
 */
const nodeIds = surfaces.filter((s) => s.runtime === "node").map((s) => s.id);
/**
 * The surfaces the app serves itself.
 *
 * `verify-servers.sh` cannot cover these — there is no cli.js to scan and no
 * child runtime to spawn — so the only thing that proves one actually speaks
 * MCP is a handshake through the bridge. `make smoke-swift` is that check, and
 * it needs its own list because the full `make smoke` also spawns the node
 * servers, which need a bundle or a dev config to exist.
 */
const swiftIds = surfaces.filter((s) => s.runtime !== "node").map((s) => s.id);

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

/** Manifest spelling to Swift case. A lookup, so an unmapped value is a crash
 * here rather than a silent fall-through to Full Disk Access. */
const STORE_PERMISSION = {
  "full-disk-access": "fullDiskAccess",
  contacts: "contacts",
  "screen-recording": "screenRecording",
  accessibility: "accessibility",
  microphone: "microphone",
};

const swiftGate = (g) =>
  `        Surface.Gate(id: ${swiftString(g.id)}, envSuffix: ${swiftString(g.envSuffix)}, ` +
  `label: ${swiftString(g.label)}, description: ${swiftString(g.description)}),`;

const swiftSurface = (s) => {
  const lines = [];
  for (const note of s.notes) lines.push(note ? `      // ${note}` : "      //");
  const gates = s.gates ?? [];
  return [
    `    Surface(`,
    `      id: ${swiftString(s.id)},`,
    `      displayName: ${swiftString(s.displayName)},`,
    ...(lines.length ? lines : []),
    `      bundleID: ${s.bundleId === null ? "nil" : swiftString(s.bundleId)},`,
    `      kind: .${s.kind},`,
    `      iconPath: ${s.iconPath == null ? "nil" : swiftString(s.iconPath)},`,
    `      symbol: ${s.symbol == null ? "nil" : swiftString(s.symbol)},`,
    `      usesAppleEvents: ${s.usesAppleEvents},`,
    `      appleEventsScope: ${s.appleEventsScope === null ? "nil" : `.${s.appleEventsScope}`},`,
    `      supportsWrites: ${s.supportsWrites},`,
    `      defaultEnabled: ${s.defaultEnabled},`,
    `      storePath: ${s.storePath === null ? "nil" : swiftString(s.storePath)},`,
    `      storePermission: .${STORE_PERMISSION[s.storePermission]},`,
    `      envPrefix: ${swiftString(s.envPrefix)},`,
    `      runtime: .${s.runtime},`,
    ...(gates.length === 0
      ? [`      gates: []`]
      : [`      gates: [`, ...gates.map(swiftGate), `      ]`]),
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
    `SURFACES     := ${ids.join(" ")}\nNODE_SURFACES := ${nodeIds.join(" ")}\nSWIFT_SURFACES := ${swiftIds.join(" ")}\n`,
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
  // Every surface on except one, so the captures show what a switched-off
  // surface actually looks like rather than only ever the happy row.
  //
  // Pinned by NAME rather than by position, and the name is load-bearing. Maps
  // must stay on: it is the only surface with `usesAppleEvents: false`, and the
  // settings plate's caption sells exactly that row. Safari is the one surface
  // that appears in no other fixture — not the log lines, not the sessions — so
  // switching it off contradicts nothing else on screen, which is the rule the
  // whole demo seed is built on: a fact the screen shows must be fixed, never
  // merely plausible.
  const SHOT_OFF = "safari";
  if (!surfaces.some((s) => s.id === SHOT_OFF)) {
    throw new Error(`SHOT_ENABLED pins '${SHOT_OFF}' off, and no such surface is in surfaces.json`);
  }
  const enabled = surfaces.map(
    (s) => `-surfaceEnabled.${s.id} ${s.id === SHOT_OFF ? "NO" : "YES"}`,
  );
  return region(
    out,
    `# <generated:surfaces-shot> ${BANNER}\n`,
    `# </generated:surfaces-shot>`,
    `SHOT_WRITES  := ${toggles.join(" ")}\nSHOT_ENABLED := ${enabled.join(" ")}\n`,
    "Makefile SHOT_ARGS",
  );
});

// ─── 5. CI handshake loop ────────────────────────────────────────────────────

target(".github/workflows/ci.yml", (src) =>
  region(
    src,
    `          # <generated:surfaces> ${BANNER}\n`,
    `          # </generated:surfaces>`,
    `          for server in ${nodeIds.join(" ")}; do\n`,
    "ci.yml",
  ),
);

// ─── 6. Server bundler entries ───────────────────────────────────────────────

target("apps/apple/tsdown.servers.config.ts", (src) =>
  region(
    src,
    `    // <generated:surfaces> ${BANNER}\n`,
    `    // </generated:surfaces>`,
    nodeIds
      .map((id) => `    "${id}/dist/cli": here("../../packages/${id}/src/cli.ts"),\n`)
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
    // One member per line, ALWAYS, even when the union would fit on one.
    //
    // The formatter owns this file too, and at eight surfaces the single-line
    // form fitted inside the print width while at nine it did not — so the
    // generator and oxfmt disagreed the moment `screen` landed, and
    // `make surfaces-check` went red on a file nobody had edited. MEASURED:
    // oxfmt does not collapse a multi-line union back onto one line even when
    // it would fit, so this shape is stable at any length and the two agree by
    // construction rather than by counting characters.
    `  id:\n${ids.map((id) => `    | ${swiftString(id)}`).join("\n")};\n`,
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
