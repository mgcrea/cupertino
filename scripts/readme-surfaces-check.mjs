#!/usr/bin/env node
// Fail if README.md's Surfaces table has drifted from the tree.
//
// ## Why this exists
//
// `generate-surfaces.mjs` owns ten copies of the surface list and checks them
// all, but README.md is not one of them and cannot easily become one: its third
// column is hand-written prose ("search/read/attachments + gated writes") that
// no manifest knows and none should pretend to. So the README is the one place
// the list is maintained by hand — and it drifted, three rows at a time.
//
// The state this script was written to end, on 2026-09-01:
//
//   - Notes said 12 tools and registered 13; Messages said 7 and registered 8.
//   - Safari said "6 tools, read-only" and registered 14, five of them behind
//     the write gate. `read-only` is a SAFETY claim, and it was false.
//   - `screen` had shipped that morning and had no row at all.
//
// The website's `src/data/surfaces.ts` already carries the tool names and its
// header says to check the tree and not the README, "which has drifted before".
// This makes that a build failure rather than a warning in a comment.
//
// ## What it checks
//
// Counts, not prose. The number in each row against the registrations in the
// tree, every manifest surface having a row, and — the one that matters — that
// no surface which `surfaces.json` says supports writes is described as
// read-only.
//
//   node scripts/readme-surfaces-check.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const manifest = JSON.parse(read("surfaces.json"));

/**
 * How many tools a surface actually registers.
 *
 * Node surfaces are counted by `server.registerTool(` under `src/`, which is
 * exact because the packages keep their tests in `test/` — nothing under `src`
 * registers a tool it does not ship. The swift surface is served in-process and
 * declares its tools as JSON literals instead, so it is counted by the `"name":`
 * key; `Surfaces.swift` also mentions a tool name inside a gate description,
 * and that shape does not match.
 */
const registeredTools = (s) => {
  if (s.runtime === "node") {
    const dir = join(ROOT, "packages", s.id, "src");
    if (!existsSync(dir)) return null;
    let n = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) {
          n += (readFileSync(join(d, e.name), "utf8").match(/server\.registerTool\(/g) ?? [])
            .length;
        }
      }
    };
    walk(dir);
    return n;
  }
  if (s.runtime === "swift") {
    const dir = join(ROOT, "apps", "apple", "Cupertino");
    if (!existsSync(dir)) return null;
    const pattern = new RegExp(`"name":\\s*"apple_${s.id}_[a-z_]+"`, "g");
    let n = 0;
    for (const e of readdirSync(dir)) {
      if (!e.endsWith(".swift")) continue;
      n += (readFileSync(join(dir, e), "utf8").match(pattern) ?? []).length;
    }
    return n;
  }
  return null;
};

// ─── the README's table ──────────────────────────────────────────────────────

const readme = read("README.md");
const section = readme.slice(readme.indexOf("\n## Surfaces"));
const rows = new Map();
for (const line of section.split("\n")) {
  if (!line.startsWith("|")) {
    if (rows.size > 0) break; // past the table
    continue;
  }
  const cells = line.split("|").map((c) => c.trim());
  const name = cells[1];
  if (!name || name === "Surface" || /^-+$/.test(name) || name === "—") continue;
  rows.set(name.toLowerCase(), { name, status: cells[3] ?? "" });
}

const problems = [];

for (const s of manifest.surfaces) {
  const row = rows.get(s.id);
  const actual = registeredTools(s);
  /*
   * A manifest entry with no registered tool is a surface being built, not a
   * surface that ships, and `marketing/headline-candidates.md` rule 1 is
   * explicit that an unshipped surface must not be named — "a homepage prompt
   * becomes a promise the tool list doesn't keep". So silence is correct here
   * and the only failure is the opposite one: naming it before it exists.
   */
  if (actual === 0) {
    if (row) {
      problems.push(
        `${s.displayName}: named in the README but registers no tool yet — ` +
          `an unshipped surface is a promise the tool list does not keep`,
      );
    }
    rows.delete(s.id);
    continue;
  }
  if (!row) {
    problems.push(`${s.displayName}: no row in the README Surfaces table`);
    continue;
  }
  const claimed = Number(row.status.match(/(\d+)\s+tools?/)?.[1] ?? NaN);
  if (actual === null) {
    problems.push(`${s.displayName}: cannot count tools for runtime "${s.runtime}"`);
  } else if (Number.isNaN(claimed)) {
    problems.push(`${s.displayName}: row states no tool count — expected "${actual} tools"`);
  } else if (claimed !== actual) {
    problems.push(`${s.displayName}: README says ${claimed} tools, the tree registers ${actual}`);
  }
  if (s.supportsWrites && /read-only/i.test(row.status)) {
    problems.push(
      `${s.displayName}: described as read-only, but surfaces.json says supportsWrites — ` +
        `this is a safety claim and it is false`,
    );
  }
  rows.delete(s.id);
}

for (const [, row] of rows) {
  problems.push(`${row.name}: a row for a surface that is not in surfaces.json`);
}

if (problems.length > 0) {
  console.error("README.md Surfaces table has drifted from the tree:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix the table in README.md, then re-run `make readme-check`.");
  process.exit(1);
}

console.log(`README Surfaces table matches the tree (${manifest.surfaces.length} surfaces).`);
