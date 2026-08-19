# Spike: does an app's TCC identity cover the processes it spawns?

Answers step 1 of the app-hosted plan, and replaces step 0 of the order of work in
[../../docs/distribution.md](../../docs/distribution.md).

`native/launcher.c` exists to escape the MCP host's responsible-process chain using the private
`responsibility_spawnattrs_setdisclaim` SPI. If Cupertino is a running `.app`, there is nothing to
escape: the app is its own responsible process and so is everything beneath it. This spike is the
cheapest way to find out whether that is true before any of it is built.

**Verdict: it does.** Full Disk Access and Automation both land on the app bundle and are both
inherited by grandchildren, the grant survives re-signing, and it does not leak to processes
outside the app. `responsibility_spawnattrs_setdisclaim` is not needed under the app-hosted
design. Details below.

```sh
./build.sh          # compile + sign the throwaway bundle
./build.sh run      # launch through LaunchServices, tail the log
./build.sh reset    # revoke its TCC grants
```

Bundle id is `io.mgcrea.cupertino-spike`, deliberately **not** `io.mgcrea.cupertino`: TCC grants
are keyed to the identifier, and `docs/distribution.md` is explicit that the real one is the most
expensive string in the project.

## What it tests, and why in halves

| Half | Question | How |
| --- | --- | --- |
| 1 | Does the app itself hold Full Disk Access? | `access(2)` in `spike-main.c` |
| 2 | Do processes it spawns inherit it? | `Resources/spike.sh` → `node scripts/fda-probe.mjs` |

Half 2 is the one that matters: the real design never reads Mail from Swift, it reads it from a
`node` child. The child is deliberately a **grandchild** (app → `/bin/sh` → `node`/`osascript`),
because that is the real shape too.

`access(2)` and never `stat(2)`: `stat` succeeds on a TCC-protected file and only `open`/`access`
are denied, so a stat-based check reports success and proves nothing. Same exists-vs-readable
distinction that [packages/core/src/fs.ts](../../packages/core/src/fs.ts) encodes.

## Results, macOS 26.6 (Darwin 25.6.0), 2026-08-19

### Apple Events: confirmed, attributed to the app

`tccd` resolves a grandchild `osascript` to the app bundle, not to whatever launched it:

```
AttributionChain:
  responsible = {identifier=io.mgcrea.cupertino-spike, binary_path=.../Cupertino Spike.app/Contents/MacOS/cupertino-spike}
  accessing   = {identifier=com.apple.osascript, binary_path=/usr/bin/osascript}
  requesting  = {identifier=com.apple.mail}
```

`Application('Mail').accounts().length` returned 4 and `Application('Notes')` returned 1, through
two process levels, with the grant recorded against `io.mgcrea.cupertino-spike`:

```
service="kTCCServiceAppleEvents"
target_identifier="io.mgcrea.cupertino-spike"
target_csreq={identifier "io.mgcrea.cupertino-spike" and anchor apple generic and
              certificate leaf[subject.CN] = "Apple Development: Olivier Louvignes (493B6W4L7C)" ...}
```

**This is the finding the design needed.** Automation lands on the bundle, so it does not need the
disclaim SPI.

### Full Disk Access: confirmed, and scoped to the app

Negative control first — before the grant, both halves correctly deny:

```
half1 app reads Envelope Index: NO — errno=Operation not permitted
tccd: kTCCServiceSystemPolicyAllFiles ... ReqResult(Auth Right: Denied (Service Policy))
{"readable":false,"errno":"EPERM","sizeBytes":437256192, ...}
```

`readable:false` alongside `sizeBytes:437256192` is the exists-vs-readable split working.

After granting FDA to `Cupertino Spike.app` and nothing else:

```
half1 app reads Envelope Index: YES
file lane rc=0
{"readable":true,"errno":null,"sizeBytes":437256192,"execPath":"/opt/homebrew/Cellar/node@24/24.18.0/bin/node"}
```

**Children inherit it.** That `readable:true` is a `node` grandchild (app → `/bin/sh` → `node`).

And the grant is scoped to the bundle, not to the machine — the identical node binary running the
identical script from a normal shell, seventeen seconds later, is still denied:

```
$ node scripts/fda-probe.mjs
{"readable":false,"errno":"EPERM", ...}   rc=3
```

That is precisely the property `native/launcher.c` was written to obtain, reached without the
private SPI.

### The real code path works, not just the toy probe

`scripts/probe-envelope-index.mjs` run as a child of the app:

```
LOCATE   via accountDirectory : ~/Library/Mail/V10
         via V* glob          : ~/Library/Mail/V10      agree: yes
INDEX    full disk access     : GRANTED
         open mode=ro         : 181596 msgs, MAX(ROWID)=198887 (7 ms)
         open immutable=1     : 181595 msgs
         immutable skips WAL  : yes   <-- confirms mode=ro must be the default
SCHEMA   missing required     : none
```

Both branches of the four-branch ladder in `packages/mail/src/client/locate.ts` agree, and the
`mode=ro` → `immutable=1` ladder in `packages/core/src/sqlite.ts` behaves as designed.

### The grant survives re-signing

The bundle was recompiled and re-signed between runs — a different content hash for the main
executable — and the FDA grant held with no re-grant. The designated requirement is identifier +
certificate, not content hash.

This is the "grant-survives-updates payoff" that `docs/distribution.md` says everything depends
on. It holds.

### Incidental finding: the Envelope Index schema has drifted

The probe reports fingerprint `67a632b37d2b`. `docs/envelope-index.md` records `77aa2cd3a55b`.

Benign so far — `missing required: none`, so the drift detection in
`packages/mail/src/client/schema.ts` does not trip — but the documented fingerprint and the
`packages/mail/test/fixtures/envelope-index.sql` capture are both from the older schema and should
be refreshed with `probe-envelope-index.mjs --write`.

## Unexplained, and deliberately not chased

After `tccutil reset AppleEvents io.mgcrea.cupertino-spike` the Apple Events lane still succeeded
with **no consent prompt**. This machine runs other automation agents (`com.openai.sky.CUAService`
appears in the same `tccd` log requesting AddressBook/Calendar/Reminders), so a
profile- or MDM-level policy is the likely cause.

It does not affect the architecture — attribution is what was being tested, and that is confirmed
either way — but it means **the first-run consent UX is unverified on this machine** and has to be
checked on a clean one, alongside the Gatekeeper/quarantine test.

## Team ID correction

`docs/distribution.md` records "team `493B6W4L7C`". That string is the member ID inside the
certificate's Common Name, not the Team ID:

```
subject= UID=TR3EJ6K7E2, CN=Apple Development: Olivier Louvignes (493B6W4L7C),
         OU=75QE9PRT3V, O=Magenta Creations, C=US

codesign: TeamIdentifier=75QE9PRT3V
```

The Team ID is **`75QE9PRT3V`** (the `OU`), and that is what a team-based designated requirement
would pin. Worth fixing before the identifier ships, since a wrong DR is the same class of
mistake as a wrong bundle id.

## Reading the tccd log

`log` is shadowed in the interactive shell — use the absolute path:

```sh
/usr/bin/log show --last 20m --process tccd --info --debug > /tmp/tccd.txt
grep -i cupertino /tmp/tccd.txt | grep -iE "AttributionChain|Auth Right"
```
