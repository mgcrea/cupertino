# Apple Calendar, measured

Measured by `scripts/probe-calendar.mjs` on macOS 26.6, 1,349 events across 8 calendars.
Regenerate on each new macOS release. Output is redacted: counts, timings, column names and DDL
only — no event titles, locations, attendees or calendar names.

**Conclusion: the inverse of Notes.** Notes shipped on Apple Events because search took 97 ms.
Calendar cannot: a ±90-day range query takes 3.4 s over 1,349 events, and the cost is per-round-trip
rather than per-event, so there is nothing to optimise from the caller's side. Calendar needs the
file lane for **speed**, not just capability — which makes where the store lives a blocking question
rather than a curiosity.

## The store, and a correction

`docs/distribution.md` previously concluded Calendar "probably needs EventKit rather than a file
lane", because `~/Library/Calendars` does not exist. The premise was right and the conclusion did
not follow: only one of the two candidate paths had been checked.

|                    |                                                                         |
| ------------------ | ----------------------------------------------------------------------- |
| Legacy path        | `~/Library/Calendars` — genuinely absent                                |
| **Actual store**   | `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb` |
| Size               | 4,956,160 bytes (plus `Extras.db`, 32,768 bytes)                        |
| Opened             | `mode=ro` in 1 ms                                                       |
| Schema fingerprint | `2bf4e34ff75f` — 168 objects, 46 tables                                 |
| Core Data style    | plain — no `Z_PRIMARYKEY`, so entities are read from table names        |

**Calendar does not need EventKit.** That matters beyond this surface: linking EventKit would have
put the first data framework into `apps/apple/`, which today is a pure broker, added a TCC grant, and
forked the two-lane design `packages/core` exists to hold in one place.

The lesson is the one `packages/core/src/fs.ts` already encodes: **absent and EPERM are different
findings**. Every other row in that table said EPERM. Calendar said "absent" because the probe looked
in one place.

## Apple Events is too slow to be the read lane

| Query                                | Time      | Result     |
| ------------------------------------ | --------- | ---------- |
| Range via `whose` (±90 days)         | 4.6–7.3 s | 47 hits    |
| **Range via bulk fetch + filter JS** | **3.4 s** | 47 hits    |
| Summary search across 1,349 events   | 3.4 s     | 1,115 hits |

Two findings inside that table.

**`whose` loses, again.** Notes measured `whose` at 6.9× slower on a text predicate; Reminders asked
whether a boolean predicate would behave differently. Here a _date range_ — the case most likely to
be pushed into the app — also loses, and loses unstably: three runs gave 4,564 / 5,290 / 7,303 ms
while the bulk scan held steady near 3.4 s. Pushing filters into Calendar.app is not the escape
hatch it looks like.

**The cost is per-round-trip, not per-event.** Every bulk property fetch on the busiest calendar
(742 events) cost roughly the same regardless of which property:

```
uid 1790 ms   summary 1785 ms   startDate 1769 ms   endDate 1806 ms
alldayEvent 2048 ms   location 1898 ms   description 1797 ms   status 1955 ms
recurrence 2201 ms   stampDate 1914 ms   excludedDates 1860 ms   url 1747 ms
```

~1.8–2.2 s each, flat. Reading twelve properties is ~22 s before any filtering. This is what makes
Calendar unlike Notes: Notes paid 0.105 ms per note and could amortise a bulk fetch; Calendar pays a
fixed toll per round trip that no amount of batching removes.

Projected, and it does not improve:

| Events  | Range query | Verdict  |
| ------- | ----------- | -------- |
| 1,000   | 2.5 s       | too slow |
| 5,000   | 12.4 s      | unusable |
| 20,000  | 49.7 s      | unusable |
| 100,000 | 248 s       | unusable |

## The id bridge is exact

|                    |                                                              |
| ------------------ | ------------------------------------------------------------ |
| Apple Events `uid` | a bare UUID                                                  |
| Store column       | **`CalendarItem.UUID`** — found by scanning 158 TEXT columns |
| Predicate check    | 1,350 store rows; **0 of 198 sampled uids missing**          |

The cleanest bridge of any surface probed. An event found in the index hands straight to Apple Events
for writes with no re-lookup, exactly as `ROWID` does for Mail and `Z_PK` for Notes. The extra store
row against 1,349 Apple Events events is unexplained and worth a look, but it is one row, not a
class of drift.

## Which table holds the events

Seven tables match `/event|occurrence|item/`, and the first one alphabetically — `EventAction` — is
empty and has no date columns at all. Ranking by rows finds the real one:

| Table                 | Rows  | Date columns |
| --------------------- | ----- | ------------ |
| `OccurrenceCacheDays` | 2,630 | none         |
| `OccurrenceCache`     | 1,946 | 4            |
| **`CalendarItem`**    | 1,350 | 18           |
| `SuggestedEventInfo`  | 15    | none         |
| `CalendarItemChanges` | 3     | 4            |
| `EventAction`         | 0     | none         |

`OccurrenceCache` and `OccurrenceCacheDays` out-row the real table, which is worth knowing before
writing a range query: expanded recurrences live there, and a naive `SELECT ... FROM CalendarItem`
will miss occurrences of a repeating event.

## Dates: `apple-seconds`, and a probe bug worth recording

`CalendarItem.last_modified` reads as seconds since 2001, latest 2026. `orig_date` likewise, latest 2024.

`start_date` and `end_date` initially reported `unknown`, and the reason is a lesson rather than a
detail. The probe's plausibility window assumed the newest row in a store is roughly _now_ — true for
mail, messages and browsing history, and **false for a calendar, which is largely a record of things
that have not happened yet**. `MAX(start_date)` reads as **2030**, which a "now-ish" window rejects.

The window also has to reject a genuinely degenerate case: dividing a seconds value by 1e9 collapses
it onto the 2001 anchor and produces a date that looks fine. Those two requirements pull in opposite
directions, and resolving them by narrowing the window broke the future-events case.

The rule that satisfies both: **reject any Apple-anchored reading landing within a day of the 2001
anchor, keep a generous window otherwise, and when several readings remain plausible take the one
closest to now.** Every wrong reading is off by decades; the right one is off by years at most.

Columns that report `no dates present` — `due_date`, `due_all_day`, `completion_date` — are the
reminder half of a schema Calendar and Reminders share. Empty here, not absent.

## What the permission buys — less than it first appears

| Capability          | Tables                                                 |
| ------------------- | ------------------------------------------------------ |
| Attachments         | `Attachment`, `AttachmentChanges`, `AttachmentFile`    |
| Conferencing        | `Conference`                                           |
| Sharing             | `Sharee`, `ShareeChanges`                              |
| Structured location | `Location`                                             |
| Travel time         | `CalendarItem.travel_time`, `travel_advisory_behavior` |
| Availability        | `CalendarItem.availability`                            |

**Attendees and alarms are NOT on that list, and that is a measurement.** The probe read 27 attendees
and 9 display alarms across 40 events over Apple Events, with no Full Disk Access. Calendar's
scripting dictionary is unusually complete — attendees, alarms and recurrence are all in it — so the
usual "the store buys you the rich stuff" argument is much weaker here than for Notes or Reminders.

Which is why the file lane is justified on **speed**, not capability. It is the only surface so far
where that is the primary argument.

## Recurrence, settled

Measured by the phase-0.5 additions to `scripts/probe-calendar.mjs`, on the same machine.

**The strategy is a two-leg hybrid**, and the set diff against Apple Events over ±90 days is clean:
**0 uids and 0 (uid, instant) pairs missing** from the store.

|                  |                                                                           |
| ---------------- | ------------------------------------------------------------------------- |
| Occurrence link  | `OccurrenceCache.event_id` -> `CalendarItem.ROWID`, resolves 100%         |
| Recurrence link  | `Recurrence.owner_id`; `ExceptionDate.owner_id`                           |
| Expansion window | `occurrence_date` spans **-732 to +724 days** from today, over 1,946 rows |
| Cache parents    | 489 of 1,350 items, of which **456 carry no recurrence rule**             |

Three findings inside that table, each of which changes the code.

**The cache is a real expansion, not a UI window.** Two years either side is far past anything a
month view needs, so `OccurrenceCache` can be trusted inside its edges. It is still an edge, and a
range query running past it must say so rather than return a short list — nothing here guarantees
the next machine's cache is as deep.

**The legs overlap, so dedupe is load-bearing rather than defensive.** 456 of 489 cached parents have
no `Recurrence` row at all, which means `OccurrenceCache` holds plain one-shot events as well as
expanded repeats. A union of "items with no recurrence rule" and "everything in the cache" therefore
double-counts most ordinary events. Dedupe on `(uuid, occurrence start)`.

**`OccurrenceCacheDays` is not an index into `OccurrenceCache`.** It is
`(calendar_id, store_id, day, count)` — a per-calendar per-day _count_, for badging a month view. It
has no row-level link to anything and cannot be used to prune a range query.

### Two traps this probe walked into first

**A dense primary key resolves against any other dense primary key.** The link detector initially
reported `Recurrence.ROWID` and `ExceptionDate.ROWID` as 100% resolving foreign keys to
`CalendarItem`. Both tables are `ROWID INTEGER PRIMARY KEY AUTOINCREMENT`, so their 1..N keys land
inside `CalendarItem`'s own 1..N rowids with a perfect score and no meaning whatsoever. The real
column is `owner_id` in both cases. A sole `INTEGER PRIMARY KEY` is now excluded from the scan — but
a _composite_ key is not, because `OccurrenceCacheDays.calendar_id` is genuinely a foreign key.

**"Extra in store" is not a defect signal.** The run reports 71 extra uids and 180 extra pairs, and
that is the expansion working. `cal.events` returns MASTER events, and the truth query filters them
by the master's own `startDate`, so a weekly meeting that began in 2023 contributes nothing to the
truth set while having real occurrences inside the window. The diff is evidence in one direction
only: _missing_ means the store cannot see something; _extra_ means it can see something Apple
Events cannot express.

## Timezones: two non-IANA values that mean opposite things

`start_tz` holds 8 distinct values across 1,350 rows, with no nulls and 409 all-day events. Two of
them are not IANA names:

- `_float` — a genuinely floating date, an instant deliberately without a zone.
- `GMT+0200` — a perfectly definite fixed offset that merely is not an IANA name.

Treating the second as floating would silently discard two hours. Anything matching `GMT±HHMM` is a
fixed offset to be honoured, and only what is left over is floating.

**All-day dates are derived in UTC, and the direction of that bug is measured rather than assumed.**
The stored value is anchored at midnight UTC, so reading it with local getters lands on the previous
day for every zone at a _negative_ offset — the whole Americas, not the eastern hemisphere:

```
TZ=America/Los_Angeles   local 2026-08-20   utc 2026-08-21   <- shifted
TZ=UTC                   local 2026-08-21   utc 2026-08-21
TZ=Asia/Kolkata          local 2026-08-21   utc 2026-08-21
TZ=Pacific/Auckland      local 2026-08-21   utc 2026-08-21
```

Reminders documents the mirror image of this for its own storage, which is anchored the other way
round. The direction is a property of the anchor, not a general rule, which is why it is measured per
surface. `packages/calendar/test/dates.test.ts` runs under all four zones.

## What the store does NOT hold

`CalendarItem` shares its schema with Reminders, and the reminder half is empty here: **0 rows with a
due date, 0 with a completion date, 0 without a start date.** `entity_type` is `2` on all 1,350 rows.
So there is one entity in this table and leg 1 needs no type predicate — though the column exists if
that ever stops being true.

`Extras.db` is closed out: 32 KB, 5 tables (`ZALARM`, `ZSETTING`, `Z_METADATA`, `Z_MODELCACHE`,
`Z_PRIMARYKEY`), a small Core Data store for alarms and settings. Nothing the server needs.

## A note on fingerprints

The probe reports `2bf4e34ff75f` and `apple_calendar_diagnostics` reports `cd2424fea732` **for the
same schema**. They are not comparable: `fingerprintSchema` in `packages/core` orders `sqlite_master`
by `type, name`, while `dumpSchema` in `scripts/lib/probe-kit.mjs` orders tables before indexes.
Reminders shows the same split (`510062aad004` at runtime against the `278b001e3c55` in its own drift
message and in [verify.md](verify.md)). Compare a probe fingerprint with a probe fingerprint.
Reconciling the two orderings is a one-line change in `packages/core` that moves the value for every
surface at once.

## What a live write trial found

Everything above was measured by reading. This section was measured by _writing_, on a scratch
calendar, and it changed the code five times — the shapes all compiled and all passed their unit
tests first.

### All-day events are stored at LOCAL midnight, not UTC

The single worst bug found. `renderInstant` derived an all-day day from UTC components, so on a
Paris machine every birthday was reported **one day early** — and the ref in the same result
disagreed with the day beside it:

```
ref occurrence 20260821T000000+0200   ->   start.day 2026-08-20
```

The reasoning behind it came from [reminders.md](reminders.md), which records that _Reminders'_
store holds UTC midnight while its Apple Events lane holds local midnight. That was generalised to
Calendar without measuring. The unit tests agreed because their fixtures were built on the same
assumption, and a four-timezone matrix passed while the surface was wrong for every user east of
Greenwich. **The anchor is a property of the store; measure it per surface.**

### Calendars cannot be addressed by uid over Apple Events

`calendar.uid()` throws `AppleEvent handler failed` (-10000) for **every** calendar, including one
this process had just created. The event id bridge is exact and was measured; it does not extend to
calendars, and assuming it did meant every write failed with `CALENDAR_NOT_FOUND` naming a UUID
Apple Events had never seen.

So calendars cross that boundary **by name**. Which makes duplicate names a real problem: this
machine has two calendars called `olouvignes@me.com`, and a write that matches more than one is now
refused rather than resolved by coin flip.

`writable()` is also the only reliable authority on read-only-ness. The store-derived signal
(`subcal_url` present) flags only `Fêtes (France)`, while Calendar reports `Birthdays` and
`Siri Suggestions` as unwritable too.

### Two write operations do not exist, and one lied about it

| Operation                | What Calendar actually does                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Exclude one occurrence   | `excludedDates()` reads back a **1903 sentinel**; assigning to it throws. Unusable. |
| Delete a repeating event | `C.delete(ev)` **neither throws nor deletes** — count before 1, after 1             |
| Delete a single event    | works                                                                               |

The exclusion script verified its own work and therefore _reported_ its failure honestly; the delete
script trusted "it did not throw" and reported `deleted: true` for an event still sitting on the
calendar. Delete now re-reads the uid list and decides by absence, and single-occurrence delete was
removed rather than left to fail — `delete_events` refuses an occurrence ref and says why, the same
shape as `update_event`.

Deleting a _calendar_ is not scriptable either (-10000). Creating one half-works: the calendar
appears, and the call still reports an error.

### Recurrence rules can be written

`ev.recurrence = "FREQ=WEEKLY;INTERVAL=1;COUNT=4"` is accepted and read back verbatim, and the store
expanded it into four occurrence rows within seconds — correctly across a DST boundary, with the
26 October instance at `+01:00` and the earlier ones at `+02:00`, wall-clock preserved. This unblocks
adding a `recurrence` parameter to `create_event`, which was held back pending exactly this test.

### Both legs can report the same all-day event

An all-day event created through the server came back **twice**, once per leg, same uid, both
rendering as the same day — `CalendarItem.start_date` and `OccurrenceCache.occurrence_date` do not
hold the identical number for one. The dedupe key now renders before comparing, so two all-day rows
for one uid on one day collapse whatever the columns disagree about underneath.

## iCloud, checked separately

The write trial above ran on a LOCAL calendar, which is not the same thing. iCloud calendars are
CalDAV-backed, so a second pass created, moved and deleted one event in a personal iCloud calendar.

|                              |                                                                |
| ---------------------------- | -------------------------------------------------------------- |
| Store sees a new event after | **0.2 s** — Calendar writes the local mirror first, then syncs |
| Timezone on a CET date       | correct: 15:00 Paris stored as `14:00Z`, rendered `+01:00`     |
| Cross-lane read-back         | exact, item leg, notes and location intact                     |
| Delete (non-repeating)       | works, and the verification confirms it                        |

So there is no sync latency to design around: the store is the local mirror and is written
synchronously. Nothing about iCloud needed different handling.

**It did find a bug that had nothing to do with iCloud.** Moving an event _later_ failed with

```
Failed to save event [...], with error
[{ NSLocalizedDescription = "The start date must be before the end date." }]
```

`applyFields` assigned `startDate` and then `endDate`, so pushing an event later left it momentarily
starting after it ended, and EventKit validates on save. The local trial never caught it because it
only ever changed a summary and a location, never a time. The order is now chosen from the event's
current end — end first when moving later, start first when moving earlier.

The same failure exposed a second problem: the new location had already been written before the
dates were refused, leaving the event half-updated. Apple Events has no transaction, so the fragile
assignment goes first — a date failure now changes nothing else — and `update_event` says so.

## Shared calendars

`sharing_status` is 1 on the calendars known to be shared and 0 or NULL elsewhere, so
`list_calendars` now reports `isShared`. Writing to one is visible to everyone else on it, which
nothing in the output previously said. The mapping is inferred from three observed values, so the raw
`sharingStatus` stays on the result.

Related, and measured: **`isSubscribed` is not a complete writability signal.** It is derived from
`subcal_url` and flags only URL-subscribed calendars, while `Birthdays` and `Siri Suggestions` report
`writable() === false` without one. The JXA lane asks Calendar directly and refuses correctly; its
bare error code is now re-inflated so the caller still gets the explanation.

## Still open

- **The all-day `end` convention.** Apple Events reads a one-day event's end back as
  `23:59:59` local (inclusive); the store renders a day later, and the two legs disagree with each
  other. A "subtract a second" normalisation was tried and proved a no-op on real data, which means
  `end_date` is anchored differently from `start_date` in a way not yet pinned down. `end` is
  reported RAW until the columns are read directly. Guessing twice on the same premise is what put
  the start-of-day bug here.
- **The one extra store row** — 1,350 rows against 1,349 Apple Events events. All are `entity_type`
  2 with a start date, so it is a real event Apple Events did not list. `CalendarItem.birthday_id`
  is the obvious suspect.
- **Status codes are inferred.** `status` and `invitationStatus` are read as EventKit's documented
  `EKEventStatus` / `EKParticipantStatus` constants. Likely, not measured — which is why cancelled
  and declined events are only hidden when asked for, and why the raw value is on every result.
- **`availability` is inferred too, and held to a stricter standard.** `EKEventAvailability.free`
  is 1, on the same reasoning. The difference is the direction a wrong reading fails in: misreading
  `status` hides an event that should have shown, misreading this one reports a booked hour as
  free. So `find_availability` does not apply it at all unless the caller passes
  `respectFreeMarking`, every event blocks time by default, and the raw value travels on the
  result. Measuring the column is the next probe worth running — `SELECT availability, COUNT(*)
FROM CalendarItem GROUP BY availability` against a calendar with a known free-marked event.
- **`hidden` and `phantom_master` are excluded conservatively** from both legs on the same basis.
- **`occurrence_date` vs `occurrence_start_date`.** Leg 2 reads `occurrence_date`, which spans the
  full ±2 years while `occurrence_start_date` reaches only +256 days.

## Free time is the complement, and that changes the error budget

`apple_calendar_find_availability` reports when nothing is on the calendar. Everything else on this
surface returns what it FOUND; this returns what it did not, and the inversion moves every shortfall
from harmless to dangerous.

The sentence above about the occurrence cache — "a short list of events is indistinguishable from a
free afternoon" — is the whole argument. A `list_events` call that misses a repeating meeting
returns nine events instead of ten, flags `truncated`, and the caller is under-informed. The same
miss inside an availability query does not shorten the answer: it fills the hour that meeting
occupies with a slot the model will happily book over.

So the busy set is complete or there is no answer. Three checks, each returning `degraded: true`
rather than a short list:

| Check                                                           | Why a short list would be a lie                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Scan bound** — either SQL leg returning exactly its `LIMIT`   | The limit cuts the TAIL of the window, so the later half of the week comes back uniformly free             |
| **Expansion** — `hasOccurrenceCache` false                      | A weekly meeting exists on the date its series starts and nowhere else, so every other week reads as empty |
| **Coverage** — the window running past `OccurrenceCache`'s edge | Past the edge repeating events are simply absent                                                           |

The third clips the window instead of refusing outright, because the part inside the edge is
genuinely answerable, and reports what it cut in `truncated`. The first two refuse.

Two smaller decisions follow the same rule, and both err toward saying "busy":

- **An all-day event does not block its day by default.** It is as often a birthday as a holiday,
  and blocking on every one would delete a working day. Ignoring them silently would book over a
  trip. So the day stays open and the events are reported in `allDayEvents` next to the slots. With
  `allDayBusy` on, the block is anchored on the day the event RENDERS on and closed at the later of
  the next midnight and the end column — because that column is the unsettled one above, and erring
  long hides a slot rather than inventing one.
- **Working hours are local wall clock**, built from local date components so they hold their
  numbers across a daylight-saving change. A day that loses an hour has one fewer hour in it, which
  is what actually happened. `APPLE_CALENDAR_TIMEZONE` is a render override and does not move them.
