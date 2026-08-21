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

## Still open

- **The one extra store row** — 1,350 rows against 1,349 Apple Events events. All 1,350 are
  `entity_type` 2 with a start date, so it is a real event Apple Events did not list rather than a
  reminder hiding in the table. `CalendarItem.birthday_id` exists and is the obvious suspect.
- **Writes.** Still untested. Creating an event is a real side effect on a real calendar.
- **Calendar writability.** `Calendar` has no explicit writable column; it carries `flags`, `type`,
  `sharing_status`, `is_published` and `subcal_url`. Which of those marks a subscribed, read-only
  calendar needs measuring before a write tool refuses one.
