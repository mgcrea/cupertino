#!/usr/bin/env node
// Bake the revoked licence IDs into the app.
//
// Revocation lands at BUILD time, not run time, and that is the whole shape of
// it. The app makes no network connections — scripts/audit-network.sh fails the
// build over it and the front page sells it — so there is no list it can consult
// while running. A refunded key therefore keeps working until the next release
// and then stops. EULA §4(a) says that to the buyer rather than leaving it to be
// discovered.
//
// Generated-and-committed rather than fetched by CI. Reading D1 from the release
// job would put a network dependency in the path of shipping, so an outage at
// Cloudflare would become an outage in releases — and it would buy nothing,
// since a revocation cannot take effect before the next build either way. CI
// only checks that the committed file is current, and skips even that when it
// has no credentials, so forks and pull requests are unaffected.
//
//   node scripts/generate-revocations.mjs            # rewrite the Swift file
//   node scripts/generate-revocations.mjs --check    # fail if it is stale
//   node scripts/generate-revocations.mjs --local    # against the local D1

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const TARGET = join(ROOT, "apps/apple/Cupertino/Revocations.swift");
const API = join(ROOT, "apps/api");

const args = process.argv.slice(2);
const check = args.includes("--check");
const local = args.includes("--local");

// A pull request from a fork has no secrets, and neither does a clean clone.
// Neither is a failure: the committed file is the source of truth for the build,
// and this only ever confirms it.
if (!local && !process.env.CLOUDFLARE_API_TOKEN) {
  console.log("skipped: no CLOUDFLARE_API_TOKEN, leaving the committed list alone");
  process.exit(0);
}

const query = "SELECT id FROM licenses WHERE revoked_at IS NOT NULL ORDER BY id";
let rows;
try {
  const raw = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "cupertino-licenses",
      local ? "--local" : "--remote",
      "--json",
      "--command",
      query,
    ],
    { cwd: API, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler prints a banner before the JSON on some paths, so find the array
  // rather than assuming the whole of stdout is the document.
  const start = raw.indexOf("[");
  rows = JSON.parse(raw.slice(start))[0].results;
} catch (error) {
  console.error(`FATAL: could not read D1: ${String(error?.message ?? error)}`);
  process.exit(2);
}

const ids = rows
  .map((row) => row.id)
  .filter(Boolean)
  .toSorted();

const header = readFileSync(TARGET, "utf8").split("\nenum Revocations")[0];
const list = ids.length === 0 ? "[]" : `[\n${ids.map((id) => `    "${id}",`).join("\n")}\n  ]`;
const next = `${header}\nenum Revocations {\n  static let ids: Set<String> = ${list}\n}\n`;

if (check) {
  if (readFileSync(TARGET, "utf8") === next) {
    console.log(`ok: ${ids.length} revoked licence(s), Revocations.swift is current`);
    process.exit(0);
  }
  console.error("FATAL: Revocations.swift is stale. Run `make revocations` and commit the result.");
  process.exit(1);
}

writeFileSync(TARGET, next);
console.log(`wrote ${ids.length} revoked licence(s) to apps/apple/Cupertino/Revocations.swift`);
