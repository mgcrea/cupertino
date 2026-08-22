# Apple Contacts, measured

Measured by `scripts/probe-contacts.mjs` on macOS 26.6, 421 contacts across 2 stores, cross-checked
against 958 handles and 69,705 messages in `chat.db`. Regenerate on each new macOS release. Output is
redacted: counts, timings, lengths, shapes, column names and DDL only — no names, no phone numbers, no
email addresses, no postal addresses, no notes, and no handles.

**Built. `packages/contacts` ships the file lane and the resolver** — see the end of this document
for what landed. Conclusion when it was written, unchanged since:

**Build it, file lane only, and it unblocks Messages.** Contacts was probed as a
dependency rather than as a surface anyone asked for. `docs/messages.md` settled that Messages is
buildable; it did not settle whether the output would be readable, because `chat.db` stores a
correspondent as `+15551234567` and nothing else. That question now has a number: **97.6% of the last
year's messages resolve to a name**, using a nine-digit suffix match. Contacts also turns out to be
cheap — the schema is small, the queries are instant, and no Apple Events read lane is needed.

## The store is not where it looks like it is

| Store                                   | Contacts | Rows | Phones | Emails | Fingerprint    |
| --------------------------------------- | -------- | ---- | ------ | ------ | -------------- |
| `AddressBook-v22.abcddb` (root)         | **1**    | 2    | 0      | 0      | `4f2871e93f6b` |
| `Sources/<uuid>/AddressBook-v22.abcddb` | **420**  | 425  | 970    | 300    | `4f2871e93f6b` |
| Apple Events (`Contacts.people()`)      | **421**  | —    | —      | —      | —              |

Unioned, the file lane reports 421 contacts against Apple Events' 421. Exact.

All under `~/Library/Application Support/AddressBook/`. The root database opens `mode=ro` in 0 ms and
holds **one contact**. Everything else is in the per-account source.

**A server must enumerate `Sources/*/` and union**, and the count of sources is not known ahead of
time — one here, more on a machine with Google or Exchange accounts. This is the first surface whose
store is plural, and it is worth stating plainly because reading the obvious path returns a database
that is present, readable, correctly shaped, and empty. The two stores share a schema fingerprint, so
the union is a union of rows, not of shapes.

`~/Library/Group Containers/group.com.apple.contacts/` exists and holds `ContactsMetadata/` and
`Library/`, neither of which is a contact store.

### `ZABCDRECORD` is not a table of contacts

It is a Core Data **single-table inheritance root**, and `Z_ENT` is the only thing separating what
lives in it:

| Z_NAME          | Rows here |
| --------------- | --------- |
| `ABCDContact`   | 420       |
| `ABCDGroup`     | 3         |
| `ABCDInfo`      | 1         |
| `CNCDContainer` | 1         |

So `SELECT COUNT(*) FROM ZABCDRECORD` returns 425 for a 420-contact store, and a list tool written
against it returns the user's groups as if they were people. Filter to `ABCDContact` and
`ABCDSubscribedContact`, **resolved through `Z_PRIMARYKEY` by name rather than by number** — Core Data
assigns `Z_ENT` per model version, so today's 22 is not a constant.

This corrected an earlier reading of this document, which recorded a six-record gap between the stores
and the live count and guessed at linked duplicates. There is no gap. The four extra rows were never
contacts.

## Contacts has its own permission, and it prompts

This is the finding with consequences outside this document. With no Full Disk Access:

| Store                                | `stat` | `access(R_OK)` | `open` |
| ------------------------------------ | ------ | -------------- | ------ |
| Calendar / Messages / Safari / Notes | ok     | EPERM          | EPERM  |
| **Contacts**                         | ok     | **ok**         | EPERM  |

Contacts sits behind its own TCC service rather than behind the whole-disk grant, and its enforcement
lands on `open` while letting `access` through. Two consequences:

- **`access(2)` is not a readability test.** `scripts/lib/probe-kit.mjs`'s `readable()` used it, so the
  helper written to escape the `stat` trap had walked straight into the next version of it and reported
  this store as readable when nothing could open it. Now fixed to open the file, with an `EISDIR`
  fallback because Reminders' store path is a directory.
- **It asks.** Full Disk Access must be granted by hand in System Settings and never prompts; the
  Contacts grant prompts on first touch. That is a materially better permission story than the one the
  rest of the app has — and it is a grant `apps/apple/Cupertino/Permissions.swift` does not model, the
  second such gap after Safari's "Allow JavaScript from Apple Events" toggle.

**Unsettled:** whether Full Disk Access alone opens this store, or whether the Contacts grant is also
required. A process holding the Contacts grant and no FDA reads it fine — that direction is measured.
The other direction is not, because constructing a process with FDA and no Contacts grant was not
attempted. Assume nothing here until it is checked; `Surfaces.swift` would otherwise report a healthy
surface that cannot read.

## The number: 97.6%, not 27.6%

Both are true and they answer different questions. 783 phone handles appear in `chat.db` against 421
contacts, and one vote per handle is dominated by people who sent one message years ago — **321 handles
sent exactly one message, and 73 sent none at all.**

| Strategy          | resolved | ambiguous | by handle | by message | **last 365d** | top-25 | top-100 |
| ----------------- | -------- | --------- | --------- | ---------- | ------------- | ------ | ------- |
| exact             | 102      | 1         | 13.0%     | 3.7%       | 8.5%          | 16%    | 29%     |
| digits            | 194      | 5         | 24.8%     | 95.9%      | 96.7%         | 84%    | 72%     |
| last-10           | 194      | 5         | 24.8%     | 95.9%      | 96.7%         | 84%    | 72%     |
| **last-9**        | **216**  | **6**     | 27.6%     | 96.2%      | **97.6%**     | 84%    | 74%     |
| last-7            | 216      | 6         | 27.6%     | 96.2%      | 97.6%         | 84%    | 74%     |
| `ZLASTFOURDIGITS` | 223      | **28**    | 28.5%     | 95.5%      | 97.2%         | 80%    | 68%     |
| email             | 37       | 0         | 61.7%     | —          | —             | —      | —       |

This is the same shape as Safari's 60.7%, which was measured over **open tabs** rather than over all
7,797 history rows. The working set is the honest denominator; the unweighted rate measures how many
strangers are in the address book, which is a fact about the address book and not about the product.

**Use `last-9`.** It matches `last-7` in every column, so there is no reason to take the shorter and
more collision-prone key — a rare finding where the safer option costs nothing. It also beats exact
matching by a factor of twenty-six on message volume, which says something worth remembering:
**the busiest contacts are stored formatted, not in E.164.** Exact string equality resolves 3.7% of
traffic. A server that joins on the stored string is not slightly wrong, it is useless.

`ZLASTFOURDIGITS` is Apple's own caller-ID index and looks like the winner on raw hits. It is not:
**28 ambiguous against last-9's 6.** Four digits over 970 numbers collide, so it is a cheap prefilter
to be confirmed against full digits, never an answer on its own.

### The caveat that survives

**top-25 is 84%, not 97.6%.** Weighting by message volume is dominated by a handful of enormous
conversations; listing the twenty-five busiest correspondents leaves about four showing a bare number.
So "unknown sender" is not the common case, but it is a real output state and every tool that renders a
correspondent must have one. It is not an error and must not be reported as one.

Email resolves at 61.7% over 60 handles — a small sample, and the only clean signal in the table
(zero ambiguous), since email addresses are stored as typed and compared case-insensitively.

## Phone numbers are stored as typed

`ZABCDPHONENUMBER`, 970 rows. Shapes over a 400-row sample of `ZFULLNUMBER`:

| Shape     | Count | Example form     |
| --------- | ----- | ---------------- |
| formatted | 222   | `06 12 34 56 78` |
| e164      | 159   | `+33612345678`   |
| digits    | 15    | `0612345678`     |
| short     | 4     | shortcodes       |

Only about 40% is already normalized, which is the whole reason the join needs a suffix key. The
national-vs-international split is exactly why `last-10` does no better than plain digits and `last-9`
does: a number stored `06…` is ten digits, the same number as a handle is `+336…` at eleven, and they
first agree nine digits from the end.

Also on the table: `ZLASTFOURDIGITS` (populated on every sampled row), `ZLABEL` (the "home"/"work"
label, free text), and `ZUNIQUEID`.

## Apple Events works, and is not the read lane

Contacts is scriptable and, unlike Messages, it answers. Warm, over 421 people:

| Call                    | Time   |
| ----------------------- | ------ |
| `people()`              | 72 ms  |
| `people.id()`           | 73 ms  |
| `people.name()`         | 137 ms |
| `people.phones.value()` | 52 ms  |
| `myCard()`              | 8 ms   |

The first `people()` of a cold Contacts costs ~3 s because it materialises objects; every later call is
tens of milliseconds.

**It is still not a read lane.** `docs/distribution.md`'s policy is that new surfaces get file-lane
reads and nothing else, and nothing here argues against it: the file lane opens in 0 ms, sees all 425
records, and is the only lane that can answer the resolution join at all — Apple Events cannot return
970 phone numbers keyed for suffix matching without shipping the address book through `osascript`.

What Apple Events earns instead is **one line in diagnostics**: an independent count to check the file
lane against. That is not a hypothetical. The first granted run of this probe reported 0% resolution
across every strategy, and the reason it was caught rather than written down is that Apple Events said
421 where the file lane said 2.

## Schema and the rest

94 objects, 34 tables, fingerprint `4f2871e93f6b`. Plain Core Data with the `Z` prefix, unlike
Calendar's bare table names.

| Question       | Answer                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------- |
| Entities       | `ZABCDRECORD`, `ZABCDPHONENUMBER`, `ZABCDEMAILADDRESS`, `ZABCDPOSTALADDRESS`, `ZABCDNOTE`     |
| Search index   | `ZABCDCONTACTINDEX`                                                                           |
| Epoch          | apple-seconds — `ZCREATIONDATE` / `ZMODIFICATIONDATE` / `ZLASTSYNCDATE`, latest 2026          |
| Yearless dates | `ZCREATIONDATEYEARLESS` / `ZMODIFICATIONDATEYEARLESS` anchor at 2001 — birthdays with no year |
| The "me" card  | `ZCONTAINERWHERECONTACTISME`, 1 row                                                           |
| Linked records | `ZLINKID`, `ZPREFERREDFORLINKNAME`, `ZPREFERREDFORLINKPHOTO`                                  |
| Containers     | `ZCONTAINER`, `ZCONTAINER1`, `ZCONTAINER2`, `ZLASTDOTMACACCOUNT`                              |

`ZLINKID` matters for output: Contacts shows one unified card for a person who exists in two accounts,
and a resolver without it hands back two names for one handle. The six-record gap between the union and
the live count is the first place to look.

Schema fixture captured: `packages/contacts/test/fixtures/contacts-store.sql`, 94 objects, no rows.

## Two probe bugs, recorded because both were silent

Neither produced an error. Both produced a plausible number.

**The empty-store bug.** The first granted run reported 0% resolution across all five strategies. The
probe read the root database, which holds two records, so every query below the layout section ran
against an empty `ZABCDPHONENUMBER`. A 0% from an empty table is indistinguishable from a 0% from
numbers that fail to match. Fixed by opening every store, choosing the primary by record count, and
unioning — no store is privileged by its path.

**The epoch object bug.** `aggNumericAsText` returns `{raw, digits, value, exceedsSafeInteger}`, and
passing the whole object to `detectEpoch` makes it call `Number()` on an object, get `NaN`, and report
"no dates present" — for a `ZCREATIONDATE` populated on all 425 rows. This is the same shape as the
swallowed BigInt throw in [messages.md](messages.md): a section written to catch a silent error being
silently wrong itself. It survived one full granted run.

The generalisable rule, and the reason both are written down: **a surprisingly bad measurement is a
bug until proven otherwise.** Three of the four surprising numbers this probe produced were defects in
the probe, not findings about the store.

## Still open

- **Whether Full Disk Access alone opens this store.** Measured in one direction only. Decides whether
  the app needs a permission state it does not model.
- **`ZLINKID` and unified contacts.** Counts now reconcile exactly, so there are no stray duplicates
  to explain — but a person held in two accounts still resolves to two records, and collapsing them is
  unmeasured.
- **`ZCOUNTRYCODE` / `ZAREACODE` / `ZLOCALNUMBER`** are decomposed parts sitting beside `ZFULLNUMBER`,
  and `ZADDRESSNORMALIZED` beside `ZADDRESS`. If populated they beat suffix matching outright. Their
  fill rate was not measured.
- **A machine with more than one source.** Everything about the union is inferred from a single
  account. Google and Exchange accounts are where a second source would appear, and the assumption that
  sources share a schema fingerprint is untested across account types.
- **The unresolved busiest correspondents.** About four of the top twenty-five do not resolve; whether
  they are businesses, second numbers, or contacts genuinely absent from the address book is unknown,
  and it decides whether 84% is a floor or a ceiling.
- **The live write trial has not been run.** The write lane is built and its scripts compile, but no
  contact has been created or edited on a real machine yet. Two things it must settle: whether
  `ZUNIQUEID` and `person.id()` are the same string (the code does not assume it — see below), and
  whether `save()` persists on an iCloud account without a Contacts window open.
- **`ZABCDCONTACTINDEX`** is named but unexamined. It is Apple's own normalized search index and may
  make text search cheaper than a `LIKE` over `ZABCDRECORD`.

## What was built

`packages/contacts` — `@mgcrea/mcp-apple-contacts`, five read tools, no write tools, no Apple Events
lane, 54 tests.

| Tool                             | Notes                                     |
| -------------------------------- | ----------------------------------------- |
| `apple_contacts_resolve_handles` | the reason this exists; batches up to 500 |
| `apple_contacts_search_contacts` | name, nickname, organisation              |
| `apple_contacts_list_contacts`   | the whole book, unioned                   |
| `apple_contacts_get_contact`     | one card with every number and address    |
| `apple_contacts_diagnostics`     | which stores opened, and the caveats      |

`resolveHandles()` is exported from the package root as well, because `packages/messages` holds
handles and needs names, and reaching a function in the same workspace through MCP would be absurd.

Four measurements are load-bearing in the code and each is pinned by a test:

- **The store is plural**, so `locate.ts` returns a list and every query fans out. Verified on the
  real machine: `stores=2/2, contacts=421` — matching Apple Events exactly.
- **`Z_ENT` filters to `ABCDContact`**, resolved through `Z_PRIMARYKEY` by name. Without it a list
  tool returns the user's groups as people.
- **Nine-digit suffix keys**, and the key length travels inside the lookup object so the index and the
  query cannot diverge. A self-join over the real address book at 7, 9 and 10 digits confirms the
  choice: 7 and 9 collide identically (10 of 947 keys, 1.1%), and 10 drops a key while losing the
  national-to-E.164 join.
- **Ambiguity is a status, never a guess.** `resolved` / `unknown` / `ambiguous` / `shortcode`, with
  `unknown` documented in the tool description as expected rather than as an error.

The lookup builds in **3 ms** over 947 phone keys and 295 email keys, so it is built on first use and
kept for the life of the process.

### Not registered as an app surface

The package runs standalone (`node packages/contacts/dist/cli.js`) and is deliberately NOT in
`Surfaces.swift`, the Makefile, CI or the website. Three reasons, all of which are decisions rather
than oversights: the surface list is hardcoded in ten places and `surfaces.md` says to generate it
from a manifest before adding a fifth; the published price ladder ties rungs to Messages and Safari,
not to Contacts; and Contacts may be better shipped as part of Messages than as a surface of its own,
since resolving handles is what it is for.

## Writes, added afterwards

Contacts shipped read-only and gained two write tools later, which reversed a decision this document
had recorded. What that cost, stated plainly: **this surface no longer needs zero permissions.** Reads
are still file-lane and prompt for nothing, but a write is an Apple Event, so the first one asks for
Automation access to Contacts — and the app's consent string now names it. With `allowWrites` off,
nothing in the server sends an Apple Event and the old property still holds exactly.

Writes go through Apple Events because they have to: the store is opened `PRAGMA query_only` on every
surface here, since Contacts owns it and reconciles it against iCloud.

### The dictionary is four verbs

Measured from `sdef /System/Applications/Contacts.app` on macOS 26.6:

| Command  | What it does                             |
| -------- | ---------------------------------------- |
| `make`   | create a person, or a phone/email on one |
| `add`    | put a person in a group                  |
| `remove` | take a person OUT OF A GROUP             |
| `save`   | commit everything                        |

That is the entire list, across all three suites — the Standard Suite here contains only `make`.

**The string "delete" appears zero times in the dictionary.** So there is no `delete_contacts` tool,
and there is no delete script to add one from. `remove` is about group membership, not deletion.
Whether Cocoa Scripting answers an undeclared `delete` event anyway is a separate and unmeasured
question, and guessing at it would risk destroying a real person's card on the strength of an
assumption. A test asserts no script contains the word.

### `save` is explicit, and global

This is the finding that makes Contacts unlike Calendar and Reminders, where assigning a property
persists immediately. Contacts holds edits in an unsaved buffer — the application class even carries
an `unsaved` property — and `save` is documented as "Save **all** Contacts changes".

Two consequences, both in the code:

- **A write that forgets `save()` silently does nothing**, and its own read-back agrees, because the
  live object really did change. Every script saves and _then_ re-reads; a test pins that ordering.
- **`save()` is not scoped to our change.** It commits whatever else is pending, including an edit
  someone has half-typed in the Contacts window. Both tool descriptions say so.

### The id bridge is not assumed

The file lane holds `ZABCDRECORD.ZUNIQUEID`; Apple Events addresses people by whatever `person.id()`
returns. That those agree is unmeasured, and this project has been wrong about exactly this before —
Calendar's event id bridge was exact at 198/198 while `calendar.uid()` threw for every calendar.

So `findPerson` tries `byId()` first and falls back to a bulk `people.id()` fetch matched on the UUID
substring. That fallback is affordable precisely here: the whole id list measured 63–73 ms over 421
people, against the 1.8 s that made the same trick unusable for Calendar's events. A mismatch in id
_form_ therefore costs one extra round trip instead of producing a wrong "not found", which is the
failure that looks like the contact was deleted.
