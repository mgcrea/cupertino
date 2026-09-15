#!/usr/bin/env node
// Verify a release archive's Sparkle signature against the app's SUPublicEDKey.
//
// `make appcast` runs this straight after `sign_update`, before any feed is
// written. Why the key has to be checked at all is in lib/update-signature.mjs,
// which also says why this file is identical in armada, bastion and cupertino.
//
//   node scripts/verify-update-signature.mjs <archive> <edSignature> <SUPublicEDKey>
//
// Exits 0 when the signature verifies over the archive for that key, 1 when it
// does not, and 2 on a missing argument, an unreadable archive, or a value that
// is not a key or a signature at all. Both non-zero codes stop the recipe.
import { readFileSync } from "node:fs";

import { verifyUpdateSignature } from "./lib/update-signature.mjs";

const [archive, signature, publicKey] = process.argv.slice(2);
if (!archive || signature === undefined || publicKey === undefined) {
  console.error("usage: verify-update-signature.mjs <archive> <edSignature> <SUPublicEDKey>");
  process.exit(2);
}

let valid;
try {
  valid = verifyUpdateSignature({ data: readFileSync(archive), signature, publicKey });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`  !! verify-update-signature: ${message}`);
  process.exit(2);
}

if (!valid) {
  console.error(`  !! the edSignature over ${archive} was not made by SUPublicEDKey ${publicKey}.`);
  console.error("     Every installed copy would refuse this update. Not shipping a feed.");
  process.exit(1);
}
console.log(`  edSignature over ${archive} verifies against SUPublicEDKey ${publicKey}`);
