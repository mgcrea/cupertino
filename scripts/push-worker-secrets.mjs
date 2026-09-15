#!/usr/bin/env node
// Check a dotenv file, then hand it to `wrangler secret bulk`.
//
// The push itself is wrangler's: `secret bulk` takes a KEY=VALUE file directly
// and applies the whole set in a single request, which is both fewer round trips
// and less to go wrong halfway than a loop of `secret put`. This script exists
// for the one thing it does not do.
//
// That thing is refusing a set that should not be pushed. `.prod.vars` carries
// the live webhook signing secret, which Stripe shows exactly once at creation —
// so the realistic mistake is running this before it has been pasted in, pushing
// an empty string, and getting a Worker that rejects every real payment with a
// 400 that reads like a signature bug. The three values also have to be the same
// Stripe mode: a live webhook secret with a test API key cannot look up a price,
// so a sale with no `price_id` on its session answers 500 until it is fixed.
//
// And refusing the wrong TARGET. Without `--env`, `wrangler secret bulk` writes
// to the top-level Worker, the one taking real money, so any file but
// `.prod.vars` needs `--env <name>` to say where it goes.
//
// `.dev.vars` needs none of this — wrangler reads it automatically for local dev
// and it never reaches the deployed Worker.
//
//   node scripts/push-worker-secrets.mjs .prod.vars
//   node scripts/push-worker-secrets.mjs .test.vars --env test

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const fatal = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(2);
};

let file = "";
let environment = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--env" || arg.startsWith("--env=")) {
    environment = arg === "--env" ? (argv[++i] ?? "") : arg.slice("--env=".length);
    if (!environment || environment.startsWith("-")) {
      fatal("FATAL: --env needs a name, e.g. --env test");
    }
  } else if (!file) {
    file = arg;
  } else {
    fatal(`FATAL: unexpected argument '${arg}'`);
  }
}
if (!file) fatal("FATAL: name a dotenv file, e.g. .prod.vars");

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
//
// A heuristic, and a one-sided one. `sk_test_` and `rk_test_` say their mode,
// but a webhook signing secret is `whsec_` and random in either mode, so a
// test-mode set can carry no marker at all and read as "live". That is why the
// target check below is a refusal and this stays a warning.
const modes = new Set(
  entries
    .filter(([name]) => name.startsWith("STRIPE_"))
    .map(([, value]) => (/_test_|^whsec_test/.test(value) ? "test" : "live")),
);
if (modes.size > 1) {
  console.error(`WARNING: ${file} mixes test and live Stripe credentials.`);
}

// The file name is the only signal that cannot be absent. `.prod.vars` is the
// one file meant for the top-level Worker; anything else goes there only by
// accident, and replacing the live webhook secret refuses every genuine payment.
if (!environment && basename(file) !== ".prod.vars") {
  fatal(
    `FATAL: ${file} is not .prod.vars, and no --env names where it should go.`,
    "Without --env, wrangler writes to the live Worker. Pass --env <name> for any other target.",
  );
}

const target = environment ? ["--env", environment] : [];
console.log(
  `pushing ${entries.map(([name]) => name).join(", ")} from ${file}` +
    ` to ${environment ? `--env ${environment}` : "the top-level Worker"}`,
);
execFileSync("pnpm", ["exec", "wrangler", "secret", "bulk", file, ...target], {
  cwd: API,
  stdio: "inherit",
});
