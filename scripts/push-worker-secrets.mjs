#!/usr/bin/env node
// Check a dotenv file, then hand it to `wrangler secret bulk`.
//
// The push itself is wrangler's: `secret bulk` takes a KEY=VALUE file directly
// and applies the whole set in a single request, which is both fewer round trips
// and less to go wrong halfway than a loop of `secret put`. This script exists
// for the one thing it does not do.
//
// That thing is refusing an incomplete set. `.prod.vars` carries the live webhook
// signing secret, which Stripe shows exactly once at creation — so the realistic
// mistake is running this before it has been pasted in, pushing an empty string,
// and getting a Worker that rejects every real payment with a 400 that reads like
// a signature bug. The three values also have to be the same Stripe mode: a live
// webhook secret with a test API key fulfils and silently records no price.
//
// `.dev.vars` needs none of this — wrangler reads it automatically for local dev
// and it never reaches the deployed Worker.
//
//   node scripts/push-worker-secrets.mjs .prod.vars

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("FATAL: name a dotenv file, e.g. .prod.vars");
  process.exit(2);
}

const API = join(dirname(new URL(import.meta.url).pathname), "..", "apps/api");
const path = resolve(API, file);

let entries;
try {
  entries = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).trim()];
    });
} catch (error) {
  console.error(`FATAL: cannot read ${path}: ${String(error?.message ?? error)}`);
  process.exit(2);
}

if (entries.length === 0) {
  console.error(`FATAL: ${file} defines no KEY=VALUE pairs`);
  process.exit(2);
}

const blank = entries.filter(([, value]) => value === "").map(([name]) => name);
if (blank.length > 0) {
  console.error(
    `FATAL: ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} empty in ${file}.`,
  );
  console.error("A half-applied secret set fails in ways that read as a code bug.");
  process.exit(2);
}

// Warn rather than refuse: naming is a convention, not a guarantee, and a
// legitimate mix is imaginable. Getting it wrong is not, so it should be loud.
const modes = new Set(
  entries
    .filter(([name]) => name.startsWith("STRIPE_"))
    .map(([, value]) => (/_test_|^whsec_test/.test(value) ? "test" : "live")),
);
if (modes.size > 1) {
  console.error(`WARNING: ${file} mixes test and live Stripe credentials.`);
}

console.log(`pushing ${entries.map(([name]) => name).join(", ")} from ${file}`);
execFileSync("pnpm", ["exec", "wrangler", "secret", "bulk", file], {
  cwd: API,
  stdio: "inherit",
});
