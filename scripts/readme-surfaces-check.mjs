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
// Counts, prose, and NAMES.
//
// Three things. The number in each Surfaces row against the registrations in
// the tree; every manifest surface having a row; and — the ones that matter —
// that no surface which `surfaces.json` says supports writes is described as
// read-only ANYWHERE in its own section, and that the per-surface
// `### <Surface>` table names every tool the surface registers.
//
// The last two are here because the first version of this script checked only
// the Surfaces table, and the exact claim it was written to kill survived 240
// lines further down: Safari's own section still said "Read-only, and the write
// column is empty on purpose" while the surface registered five write tools. A
// safety claim in prose is still a safety claim. In the same drift eleven
// registered tools were missing from the per-surface tables — Maps' three
// writes among them, which were the 1.16.0 headline.
//
// Names come from `apps/website/src/data/surfaces.ts`, which is itself checked
// against the `registerTool` calls in both directions by
// `scripts/lib/website-tools.test.mjs`. So this does not re-derive the truth; it
// borrows the copy that already has a test.
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

// ─── the per-surface sections ────────────────────────────────────────────────
//
// Everything from `### <Surface>` to the next `###`, which is the table AND the
// prose under it. Both are claims about the same surface, and the prose is
// where the false one survived.

/** The site's tool lists, already checked against the tree in both directions. */
const site = read("apps/website/src/data/surfaces.ts");

/** `read: [...]` / `write: [...]` for one surface id, as bare tool names. */
const siteTools = (id) => {
  const at = site.indexOf(`id: "${id}"`);
  if (at === -1) return null;
  const next = site.indexOf('\n    id: "', at + 1);
  const block = site.slice(at, next === -1 ? site.length : next);
  const listOf = (key) => {
    const start = block.indexOf(`${key}: [`);
    if (start === -1) return [];
    const end = block.indexOf("],", start);
    return [...block.slice(start, end).matchAll(/"(apple_[a-z0-9_]+)"/g)].map((m) => m[1]);
  };
  return { read: listOf("read"), write: listOf("write") };
};

const sectionFor = (displayName) => {
  const heading = `\n### ${displayName}\n`;
  const at = readme.indexOf(heading);
  if (at === -1) return null;
  // Bounded by the next heading of ANY depth. Stopping only at `###` let the
  // last surface's section run to the end of the file and swallow prose about
  // something else entirely.
  const rest = readme.slice(at + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return heading + (next === -1 ? rest : rest.slice(0, next));
};

/**
 * A read-only claim about the SURFACE, not about something it reads.
 *
 * "its store is read-only by policy" is true and has to stay sayable — the
 * store really is, which is why writes go through Apple Events. What must not
 * survive is a claim that the surface itself cannot write.
 */
const READ_ONLY_CLAIMS = [
  /\*\*Read-only[,.]/,
  /read-only by construction/i,
  /th(is|e) (surface|server) is read-only/i,
  /the write column is empty/i,
];

for (const s of manifest.surfaces) {
  const listed = siteTools(s.id);
  const section = sectionFor(s.displayName);
  // A surface with no section of its own is not a drift: `screen`, `sound` and
  // `desktop` are described in prose elsewhere, having no npm package to list.
  if (!listed || !section) continue;

  /*
   * A SAFETY claim, anywhere in the section rather than only in the status
   * cell. Safari's said "Read-only, and the write column is empty on purpose"
   * in a bold paragraph under a table that already had an empty write column,
   * and it was false in both places.
   */
  if (s.supportsWrites && READ_ONLY_CLAIMS.some((re) => re.test(section))) {
    problems.push(
      `${s.displayName}: its section calls the surface read-only, but it registers ` +
        `${listed.write.length} write tool(s) — this is a safety claim and it is false`,
    );
  }

  // The table names tools without their `apple_<surface>_` prefix.
  const named = new Set(
    [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => `apple_${s.id}_${m[1]}`),
  );
  const missing = [...listed.read, ...listed.write].filter((t) => !named.has(t));
  if (missing.length > 0) {
    problems.push(
      `${s.displayName}: registered but absent from its README table — ` +
        missing.map((t) => t.replace(`apple_${s.id}_`, "")).join(", "),
    );
  }
}

if (problems.length > 0) {
  console.error("README.md Surfaces table has drifted from the tree:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nFix the table in README.md, then re-run `make readme-check`.");
  process.exit(1);
}

console.log(`README Surfaces table matches the tree (${manifest.surfaces.length} surfaces).`);
