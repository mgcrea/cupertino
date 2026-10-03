/**
 * The website's tool list must match the tools the servers actually register.
 *
 * ## Why this test exists
 *
 * `apps/website/src/data/surfaces.ts` is HAND-MAINTAINED. Only the `id` union is
 * generated, so a missing tool name typechecks, builds, deploys, and quietly
 * understates the product; a name that no server registers typechecks just as
 * well and advertises a tool that does not exist. Its own header says so:
 *
 *     "Getting a name wrong here is a claim the servers do not honour — check
 *      the tree, not the README, which has drifted before."
 *
 * It has drifted twice: an `llms.txt` bullet landed mid-way through another
 * surface's entry, and `apple_maps_list_unfiled_places` shipped in
 * `packages/maps` while every hand-maintained copy still said Maps had seven
 * tools. Neither failed a build. Both were found by reading, which is not a
 * process.
 *
 * `make surfaces-check` cannot catch this: it compares the ELEVEN GENERATED
 * targets against `surfaces.json`, and the tool arrays are in none of them.
 *
 * (No glob is spelled out in this comment on purpose. A path ending in a star
 * followed by a slash closes a block comment, which is how the first version of
 * this file corrupted itself the moment the formatter touched it.)
 *
 * ## What it checks, and in both directions
 *
 * Every `registerTool("…")` under `packages/<surface>/src/tools/` must appear in the
 * site's list, and every tool name in the site's list must be registered
 * somewhere. A surface served by the app rather than by a node package is
 * scanned too — see `SWIFT_SERVERS`, and note that forgetting it makes this
 * suite pass while covering nothing. The second direction is the one that catches a rename: without it,
 * renaming a tool and adding the new name leaves the old one advertised forever.
 *
 * Write-gated tools are registered through the same call and belong in the
 * site's `write` column, so they are included with no special case.
 *
 * ## Why regex rather than importing the module
 *
 * `surfaces.ts` is TypeScript and this suite is `node --test` over plain `.mjs`
 * with no build step. Matching quoted `apple_*` literals is cruder than parsing
 * and is enough: the failure being prevented is a name that is absent or
 * misspelled, and a literal is exactly what carries it.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE = join(ROOT, "apps", "website", "src", "data", "surfaces.ts");

/**
 * A surface served by the app itself, which has no `packages/<id>` to scan.
 *
 * `screen` is the first. Without this the suite still PASSES and silently stops
 * covering the surface: the scan finds no tools for it, the site lists none
 * either, and the two agree by both being empty. That is worse than a failure,
 * because the whole point of this file is that a wrong tool list cannot ship
 * quietly — so a runtime the scan does not know about has to be added here the
 * moment it exists.
 *
 * The names live in a Swift dictionary literal rather than a `registerTool`
 * call, so the pattern differs. Same crudeness, same justification as the
 * regex note above: a literal is what carries the name.
 */
const SWIFT_SERVERS = [
  ["desktop", join(ROOT, "apps", "apple", "Cupertino", "DesktopServer.swift")],
  ["screen", join(ROOT, "apps", "apple", "Cupertino", "ScreenServer.swift")],
  ["sound", join(ROOT, "apps", "apple", "Cupertino", "SoundServer.swift")],
  ["simulator", join(ROOT, "apps", "apple", "Cupertino", "SimulatorServer.swift")],
];

/** Every tool name passed to `server.registerTool`, across every package. */
const registeredTools = () => {
  const found = new Map();
  const packages = join(ROOT, "packages");
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg, "src", "tools");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(dir, file), "utf8");
      // `registerTool(` is followed by a newline before the name, so the
      // whitespace class is load-bearing rather than defensive.
      for (const m of src.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)) found.set(m[1], pkg);
    }
  }
  for (const [surface, file] of SWIFT_SERVERS) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/"name":\s*"(apple_[a-z0-9_]+)"/g)) found.set(m[1], surface);
  }
  return found;
};

/** Every `apple_*` literal in the site's surface list. */
const siteTools = () => {
  const src = readFileSync(SITE, "utf8");
  return new Set([...src.matchAll(/"(apple_[a-z0-9_]+)"/g)].map((m) => m[1]));
};

test("every registered tool is listed on the website", () => {
  const registered = registeredTools();
  assert.ok(registered.size > 0, "found no registerTool calls at all — the scan is broken");
  const site = siteTools();
  const missing = [...registered.keys()].filter((t) => !site.has(t)).toSorted();
  assert.deepEqual(
    missing,
    [],
    `${missing.length} tool(s) ship but are absent from apps/website/src/data/surfaces.ts, ` +
      `so the site understates what the servers do: ${missing.join(", ")}`,
  );
});

test("every tool listed on the website is actually registered", () => {
  const registered = registeredTools();
  const site = siteTools();
  const phantom = [...site].filter((t) => !registered.has(t)).toSorted();
  assert.deepEqual(
    phantom,
    [],
    `${phantom.length} tool(s) are advertised on the site but no server registers them — ` +
      `a claim the servers do not honour: ${phantom.join(", ")}`,
  );
});

/*
 * A rename is the case both directions above catch only together, so it is worth
 * one test of its own: it is the failure that leaves a stale name advertised
 * while the new one is also present, and every count on the site stays right.
 */
test("the two lists are the same size, so a rename cannot hide in the totals", () => {
  assert.equal(
    registeredTools().size,
    siteTools().size,
    "the site and the servers agree on names but not on how many — check for a duplicate",
  );
});

/*
 * `llms.txt` is the same claim in prose, and it is served at /llms.txt to
 * crawlers and to models that will repeat it verbatim. It is hand-maintained
 * and nothing checked it, so it drifted further than any other file in the
 * repo: at one point seven surfaces named when ten shipped, a version eight
 * releases old, "not on npm yet" after every package had been published, wrong
 * tool counts on five surfaces, and "Safari — 7 tools … read-only. There is no
 * write tool", which is a false SAFETY claim in the one file written for
 * machines to quote.
 *
 * Counted from the site's own list rather than from the servers, because
 * `surfaces.ts` is already pinned to the servers by the three tests above. So a
 * tool that ships reaches both files or neither.
 */
const LLMS = join(ROOT, "apps", "website", "public", "llms.txt");

const surfaceBlocks = () => {
  const src = readFileSync(SITE, "utf8");
  const blocks = src.split(/\n  \{\n    id: "/).slice(1);
  return blocks.map((block) => {
    const id = block.slice(0, block.indexOf('"'));
    // Non-greedy to the first `]`, so a short array written on one line counts
    // the same as a long one written over many. Requiring a newline before the
    // bracket read Contacts' two write tools as none.
    const section = (key) => {
      const m = block.match(new RegExp(`\\n    ${key}: \\[(.*?)\\]`, "s"));
      return m ? [...m[1].matchAll(/"(apple_[a-z0-9_]+)"/g)].length : 0;
    };
    // The gated entries are objects written over several lines, so the name is
    // on its own line rather than beside the brace.
    const gatedBlock = block.match(/\n    gated: \[(.*?)\n    \],/s);
    const gated = gatedBlock
      ? [...gatedBlock[1].matchAll(/name: "(apple_[a-z0-9_]+)"/g)].length
      : 0;
    return { id, read: section("read"), write: section("write"), gated };
  });
};

/** The bullet a surface gets in llms.txt, from its first line to the next blank line or bullet. */
const llmsBullet = (text, id) => {
  const name = id[0].toUpperCase() + id.slice(1);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`- ${name} — `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && (l === "" || l.startsWith("- ")));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
};

test("llms.txt names every surface, with the tool count the site lists", () => {
  const text = readFileSync(LLMS, "utf8");
  const blocks = surfaceBlocks();
  assert.ok(blocks.length > 0, "found no surfaces in surfaces.ts — the split is broken");
  const problems = [];
  for (const { id, read, write, gated } of blocks) {
    const total = read + write + gated;
    const bullet = llmsBullet(text, id);
    if (!bullet) {
      problems.push(`${id}: no bullet in llms.txt`);
      continue;
    }
    const claimed = Number(bullet.match(/— (\d+) tools?/)?.[1]);
    if (claimed !== total)
      problems.push(`${id}: llms.txt says ${claimed} tools, the site lists ${total}`);
  }
  assert.deepEqual(problems, [], problems.join("; "));
});

test("llms.txt calls no surface read-only that has write tools", () => {
  const text = readFileSync(LLMS, "utf8");
  for (const { id, write } of surfaceBlocks()) {
    if (write === 0) continue;
    const bullet = llmsBullet(text, id) ?? "";
    assert.ok(
      !/read-only|no write tool/i.test(bullet),
      `llms.txt calls ${id} read-only, but the site lists ${write} write-gated tool(s)`,
    );
  }
});

/*
 * The minor version, not the full one. A patch release changes no surface and
 * no tool, and a gate that demanded an llms.txt edit for every patch would be
 * satisfied by bumping the number without reading the rest, which is the drift
 * it exists to stop.
 */
test("llms.txt states the shipped minor version and does not claim npm is pending", () => {
  const text = readFileSync(LLMS, "utf8");
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const minor = version.split(".").slice(0, 2).join(".");
  assert.ok(
    new RegExp(`\\b${minor.replace(".", "\\.")}\\.\\d+\\b`).test(text),
    `llms.txt does not mention a ${minor}.x release; the shipped version is ${version}`,
  );
  assert.ok(!/not on npm yet/i.test(text), "llms.txt still says the packages are not on npm");
});
