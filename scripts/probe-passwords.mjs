#!/usr/bin/env node
// Phase 0 probe for a PROSPECTIVE `passwords` surface. It is a CANARY, not a
// discovery tool: every lane was closed by hand on macOS 26.6 and this file
// exists to notice if a future macOS reopens one.
//
// There is deliberately no entry in `surfaces.json` and there never will be
// unless this probe starts failing. One there generates Swift, a bridge
// allow-list, two Makefile regions, a CI handshake loop and a bundler entry for
// a package that is not there.
//
// ALL FOUR LANES ARE CLOSED
//
//   Apple Events       CLOSED. Passwords.app ships no .sdef and no
//                      NSAppleScriptEnabled. `docs/surfaces.md` already lists it
//                      under "not scriptable - file lane or nothing".
//
//   Shortcuts          CLOSED, and this is where Passwords differs from Home.
//                      Home.app's control lane exists because `shortcuts list`
//                      works with no Full Disk Access. Passwords.app ships no
//                      Metadata.appintents at all, so there is nothing to drive.
//
//   File lane          CLOSED BY CRYPTOGRAPHY, NOT BY PERMISSION. This is the
//                      finding that makes this surface different from every
//                      other negative in this repo, and section 3 measures it.
//
//   Framework / API    CLOSED BY ENTITLEMENT. AuthenticationServices is a
//                      PROVIDER api: ASOneTimeCodeCredentialIdentity's own
//                      header says "use this class to SAVE entries into
//                      ASCredentialIdentityStore", and
//                      getCredentialIdentitiesForService returns your own
//                      extension's identities. Reading Apple's vault needs the
//                      `com.apple.password-manager` keychain access group,
//                      which Passwords.app holds and no Developer-ID build can
//                      claim. Same shape as the HomeKit entitlement dead end in
//                      `docs/home.md`.
//
// WHY SECTION 0 EXISTS, AND WHY IT RUNS FIRST
//
// `docs/surfaces.md`: "'Absent' and 'EPERM' are different findings", broken
// three times in a row on Maps. The INVERSE trap is the one here. The keychain
// is mode 0600 owned by the user and is NOT TCC-gated, so it opens in a process
// that is simultaneously denied chat.db - and a reader who is not shown that
// calibration will answer "just grant Full Disk Access". FDA changes nothing on
// this path. The probe must SHOW that it holds no grant and reads the keychain
// anyway, or its negative is not trustworthy.
//
// THIS PROBE NEVER PRINTS AN ITEM
//
// Every assertion below is STRUCTURAL: row counts, access-group names, column
// storage classes, and presence COUNTS of marker strings. It never selects an
// item's `data`, `acct` or `srvr` value into the output, and it must not be
// "improved" to do so. A probe of a credential store that prints one credential
// has done more damage than the surface would ever have been worth.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fileFacts, macosVersion, openStore, parseArgs, readable, safe } from "./lib/probe-kit.mjs";

const HOME = homedir();
const args = parseArgs(process.argv.slice(2));

/** Exit codes. 1 means SOMETHING CHANGED and the docs are now wrong. */
const EXIT = { closed: 0, laneOpened: 1, couldNotCheck: 3 };

const L = [];
const say = (s = "") => L.push(s);
const findings = { macos: macosVersion(), lanes: {}, calibration: {} };

const finish = (code) => {
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...findings, exit: code }, null, 2)}\n`);
  } else {
    process.stdout.write(`${L.join("\n")}\n`);
  }
  process.exit(code);
};

// SECTION 0  CALIBRATION: what can this process see at all?
//
// The oracle is the one `apps/apple/Cupertino/Permissions.swift` uses. Never
// stat(2): stat succeeds on TCC-protected files, which is the trap that made an
// earlier version of that Swift file report Full Disk Access as granted.

const TCC_DB = join(HOME, "Library/Application Support/com.apple.TCC/TCC.db");
const SHIPPED_STORES = {
  safari: join(HOME, "Library/Safari/History.db"),
  messages: join(HOME, "Library/Messages/chat.db"),
  mail: join(HOME, "Library/Mail"),
};

const hasFda = readable(TCC_DB);
const shipped = Object.fromEntries(
  Object.entries(SHIPPED_STORES).map(([id, p]) => [id, readable(p)]),
);
const shippedReadable = Object.values(shipped).filter(Boolean).length;
findings.calibration = { hasFda, shipped };

say("0  CALIBRATION - what this process can see");
say(`   full disk access       ${hasFda ? "GRANTED" : "not granted"}   (oracle: TCC.db)`);
for (const [id, ok] of Object.entries(shipped)) {
  say(`   ${id.padEnd(22)} ${ok ? "readable" : "denied"}`);
}
say();

// The data-protection keychain directory is named after a per-machine UUID, so
// it is discovered rather than hardcoded. `login.keychain-db` and
// `metadata.keychain-db` are the LEGACY keychains, a different store - see 5.

const keychainRoot = join(HOME, "Library/Keychains");
const dpDir = safe(
  () =>
    readdirSync(keychainRoot)
      .filter((n) => /^[0-9A-F-]{36}$/i.test(n))
      .map((n) => join(keychainRoot, n))
      .find((d) => existsSync(join(d, "keychain-2.db"))) ?? null,
  () => null,
);
// `--store=` exists so the canary can be tested against a fixture that DOES
// hold a legible marker. A check that has never been seen to fail is not
// evidence of anything, and this one guards a claim nobody will re-derive.
const storeOverride = args.valueOf("store", "");
const storePath = storeOverride || (dpDir ? join(dpDir, "keychain-2.db") : null);

// SECTION 1  APPLE EVENTS

const APP = "/System/Applications/Passwords.app";
const plistValue = (key) =>
  safe(
    () =>
      execFileSync("/usr/bin/plutil", ["-extract", key, "raw", join(APP, "Contents/Info.plist")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    () => null,
  );

const sdefs = safe(
  () => readdirSync(join(APP, "Contents/Resources")).filter((f) => f.endsWith(".sdef")),
  () => [],
);
const scriptEnabled = plistValue("NSAppleScriptEnabled");
const appleEventsOpen = sdefs.length > 0 || scriptEnabled === "true";
findings.lanes.appleEvents = { sdefs, scriptEnabled, open: appleEventsOpen };

say("1  APPLE EVENTS");
say(`   .sdef files            ${sdefs.length === 0 ? "none" : sdefs.join(", ")}`);
say(`   NSAppleScriptEnabled   ${scriptEnabled ?? "absent"}`);
say(`   verdict                ${appleEventsOpen ? "*** OPEN ***" : "closed"}`);
say();

// SECTION 2  SHORTCUTS / APP INTENTS

const appIntents = safe(
  () =>
    execFileSync("/usr/bin/find", [APP, "-maxdepth", "4", "-name", "Metadata.appintents"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean),
  () => [],
);
const shortcutsOpen = appIntents.length > 0;
findings.lanes.shortcuts = { appIntents, open: shortcutsOpen };

say("2  SHORTCUTS / APP INTENTS");
say(`   Metadata.appintents    ${appIntents.length === 0 ? "none" : `${appIntents.length} found`}`);
say(`   verdict                ${shortcutsOpen ? "*** OPEN ***" : "closed"}`);
say();

// SECTION 3  FILE LANE
//
// THE GO/NO-GO, and the one section that can exit 3. Two independent things are
// measured, because either alone would be the weaker claim:
//
//   a. the LOOKUP columns are one-way. `srvr` and `acct` are SHA-1 digests, not
//      text. The tell is that every website-metadata row carries
//      da39a3ee5e6b4b0d3255bfef95601890afd80709 - SHA-1 of the empty string.
//      So you cannot even enumerate WHICH SITES have entries.
//   b. the PAYLOAD is ciphertext. Marker strings that must appear in any
//      legible credential record appear zero times across every row.
//
// Deliberately NOT an entropy test. `docs/surfaces.md`: high entropy does not
// distinguish encrypted from compressed, and `scripts/lib/blob-stats.mjs` is
// the tested tool for that question. Marker-string absence is a stronger and
// cheaper claim here, because these records have a known vocabulary.

const MARKERS = ["otpauth", "http", "com.apple"];
const SHA1_EMPTY = "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709";
const PW_GROUPS = "agrp LIKE 'com.apple.password-manager%'";

say("3  FILE LANE");
if (!storePath) {
  say("   keychain-2.db          NOT FOUND under ~/Library/Keychains");
  say("   verdict                CANNOT CHECK");
  finish(EXIT.couldNotCheck);
}

const facts = fileFacts(storePath);
say(`   keychain-2.db          ${facts.sizeBytes} B, ${facts.readable ? "readable" : "DENIED"}`);

const opened = openStore(storePath);
if (!opened.db) {
  // The `spike-maps-store.mjs` rule: refuse to report a negative you cannot
  // stand behind. A store that will not open is an unanswered question, not a
  // closed lane.
  say(`   open                   FAILED - ${opened.error}`);
  say("   verdict                CANNOT CHECK");
  finish(EXIT.couldNotCheck);
}

const { db } = opened;
const q = (sql) =>
  safe(
    () => db.prepare(sql).all(),
    () => [],
  );
const count = (where) => Number(q(`SELECT COUNT(*) AS n FROM inet WHERE ${where}`)[0]?.n ?? 0);

const groups = q(
  `SELECT agrp, COUNT(*) AS n FROM inet WHERE ${PW_GROUPS} GROUP BY agrp ORDER BY n DESC`,
);
const pwRows = groups.reduce((a, g) => a + Number(g.n), 0);

// Storage class, not content. `typeof()` and `LENGTH()` describe the column
// without selecting a single byte of it into the output.
const [shape] = q(
  `SELECT typeof(srvr) AS srvrType, LENGTH(srvr) AS srvrLen FROM inet WHERE ${PW_GROUPS} LIMIT 1`,
);
const emptyHashRows = count(`${PW_GROUPS} AND HEX(acct) = '${SHA1_EMPTY}'`);

// Presence COUNTS only. INSTR() returns a position; the value is reduced to a
// count inside SQLite and the needle's surroundings are never selected.
const markerHits = Object.fromEntries(
  MARKERS.map((m) => [m, count(`${PW_GROUPS} AND INSTR(data, CAST('${m}' AS BLOB)) > 0`)]),
);

const lookupIsHashed = shape?.srvrType === "blob" && shape?.srvrLen === 20;
const payloadLegible = Object.values(markerHits).some((n) => n > 0);
const fileLaneOpen = payloadLegible || !lookupIsHashed;
findings.lanes.file = {
  storeReadable: facts.readable,
  openedWithoutFda: !hasFda,
  pwRows,
  groups: groups.map((g) => `${g.agrp}=${g.n}`),
  lookupIsHashed,
  emptyHashRows,
  markerHits,
  open: fileLaneOpen,
};

say(`   opened                 mode=${opened.mode}${hasFda ? "" : ", WITHOUT full disk access"}`);
say(`   password-manager rows  ${pwRows} across ${groups.length} access groups`);
say(
  `   lookup columns         ${lookupIsHashed ? `SHA-1 digests (blob, ${shape.srvrLen} B)` : "*** NOT HASHED ***"}`,
);
say(
  `   acct = SHA-1("")       ${emptyHashRows} rows${emptyHashRows > 0 ? " - one-way column, confirmed" : ""}`,
);
for (const [m, n] of Object.entries(markerHits)) {
  say(`   marker ${`'${m}'`.padEnd(16)}${n} rows${n > 0 ? "   *** LEGIBLE ***" : ""}`);
}
say(
  `   verdict                ${fileLaneOpen ? "*** OPEN ***" : "closed - by cryptography, not permission"}`,
);
say();
db.close();

// SECTION 4  ENTITLEMENT
//
// The cheapest check of the four, and the one that would have closed this
// surface before any SQLite was opened. It is now a rule in docs/surfaces.md.

const ents = safe(
  () =>
    execFileSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", APP], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  () => "",
);
const holdsPrivateGroup = ents.includes("com.apple.password-manager");
// This lane cannot "open" by measurement - no entitlement we can hold reads the
// vault. It is recorded so the check is re-run, not so the verdict can flip.
findings.lanes.api = { holdsPrivateGroup, open: false };

say("4  FRAMEWORK / API");
say(
  `   keychain-access-groups ${holdsPrivateGroup ? "includes com.apple.password-manager (Apple-private)" : "NOT FOUND - re-check by hand"}`,
);
say("   AuthenticationServices  provider-only; no read path at any entitlement we can hold");
say("   verdict                closed - by entitlement");
say();

// SECTION 5  THE CONSENT PATH THAT DOES NOT REACH
//
// Recorded because it is the most likely false counter-example. `security` CAN
// prompt for consent and return a password - but only from the LEGACY file
// keychains. It has no address for a Passwords.app entry, and someone who reads
// a login.keychain-db item this way will believe the vault is open.

const listed = safe(
  () => execFileSync("/usr/bin/security", ["list-keychains"], { encoding: "utf8" }),
  () => "",
);
const dpListed = Boolean(dpDir) && listed.includes(dpDir);
findings.lanes.securityCli = { listsDataProtection: dpListed, open: dpListed };

say("5  THE `security` CLI (the likely false counter-example)");
say(
  `   list-keychains         ${listed.trim().split("\n").filter(Boolean).length} legacy keychain(s)`,
);
say(
  `   data-protection listed ${dpListed ? "*** YES ***" : "no - it has no address for a Passwords entry"}`,
);
say();

// VERDICT

const openLanes = Object.entries(findings.lanes)
  .filter(([, v]) => v.open)
  .map(([k]) => k);

say("VERDICT");
if (openLanes.length > 0) {
  say(`   *** A LANE HAS OPENED: ${openLanes.join(", ")} ***`);
  say("   docs/passwords.md is now WRONG. Re-probe by hand before believing this.");
  finish(EXIT.laneOpened);
}
say("   All four lanes closed. docs/passwords.md still holds.");
say();
say("   The load-bearing line, and the one a reader will argue with:");
say(
  `   this process holds ${hasFda ? "FULL DISK ACCESS" : "NO full disk access"} (${shippedReadable}/3`,
);
say("   shipped stores readable) and read the keychain anyway.");
say("   Granting FDA changes nothing on this path.");
finish(EXIT.closed);
