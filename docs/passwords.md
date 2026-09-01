# Passwords — phase-0 findings

Probe: `pnpm probe:passwords` ([scripts/probe-passwords.mjs](../scripts/probe-passwords.mjs)).
Lane evidence measured on macOS 26.6 (build 25G72), Apple M5 Max. **No package exists and none
should**, and there is deliberately no entry in [`surfaces.json`](../surfaces.json) — one there
would generate Swift, a bridge allow-list, two Makefile regions, a CI handshake loop and a bundler
entry for a package that is not there.

This document is the decision, not a writeup of one.

## Status

**NO-GO, on all four lanes.** Unlike every other negative in this repo, three of the four close for
reasons that no permission, grant or entitlement available to a Developer-ID build can change.

| Lane            | Verdict                            | Closed by                              |
| --------------- | ---------------------------------- | -------------------------------------- |
| Apple Events    | closed                             | no `.sdef`, no `NSAppleScriptEnabled`  |
| Shortcuts       | closed                             | no `Metadata.appintents` in the bundle |
| **File lane**   | **closed — and NOT by permission** | cryptography; see below                |
| Framework / API | closed                             | an Apple-private keychain access group |

> **A fifth lane was added later and does not change this verdict.** The Safari extension can read
> a code a WEBSITE shows, which is a different question from reading the vault — see
> [The fifth lane](#the-fifth-lane-the-safari-extension-and-what-it-does-not-reach) below. All four
> lanes above stay closed.

The probe is a **canary, not a discovery tool**: it re-runs all four checks and exits non-zero if
any lane opens, so a future macOS that changes this is noticed rather than assumed.

## The finding that makes this different: the store is readable and the data is not

Every other closed or expensive surface here is gated by TCC. This one is not, and the distinction
matters because anyone who re-opens the question will reach for Full Disk Access first.

`~/Library/Keychains/<UUID>/keychain-2.db` is mode `0600` owned by the user. It is **not
TCC-protected**, and it opens read-only in a process holding no grant at all. The probe proves this
by measuring its own blindness first, against the stores shipped surfaces read daily:

```
0  CALIBRATION - what this process can see
   full disk access       not granted   (oracle: TCC.db)
   safari                 denied
   messages               denied
   mail                   denied

3  FILE LANE
   keychain-2.db          91922432 B, readable
   opened                 mode=ro, WITHOUT full disk access
```

That inverts the usual finding. The process has **more** access to the keychain than Full Disk
Access would grant it, while being denied all three stores the app actually asks for a grant to
reach. Granting FDA changes nothing on this path, because the file was never the obstacle.

`docs/surfaces.md` records the Maps failure — "'Absent' and 'EPERM' are different findings", got
wrong three times in a row. This is the inverse trap and it is worth naming separately:
**"readable" and "legible" are different findings too.** A store that opens is not a store you can
read.

### What is actually in there

91.9 MB, 3997 `inet` rows and 1666 `genp` rows. Access groups enumerate fine — the schema is not
hidden:

| Access group                                      | Rows |
| ------------------------------------------------- | ---- |
| `com.apple.password-manager.website-metadata`     | 1260 |
| `com.apple.password-manager`                      | 988  |
| `com.apple.password-manager.generated-passwords`  | 57   |
| `com.apple.password-manager.personal`             | 24   |
| `com.apple.password-manager-recently-deleted`     | 5    |
| `com.apple.password-manager.password-evaluations` | 1    |

2335 rows in total. And not one of them yields anything, for two independent reasons.

**The lookup columns are one-way.** `srvr` and `acct` are 20-byte SHA-1 digests, not text. The tell
is unambiguous: 1338 rows carry `acct` = `da39a3ee5e6b4b0d3255bfef95601890afd80709`, which is SHA-1
of the empty string. So the store cannot even be asked _which sites have entries_ — the question has
no answer that survives the hash.

**The payload is ciphertext.** Across all 2335 rows the strings `otpauth`, `http` and `com.apple`
appear **zero times**. Only the `bplist00` envelope header is in the clear; everything inside it is
encrypted under a per-item key.

This is deliberately not an entropy test. `docs/surfaces.md` already records that high entropy does
not distinguish encrypted from compressed, and [`scripts/lib/blob-stats.mjs`](../scripts/lib/blob-stats.mjs)
is the tested tool for that question. Marker-string absence is the stronger and cheaper claim here,
because credential records have a known vocabulary: a legible one _must_ contain a scheme or a
domain, and none does.

### Two locks, and Full Disk Access is neither

1. **Crypto.** The per-item key is wrapped by a class key in `user.kb` — 1670 bytes, opaque, no
   plist header, no readable markers. That keybag is wrapped by a KEK derived from the login
   password and entangled with the Secure Enclave. Root does not help: root can already read the
   file, which is exactly the point being made here.
2. **Authorization.** The decrypt path runs inside `securityd`, which returns an item only to a
   caller whose code signature carries the matching keychain access group.

## The framework lane, and the check that should have come first

`Passwords.app` holds `keychain-access-groups` including **`com.apple.password-manager`** — an
Apple-private group. Access groups must be team-ID-prefixed or Apple-provisioned, so no
Developer-ID build can claim it.

`AuthenticationServices` looks like the public way in and is not: it is a **provider** API.
`ASOneTimeCodeCredentialIdentity`'s own header says _"use this class to **save** entries into
`ASCredentialIdentityStore`"_, and `getCredentialIdentitiesForService` returns your own extension's
identities. The framework lets you **be** a password manager. It never lets you read Apple's.

Same shape as the HomeKit entitlement dead end in [home.md](home.md), and the transferable lesson is
that this check is one command and closes the surface before any SQLite is opened:

```
codesign -d --entitlements - --xml /System/Applications/Passwords.app
```

That is now a rule in [surfaces.md](surfaces.md).

## The false counter-example

Someone will try `security find-internet-password` and get a password back, and conclude the vault
is open. It is not — that item came from a **different store**.

`security list-keychains` returns only `login.keychain-db` and `System.keychain`, the legacy file
keychains. `security dump-keychain` aimed straight at `keychain-2.db` returns nothing at all. The
legacy CLI has no address for a Passwords.app entry.

So the one path that _can_ ask the user for per-item consent — the ACL prompt that makes a legacy
keychain item readable — does not reach the Passwords vault. The probe checks this explicitly for
exactly this reason.

## Decision criteria

This reopens only if Apple ships one of:

- an `.sdef` for Passwords.app, or `NSAppleScriptEnabled`;
- App Intents (`Metadata.appintents`), which would give the `/usr/bin/shortcuts` lane that Home has;
- a **public read** API — not another provider API.

It does **not** reopen on a new TCC grant, because no grant is relevant. Anyone proposing
"just add Full Disk Access" has not read the calibration section above.

## Rejected, and why

- **A user-run Passwords.app CSV export** into a Cupertino-owned vault. That is building a password
  manager, not reading a surface, and it puts TOTP seeds in a plaintext file outside the keychain —
  strictly worse than where they are now.
- **Accessibility UI-scripting** Passwords.app to read a code off the screen. Fragile, needs a new
  grant, and sits squarely in the "scriptable and dangerous" category
  [surfaces.md](surfaces.md) already rejects for Terminal and System Settings.

## The fifth lane: the Safari extension, and what it does not reach

**This document was written against four lanes and there is now a fifth.** It changes nothing above
and is recorded here so nobody re-derives it: a Safari Web Extension content script reads the DOM of
a page the user has allowed it on, which means it can read a one-time code a **website is showing**
— and it needs no TCC grant of any kind to do it, only Safari's own per-site consent.

That is worth stating precisely, because the shapes are easy to confuse:

| Question                                             | Answer                                   |
| ---------------------------------------------------- | ---------------------------------------- |
| Read a code an issuer's page has just displayed       | **yes** — the extension lane             |
| Read a code Safari AutoFill typed into a page's field | **yes** — same lane, same consent        |
| Read the code Passwords.app generates for a TOTP item | **no** — every lane above, still closed  |
| Read a stored password                                | **no**, and no setting in the app enables it |

The third row is the one that matters. A TOTP seed lives in the vault; what a page displays is not
the vault, and reaching one says nothing about reaching the other. Anyone reading this document
because "Cupertino can read 2FA codes now" should stop at that row.

`packages/safari` also declines the second row's neighbours by construction: `page_elements` never
returns the value of a field classified as a **credential** — `type=password`, `cc-number`, `cc-csc`
— and no flag turns that back on, because the flag is named for codes and widening it past them
would make it claim more than its label does.

## What ships instead

The actual goal behind the request was 2FA codes, and those have lanes which are already open and
already granted.

**Most codes arrive by SMS.** See `apple_messages_find_codes` in
[`packages/messages`](../packages/messages), gated behind `APPLE_MESSAGES_ALLOW_CODES` — its own
switch rather than `allowWrites`, because a server that reads Mail and Messages is already holding
the password-_reset_ channel, and adding live auth codes to it is a change of tier that deserves a
deliberate opt-in.

**Some are shown by the site itself**, and those go through the extension: `apple_safari_find_codes`
behind `APPLE_SAFARI_ALLOW_CODES`, plus the one-time-code field value in `apple_safari_page_elements`
under the same flag. The extraction heuristic is the same function, lifted to
[`packages/core`](../packages/core) when Safari became its second caller.

**That Safari gate is deliberately weaker than the Messages one, and the difference should not be
papered over.** On Messages, off means the tool does not exist and the alternative is sifting whole
threads. Here `apple_safari_read_page` stays ungated, so off removes the targeted field read and the
live DOM scan — not every byte of a page. It is a gate on convenience and precision, not on access.

## Privacy

The probe asserts **structure only**: row counts, access-group names, column storage classes, and
presence _counts_ of marker strings. It never selects an item's `data`, `acct` or `srvr` value into
its output, and it must not be changed to. A probe of a credential store that prints one credential
has done more damage than this surface would ever have been worth.
