#!/usr/bin/env node
// Check a licence key the way the app will, without launching the app.
//
// The point is that a stranger can run this. When somebody writes in to say
// their key is refused, the useful reply is a reason rather than a shrug, and
// the reason has to come from the same four checks the app makes — signature,
// revocation, major, format — in the same order. License.swift is the twin of
// scripts/lib/license.mjs and this is how you find out which of them is wrong.
//
// It also means the key handed over at checkout can be verified before it is
// sent, which is the cheapest possible guard against apps/api shipping a subtly
// wrong payload to a paying customer.
//
// Exit codes: 0 valid, 1 refused, 2 could not ask the question.
//
//   node scripts/verify-license.mjs cup1.…
//   node scripts/verify-license.mjs --file=./a.license --major=1
//   node scripts/verify-license.mjs --file=./a.license --public-key=…

import { readFileSync } from "node:fs";

import { PUBLIC_KEY, verifyKey } from "./lib/license.mjs";
import { parseArgs } from "./lib/probe-kit.mjs";

const argv = process.argv.slice(2);
const args = parseArgs(argv);

const file = args.valueOf("file", "");
const positional = argv.find((argument) => !argument.startsWith("--"));
if (!file && !positional) {
  console.error("FATAL: pass a key as an argument, or --file=<path>");
  process.exit(2);
}

let key;
try {
  key = file ? readFileSync(file, "utf8") : positional;
} catch (error) {
  console.error(`FATAL: cannot read ${file}: ${String(error?.message ?? error)}`);
  process.exit(2);
}

const publicKey =
  args.valueOf("public-key", "") || process.env.LICENSE_SIGNING_KEY_PUBLIC || PUBLIC_KEY;
if (!publicKey) {
  console.error("FATAL: no public key. Pass --public-key=, set");
  console.error("LICENSE_SIGNING_KEY_PUBLIC, or fill in PUBLIC_KEY in scripts/lib/license.mjs.");
  process.exit(2);
}

// Revocation is deliberately not consulted here. The list that matters is the
// one compiled into a specific build (apps/apple/Cupertino/Revocations.swift),
// so answering "is this revoked" needs a build to answer it about — see
// docs/licensing.md and EULA §4(a). Pass --revoked= to check against one anyway.
const revoked = args.valueOf("revoked", "").split(",").filter(Boolean);
const asked = argv.some((argument) => argument.startsWith("--major="));
const major = asked ? Number(args.valueOf("major", "1")) : undefined;

const result = verifyKey(key, { major, publicKey, revoked });

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const L = [];
L.push(result.ok ? "VALID" : "REFUSED");
if (!result.ok) L.push(`  reason  : ${result.reason}`);
if (result.claims) {
  L.push(`  id      : ${result.claims.id}`);
  L.push(`  email   : ${result.claims.email}`);
  L.push(`  major   : ${result.claims.major}.x`);
  L.push(`  issued  : ${result.claims.issuedAt}`);
}
console.log(L.join("\n"));
process.exit(result.ok ? 0 : 1);
