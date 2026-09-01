# Home (HomeKit) — phase-0 findings

Probe: `pnpm probe:home` ([scripts/probe-home.mjs](../scripts/probe-home.mjs)).
Lane evidence measured on macOS 26.6. **No package exists**, and there is
deliberately no entry in [`surfaces.json`](../surfaces.json) — one there would
generate Swift, a bridge allow-list, two Makefile regions, a CI handshake loop
and a bundler entry for a package that is not there.

This document is the decision, not a writeup of one.

## Status

**GO.** Every criterion in the decision table below passes, measured on macOS 26.6
against a real store with 4 homes, 35 rooms and 119 accessories.

| Gate                            | Result                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 opens under Full Disk Access | **yes**, `mode=ro`. Not a private TCC service, not a data vault. `Permissions.swift` needs no new state.                                                                                   |
| G2 names are legible            | **yes.** `core.sqlite` holds 115,466 B of text across 146 columns, 54 human-scale. Of 95 sampled blob columns: 34 plaintext, 51 short-fixed-width identifiers, 10 undecided, **0 sealed**. |
| G3 the chain resolves           | **yes**, every hop, by scalar foreign key at coverage 1.000.                                                                                                                               |
| G4 cost is Safari-scale         | **3 ms** total. Maps 0 ms, Safari 16 ms, Calendar 3.4 s, Mail 74 s.                                                                                                                        |
| G5 the epoch resolves           | **yes** — `apple-seconds`, on a `FLOAT` column (fractional `CFAbsoluteTime`).                                                                                                              |

No no-go condition fires. The store is not encrypted, the grant is one Cupertino
already asks for, the bridge resolves, and there are rows.

### The object graph

```
ZMKFHOME       4      ZMKFROOM.ZHOME      -> ZMKFHOME.Z_PK       1.000
ZMKFZONE       4      ZMKFZONE.ZHOME      -> ZMKFHOME.Z_PK       1.000
ZMKFROOM      35      ZMKFACCESSORY.ZROOM -> ZMKFROOM.Z_PK       1.000
ZMKFACCESSORY        119      ZMKFSERVICE.ZACCESSORY -> ZMKFACCESSORY.Z_PK  1.000
ZMKFSERVICE          535
ZMKFCHARACTERISTIC  2761
ZMKFACTIONSET (scenes) 70     ZMKFTRIGGER (automations) 46     ZMKFACTION 123
```

Every hop is a plain scalar foreign key at full coverage, so **"turn off the
kitchen" is sayable** — the constraint that would have made this a flat, useless
list does not apply.

### Configuration only, on the evidence so far

A 90-second window with the store read twice moved **no role-bearing table**.
`ZMKFACCESSORY`, `ZMKFSERVICE` and `ZMKFCHARACTERISTIC` all sat still. What moved
was replication bookkeeping: `ACHANGE` +6, `ATRANSACTION` +4, and
`ZRESIDENTSYNCMETADATA` (its `ZLASTSEENTOKEN` / `ZLASTSYNCTOKEN` advanced).

That matches the structural reading. `ZMKFCHARACTERISTIC` has 2,761 rows carrying
`ZMINIMUMVALUE`, `ZMAXIMUMVALUE`, `ZSTEPVALUE` and `ZVALIDVALUES` — the RANGE a
characteristic may take, which is metadata — and no current-value column beside
them. That is how HomeKit works: a live value arrives over HAP from the accessory
and lives in `homed`'s memory, not on disk.

Some cached state does exist on `ZMKFACCESSORY` (`ZLOWBATTERY`,
`ZSUSPENDEDSTATE`, `ZCAMERACURRENTACCESSMODE`, `ZFIRMWAREVERSION`), on
`ZMKFSERVICE` (`ZLASTKNOWNOPERATINGSTATE`, `ZLASTKNOWNDISCOVERYMODE`) and on
`ZMKFHOME` (`ZACTIVITYSTATE`). None of it moved in the window.

**So plan for a static inventory** — `list_homes`, `list_rooms`, `list_zones`,
`list_accessories`, `list_services`, `list_scenes`, `list_automations`,
`get_accessory` — and say plainly in the guide that this surface cannot tell you
whether a light is on. The `ZLASTKNOWN*` columns can be exposed as what they are:
last-known, undated, possibly stale.

One caveat kept deliberately: it is not recorded whether an accessory was
actually toggled during that window. If one was, this is settled. If not, the run
shows only that an idle home does not write to disk, which is unsurprising. The
probe now says which of the two it is; re-running with a deliberate toggle costs
90 seconds and would close it for good.

### What the directory holds

45 files, of which **8 are named after accessory MAC addresses** (see Privacy).
Seven SQLite stores, and they are not interchangeable:

| File                          | Size    | Rows    | In role tables | What it is                                                                                                                          |
| ----------------------------- | ------- | ------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `core.sqlite`                 | 13.8 MB | 136,395 | **3,656**      | **The store.** 102 tables / 148 entities.                                                                                           |
| `core-cloudkit.sqlite`        | 5.2 MB  | 4,970   | 427            | The CloudKit **mirror** — same entities with a `CK` infix, plus `ANSCK*` bookkeeping. **No service table at all.**                  |
| `core-cloudkit-shared.sqlite` | 2.4 MB  | 349     | 3              | The shared-with-me half of the mirror.                                                                                              |
| `core-local.sqlite`           | 2.2 MB  | 862     | 14             | Device-local state (`ZLOCALBULLETIN*`).                                                                                             |
| `datastore3.sqlite`           | 13.9 MB | 853     | 0              | **Not Core Data.** A generic `record_v2` / `store_v2` store; `model_data` and `external_data` are plain bplist. Worth its own look. |
| `eventstore-beta.sqlite`      | 377 KB  | 378     | 0              | One key/value table. See below.                                                                                                     |
| `homeevents.sqlite`           | 29 KB   | 3       | 0              | Tiny, and its `Z_MODELCACHE.Z_CONTENT` reads ENCRYPTED.                                                                             |

Note the `In role tables` column: it is the one that identifies the real store,
and the reason is in "Rules this probe added".

**WAL-blindness is real and measured.** Two tables differ between `mode=ro` and
`immutable=1`, and `core-local.sqlite-wal` (4.1 MB) is larger than its own
database (2.2 MB). `homed` holds these files open permanently, so an immutable
read is measurably behind. Every count a package reports must carry that caveat
and `diagnostics` must report the open mode, as `packages/maps` does.

**Event history is not usable as it stands.** `eventstore-beta.sqlite` holds 378
rows in a single key/value table with no date column, so no retention window can
be computed, and its keys are integers rather than identifiers — nothing joins
back to the store by reference. Leave it out of a v1 and say so, the way Safari
reports `Downloads.plist` and never parses it. The `-beta` Apple put in the
filename is a second reason.

## Four lanes, two of them closed

**Recorded so they are not re-opened.** This section was deleted once by accident
during an edit and the framework question was raised again within the day, which
is the argument for keeping the evidence rather than the conclusion.

| Lane                          | Verdict                        | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HomeKit.framework`, native   | **closed**                     | `HMHomeManager.h` is `API_AVAILABLE(ios(8.0), watchos(2.0), tvos(10.0), macCatalyst(14.0))` — **Catalyst only, and no plain `macos`**. There is no `HomeKit.framework` in the public macOS SDK at all; on macOS it exists only under `/System/Library/PrivateFrameworks/`.                                                                                              |
| `com.apple.developer.homekit` | **closed for this app**        | The capability's distribution types are `AD_HOC`, `DEVELOPMENT`, `STORE` — and **no `DEVELOPER_ID`**, read out of Xcode's `DVTPortalCachedPortalCapabilities.json`, where App Groups, iCloud, Push, Personal VPN and Associated Domains all _do_ list it. Cupertino ships Developer ID. See below for why "just ship on the App Store" is not the escape it looks like. |
| Apple Events                  | **closed**                     | No `.sdef` in `/System/Applications/Home.app`, no `NSAppleScriptEnabled`.                                                                                                                                                                                                                                                                                               |
| File lane                     | **open — this is the surface** | `~/Library/HomeKit`, Full-Disk-Access gated, held open by `homed`.                                                                                                                                                                                                                                                                                                      |

Reproduce either check in one command:

```
grep -h "API_AVAILABLE(ios(8.0)" \
  "$(xcrun --sdk iphoneos --show-sdk-path)/System/Library/Frameworks/HomeKit.framework/Headers/HMHomeManager.h"
python3 -c 'import json;d=json.load(open("/Applications/Xcode.app/Contents/SharedFrameworks/DVTPortal.framework/Versions/A/Resources/DVTPortalCachedPortalCapabilities.json"));print([[x["name"] for x in i["attributes"]["distributionTypes"]] for i in d["data"] if i["attributes"]["name"]=="HomeKit"])'
```

### Why the App Store is not the way around it

The entitlement IS offered for `STORE`, so the obvious move is to ship there.
That trade does not work, and the reason is not preference:
[distribution.md](distribution.md) marks the decision settled, and its load-bearing
reasons are structural. **The sandbox is mandatory on the App Store and Full Disk
Access does not lift it** — sandbox policy and `kTCCServiceSystemPolicyAllFiles`
are evaluated independently, so `~/Library/Mail`, `~/Library/Messages` and the
rest stay denied whatever the user granted. **A sandboxed app also cannot exec
`/usr/bin/osascript`**, which is the only subprocess in the runtime and the whole
write lane.

So taking the entitlement costs Mail, Notes, Reminders, Calendar, Contacts,
Messages, Safari and Maps — every write verb on every surface, and every file-lane
read. It buys live state and control on one. That is seven surfaces for one, and
it is not close.

### What the entitlement would actually buy

Worth stating precisely, because two thirds of the obvious case do not survive
contact with the probe's results:

| Claimed gain                         | Actually                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "names would no longer be encrypted" | **Moot.** Nothing is encrypted. The probe measured 115,466 B of legible text across 146 columns and **zero sealed** name-bearing blobs. There is no constraint here to dissolve. |
| "no Full Disk Access prompt"         | **Worth nothing incrementally.** Cupertino already requires the grant for seven surfaces, and it is indivisible. Home adds no permission cost whatsoever.                        |
| "live state, and control"            | **True, and it is the only real gain.** Live characteristic values never touch disk, so no amount of file reading reaches them, and there is no write lane at all.               |

One genuine benefit, purchasable only at a price that destroys the rest of the
app. That is the whole calculation.

Two things this does NOT rule out, kept honest: the private framework loads —
`dlopen` on `/System/Library/PrivateFrameworks/HomeKit.framework/HomeKit`
succeeds and `HMHomeManager`, `HMHome`, `HMAccessory`, `HMRoom`, `HMService` and
`HMCharacteristic` all resolve. But `homed` gates on the entitlement, and AMFI
validates `com.apple.developer.*` against the provisioning profile at launch, so
the expected result is a notarized app that ships fine and returns zero homes on
every user's Mac. That last step is **inferred, not measured** — settling it means
instantiating `HMHomeManager` under three signings, which may raise a TCC dialog.
Nobody has run it.

## Running the probe

`~/Library/HomeKit` is Full-Disk-Access gated, and **this repo's agent shell holds
no grant, so this probe is hand-run by design.**

1. System Settings → Privacy & Security → Full Disk Access → add your terminal
   (or the `node` binary).
2. **Fully quit and reopen the terminal.** The grant is read at process start, so
   a running shell keeps the old answer and the re-run looks identical.
3. `pnpm probe:home`, then `pnpm probe:home --json`.

It prints progress to stderr, so `--json` stdout stays machine-readable. Expect
the run to pause for 20 s at "live state": that is Q3 deliberately reading the
store twice, and `--twice=0` skips it. `--no-shortcuts` skips §9. Both are worth
passing on a first run.

The probe refuses to guess. It exits **3** with an actionable message in three
distinguishable states, because they are three different findings:

| State                                             | Meaning                                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/Library/HomeKit` absent                        | This Mac has never run HomeKit. A fact about the Mac, **not** a verdict about the surface.                                                         |
| EPERM, and the control stores are also unreadable | **BLIND.** A negative from here means nothing.                                                                                                     |
| EPERM, and the control stores read fine           | HomeKit sits behind a gate that is **not** Full Disk Access — the Contacts shape. `Permissions.swift` models only FDA and would owe a third state. |

To exercise the code path without a grant, copy the directory somewhere readable
and pass `--dir=<path>`, or point `--store=<file>` at one file. A caller-supplied
path is masked in the report: it is not the probe's to publish.

## What the probe measures

Nine questions, in the order [surfaces.md](surfaces.md) prescribes. The two worth
naming here:

**Q2, is the payload encrypted — the go/no-go.** HomeKit data is sensitive and
`homed` may well keep it sealed with a key in the keychain, which this repo does
not touch. The statistics live in [`scripts/lib/blob-stats.mjs`](../scripts/lib/blob-stats.mjs),
tested separately, because a wrong answer here kills a surface by arithmetic and
a verdict is just a word — it looks equally confident either way, and nobody
re-derives it by hand.

**Q5, the id bridge** home → room → accessory → service, scored by joining rather
than read off column names. A broken accessory→room hop is not a detail: it means
"turn off the kitchen" is unsayable, permanently.

## Rules this probe added

Two, both learned while building it, both worth carrying to the next surface.

**High entropy does not distinguish encrypted from compressed.** Both sit at
7.9–8.0 bits per byte. Measured: gzipped prose scores 7.983, real AES-CTR
ciphertext scores 7.980. Nothing separates them but a recognised container header
and a successful inflate, so `classifySamples` decompresses first and re-scores
the _inflated_ bytes. Without that step the single most likely outcome of this
whole exercise is killing a perfectly legible surface.

**A statistic's threshold must be measured against the null hypothesis at that
length, not fixed.** The first version of `blob-stats.mjs` called a blob
encrypted if its longest printable run was ≤ 6. Over 200 AES-CTR samples per
size, the median run is 6 at 512 B, 8 at 4 KB and **10 at 32 KB**, with a maximum
of 18 — so the flat rule reads a 32 KB ciphertext blob as legible. Entropy has
the same shape from the other side: 256 random bytes score 7.28, not 8, so a
classifier demanding 7.8 calls real ciphertext "unknown" at every small size.
Both thresholds are now expressed as a distance from what random data does at
that length.

**A schema mirror outscores the thing it mirrors.** The first real run picked
`core-cloudkit.sqlite` as the main store over `core.sqlite`, on a vocabulary
score of 131 to 127 — a four-point margin outranking a 27x difference in rows
(4,970 against 136,390). CloudKit names its mirror after the same entities with a
`CK` infix, so it ties or beats the original on every name-based metric while
holding a fraction of the data. Every downstream answer inherited it: the
`service -> accessory` hop was reported NOT FOUND because the mirror has no
service table, and `zone -> home` "resolved" at coverage 1.000 against
`ANSCKRECORDZONEMETADATA` — a CloudKit _record zone_, not a HomeKit zone. Rank by
rows in role-bearing tables, and never give sync bookkeeping a role.

**A cry-wolf list is not read.** The key-material scan used substring matching and
returned 27 columns per store, nearly all noise: `ZKEYUPDATEDTIME` is a date,
`ZSUPPORTSMATTERWALLETKEY` is a boolean, `ZDISMISSEDWALLETKEYUWBUNLOCKONBOARDING`
is a UI flag. It is now suffix-anchored and restricted to columns that could hold
a key at all — BLOB or TEXT — which is the same token-boundary lesson
`looksLikeDateColumn` already carries. This list is supposed to be the tell that
the surface is dead; it has to be short enough to believe.

A third, from the id bridge, is really the repo's existing rule in a new costume:
**a perfect join score can be a fictional relationship.** On the synthetic
fixture `ZSERVICE.Z_ENT` scored coverage 1.000 against `ZACCESSORY.Z_PK` and won
the hop, because every service carries entity id 4 and some accessory has primary
key 4. Core Data bookkeeping columns are now excluded by name, and ties break on
the number of DISTINCT parents reached — a constant column reaches exactly one
however perfectly it joins.

## Privacy

Stricter than any other probe here, and the reason is worth stating plainly.

**A list of someone's accessories is a map of their house** — how many rooms,
whether there is a lock and a camera, and when the bedroom light goes on. That is
a floor plan, a burglary window and a sleep schedule, and it is the most
sensitive thing any surface in this repo would hold.

So the probe reports schema, table names, column names, entity names, row counts,
null counts, value **lengths** and byte statistics, and nothing else. Blob
first-bytes are printed only when uniform across the sample or on a container
allow-list, because a magic that differs per row is user data or an IV. Shortcut
names are hashed. `-wal` and `-shm` are sized, never read. There is no `--term`
and no `LIKE` search, because constructing a needle here means naming something
in the house. Entity and table names _are_ printed, deliberately: they are
Apple's schema, identical on every Mac.

And `assertRedacted` walks the finished document and **fails the run** if a uuid,
MAC or email shape reached it. That is not theoretical. It has fired twice, and
the second time it found something that matters:

**A filename is data on this surface**, which is true of no other surface in this
repo. `~/Library/HomeKit` holds files **named after accessory MAC addresses**,
and the first granted run stopped dead rather than print them. A MAC identifies
one physical device and is geolocatable through public wifi databases, so a bare
directory listing here is already a partial inventory of a house — before a
single store is opened. Identifier-shaped names are now replaced by their shape,
and the COUNT is reported instead, because "N of M files are named after a
device" is the finding and the names add nothing to it.

(It fired the first time on a `--dir=` path containing a session uuid, which is
how the path masking above came to exist.)

## The control lane, and its hazard

`shortcuts run` executes arbitrary user-authored automation. On this surface the
side effect is **physical**: it can turn on a real light, unlock a real door, or
open a real garage.

So the probe never picks a shortcut, never runs one by heuristic, never runs "the
first Home-related one", and `--shortcut=` has no default. If the name given
matches the home vocabulary it refuses outright unless `--i-understand-real-devices`
is also passed. To time the CLI, create a shortcut containing a single `Nothing`
action, name it `Cupertino Probe No-Op`, and pass that.

Classifying a shortcut _without_ running it has three methods and the probe is
explicit about which it used:

1. **The name heuristic — weak, and labelled weak in the output.** It is a guess
   about an English string. Demonstrated on the probing Mac: of 11 shortcuts it
   flagged 0 as home-related, while the list visibly contains French ones naming
   a house. This repo's record on name-guessing is four failures on one store.
2. **`shortcuts view` — rejected**, and the rejection recorded. It opens
   Shortcuts.app and steals focus, the rudeness `appleEventsLane` already refuses.
3. **The actions themselves** — searching each shortcut's serialised workflow for
   `com.apple.HomeKitUI` / `is.workflow.actions.homeaccessory`, which are Apple
   constants and safe to print. This needs Full Disk Access too:
   `~/Library/Shortcuts` and `group.com.apple.shortcuts` are both EPERM without
   it, and the probe reports **"could not look"** rather than "found nothing".

If those workflow blobs turn out to be sealed, classification without running is
impossible and the escape hatch can only ever run the name the caller gave it —
a worse contract, still shippable, and it must not guess.

## Decision criteria

Set in advance, so the answer is not argued backwards from whatever the probe
prints.

**No-go — any one is fatal.**

| #   | Condition                                                                                                        | Why it ends it                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| N1  | Names, rooms and accessories read `ENCRYPTED`                                                                    | The key is in the keychain, not the file, and this repo does not touch the keychain. |
| N2  | The store does not open under Full Disk Access alone, or `homed`'s lock defeats both `mode=ro` and `immutable=1` | A surface whose grant Cupertino cannot ask for is not shippable.                     |
| N3  | No bridge from accessory to room or home                                                                         | A flat list of opaque device rows with no attribution is not a surface.              |
| N4  | Every candidate holds zero rows on a Mac with a configured home                                                  | The surface would work only on a subset of machines it cannot detect in advance.     |

**Go — all of.** The instrument check passed and the store opens `mode=ro` under
FDA · names are plaintext, or in a container this repo already decodes, with
coverage above ~0.8 · the chain resolves by declared foreign keys or scores
exact against an oracle · read cost is Safari-scale (tens of ms), not Mail-scale
· the epoch resolves, or the package withholds dates as `packages/maps` does.

**Conditional — shapes the package rather than blocking it.**

| Outcome                                    | Consequence                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live state present                         | `get_accessory_state` ships, with a freshness caveat: it is `homed`'s cache, not the device. Absent → a static inventory, `list_*` only, and honest about it. Both ship; they are different products.                                                         |
| Event history usable                       | One more tool. Not usable, or `-beta` churn → leave it out and _say so_, the way Safari reports `Downloads.plist` and never parses it.                                                                                                                        |
| WAL-blind                                  | Every count carries the caveat and `diagnostics` reports the open mode, as `packages/maps` does.                                                                                                                                                              |
| `shortcuts run` is `SILENT` and grant-free | The control escape hatch ships behind `allowWrites`, unstructured output, and an explicit physical-side-effect warning in the tool description. `PROMPTED` → `Permissions.swift` owes a new state. `REFUSED` from a child process → the surface is read-only. |

## Still open

Everything below the file lane is answered; what remains is listed here so the next person does not
have to reconstruct which questions were actually closed.

- **The Shortcuts control lane has never run.** `--no-shortcuts` was passed on every granted run, so
  section 9 of the probe has not executed once. Enumeration is free and needs no grant. Timing a run
  needs a hand-made shortcut containing a single `Nothing` action, named `Cupertino Probe No-Op`,
  passed as `--shortcut=`. Whether running one prompts for a grant decides whether the escape hatch
  is usable unattended, and whether `Permissions.swift` owes a new state.
- **Whether an accessory was actually toggled** during the 90-second live-state window is not
  recorded. If one was, configuration-only is settled outright. If not, the run shows only that an
  idle home does not write to disk, which is unsurprising. The structural evidence points the same
  way, so this is confirmation rather than a blocker.
- **Whether `homed` refuses an unentitled client is inferred, not measured.** The private framework
  loads: `dlopen` on `/System/Library/PrivateFrameworks/HomeKit.framework/HomeKit` succeeds and
  `HMHomeManager`, `HMHome`, `HMAccessory`, `HMRoom`, `HMService` and `HMCharacteristic` all
  resolve. The expectation that `homed` then hands back zero homes rests on AMFI validating
  `com.apple.developer.*` against the provisioning profile, not on a run. Settling it means
  instantiating `HMHomeManager` under three signings and may raise a TCC dialog. The file-lane GO
  does not depend on it.
- **`datastore3.sqlite` is unexamined.** 13.9 MB, not Core Data at all — a generic `record_v2` /
  `store_v2` store whose `model_data` and `external_data` are plain bplist. It holds nothing in
  role-bearing tables, so it is not the surface, but 13.9 MB of legible bplist is not nothing
  either.
- **The eight MAC-address-named bplist files have never been opened.** They are per-accessory, they
  are legible, and their names alone were enough to stop a report (see Privacy).

What is NOT open: the store is legible, Full Disk Access is sufficient, `core.sqlite` is the store,
the object graph resolves, the epoch is `apple-seconds`, and `eventstore-beta.sqlite` is unusable in
a v1 — no date column, integer keys that join nothing by reference, and a name Apple has labelled
beta.
