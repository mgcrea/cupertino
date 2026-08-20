# Apple Reminders, measured

Phase-0 probe output from `scripts/probe-reminders.mjs`, macOS 26.6 (25G72), 317 reminders across
12 lists in 1 account. Re-run it before trusting any of this on a different release.

The headline: **Reminders is the first surface where the scripting dictionary is nearly complete on
its own** — and also the first where reading it is slow enough that the index lane earns its place
twice over.

## The scripting dictionary

`/System/Applications/Reminders.app/Contents/Resources/Reminders.sdef`, 3 classes, all read-write:

| Class      | Properties                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `account`  | `id`, `name`; elements `list`, `reminder`                                                                              |
| `list`     | `id`, `name`, `color`, `emblem`, `container` (account **or list** — lists nest)                                        |
| `reminder` | `name`, `body`, `completed`, `completion date`, `due date`, `allday due date`, `remind me date`, `priority`, `flagged` |

## Three things that are not what they look like

### 1. A reminder cannot be moved

`reminder.container` is `access="r"`. There is no assignment that relocates a reminder, so
`move_reminders` is **copy-then-delete**: the reminder gets a new id and a new creation date, and
the original is destroyed only after the copy is read back. The tool says so in its description,
because a silently invalidated ref is a caller's problem.

### 2. Both due-date properties are always populated

| Reminders with…      | Count   |
| -------------------- | ------- |
| a `due date`         | 144     |
| an `allday due date` | 144     |
| **both**             | **144** |

The sets are identical. So "an allday due date is set, therefore it is all-day" marks **every**
dated reminder as all-day, and Apple Events cannot answer the question at all.

`ZREMCDREMINDER.ZALLDAY` in the store can. Without it the server falls back to asking whether the
due time is local midnight — computed inside JXA where the time zone is real — and labels the
answer `dueAllDaySource: "heuristic"` so a caller knows what it got. A reminder deliberately set to
00:00 defeats the guess; `store.test.ts` pins both directions.

### 2b. The two lanes disagree about what an all-day date is

The same reminder, due 9 November, read from each lane:

| Lane                             | Value                  | Means          |
| -------------------------------- | ---------------------- | -------------- |
| Apple Events (`allday due date`) | `2025-11-08T23:00:00Z` | LOCAL midnight |
| index (`ZDUEDATE`)               | `2025-11-09T00:00:00Z` | UTC midnight   |

Both mean the 9th. Timed reminders in the same library are true instants on
both lanes (`2025-11-26T15:40:00Z` for a 16:40 Paris pickup), so it is
specifically the all-day representation that differs.

Three consequences, and each was got wrong once before being measured:

- **Reporting an all-day reminder as an instant is wrong, not just ugly.** The store's value renders
  as 01:00 in Paris and as **8 November** in New York. So `due` is emitted as a bare `2025-11-09`
  when `allDay` is set — the day it names, identical everywhere, and valid input to the write tools,
  where a bare date means all-day.
- **Neither lane's string can be sliced by the other's rule.** Slicing the UTC ISO is correct for
  the store and lands a day early for Apple Events. Each lane converts on its own terms: JXA formats
  from local components, the store from UTC.
- **The fallback heuristic reads LOCAL midnight**, because that is the convention of the lane it
  reads. It was briefly "fixed" to UTC on the strength of the store's value alone, which would have
  reported every all-day reminder as timed for anyone east of Greenwich.

`lanes.test.ts` encodes the disagreement in its fixture and asserts both lanes report the same day.
That cross-lane check is the only one that catches this class of bug; testing either lane alone
passes happily while the other is a day out.

### 3. Subtasks are unreachable over Apple Events

`reminder.container` is typed "list OR reminder", which reads like subtasks are addressable. They
are not: `container()` **threw on 60 of 60 attempts**. `ZREMCDREMINDER.ZPARENTREMINDER` and
`ZCKPARENTREMINDERIDENTIFIER` are the only way to know a reminder has a parent.

Subtasks are still _listed_ — `R.reminders()` returns all 317 — they just arrive with no parent.

## Timings

Every bulk property fetch is one Apple Event and costs the same regardless of library size:

| Operation                          | Time    |
| ---------------------------------- | ------- |
| one bulk property fetch            | ~700 ms |
| twelve properties (a full listing) | ~8.5 s  |
| `whose completed = false`          | 995 ms  |
| bulk fetch + filter in JS          | 848 ms  |
| `whose name contains`              | 2286 ms |
| bulk name+body + filter in JS      | 1574 ms |

**`whose` loses on booleans too.** Notes measured it 6.9× slower for a substring match; the open
question was whether a boolean predicate could be pushed into the app. It cannot — 995 ms against
848 ms. Filtering in JS is right on both surfaces, now for measured reasons rather than one
extrapolated one.

Projected at scale, with no index: 1,000 reminders ≈ 5 s, 10,000 ≈ 50 s. The list-membership walk
was one Apple Event per list until it was replaced by the chained `R.lists.reminders.id()` fetch,
which does it in one; the per-list form survives as a fallback and the script reports which ran.

## The store

    ~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/Data-<UUID>.sqlite

Four `.sqlite` files were present; the real one was 5.3 MB and the other three 733 KB each,
including a `Data-local.sqlite`. **Largest readable wins** — picking whichever `readdir` returned
first would be a coin flip between them.

Unlike Notes, the filename carries a generated UUID, so _locating_ the store requires listing a
TCC-protected directory. Without Full Disk Access there is not even a path to `stat`, which is why
`locateStore` distinguishes "cannot list the container" from "listed it, found nothing" — those
need different fixes.

Fingerprint `278b001e3c55`, 26 tables, 148 objects, epoch offset 978307200.

### The id bridge

Apple Events returns `x-apple-reminder://<uuid>`. Scanning **all 139 TEXT columns** for a real id —
rather than guessing a column name — found:

| Column                                           | Match     |
| ------------------------------------------------ | --------- |
| `ZREMCDREMINDER.ZCKIDENTIFIER`                   | bare uuid |
| `ZREMCDREMINDER.ZDACALENDARITEMUNIQUEIDENTIFIER` | bare uuid |

The first is the bridge. Guessing would have been plausible and unverifiable; this is neither.

### Which rows are reminders

Compared as **ID sets** against Apple Events, not counts — a matching count is not evidence, which
is how the Notes body decoder passed at 51% accuracy.

| Predicate                  | Rows    | Missing | Extra |
| -------------------------- | ------- | ------- | ----- |
| all rows                   | 338     | 0       | 21    |
| `ZMARKEDFORDELETION` falsy | **317** | **0**   | **0** |

### What the permission buys

| Capability      | Where                                                  | Verdict                           |
| --------------- | ------------------------------------------------------ | --------------------------------- |
| all-day flag    | `ZREMCDREMINDER.ZALLDAY`                               | **correctness**, not just speed   |
| subtasks        | `ZREMCDREMINDER.ZPARENTREMINDER`                       | unreachable otherwise             |
| attachments     | `ZREMCDSAVEDATTACHMENT` → `Container_v1/Files`         | metadata confirmed; 2 files seen  |
| alarms          | `ZREMCDOBJECT.ZALARMUID`, `ZTRIGGER`                   | present                           |
| recurrence      | `ZREMCDOBJECT.ZFREQUENCY`                              | present                           |
| location alerts | `ZREMCDOBJECT.ZLATITUDE` / `ZLONGITUDE` / `ZPROXIMITY` | present                           |
| smart lists     | `ZREMCDBASELIST.ZSMARTLISTTYPE`, `ZFILTERDATA`         | type readable, filter is a blob   |
| listing speed   | `ZTITLE` / `ZNOTES` indexed locally                    | ~9 s of Apple Events avoided      |
| **url**         | —                                                      | **absent; the folklore is wrong** |

`ZREMCDOBJECT` is polymorphic — alarm and recurrence rows share it, told apart by which columns are
populated. So the server reports presence and counts rather than reconstructing an RFC 5545 rule
from columns nobody has documented.

## Still open

- **Tag association.** `ZREMCDHASHTAGLABEL` holds a tag _registry_ (`ZNAME`, `ZCANONICALNAME`,
  `ZFIRSTOCCURRENCECREATIONDATE`) but carries no reminder foreign key, and there is no join table.
  Per-reminder tags most likely live inside the `ZTITLEDOCUMENT` / `ZNOTESDOCUMENT` attributed-string
  blobs. Unconfirmed, so the server does not claim to read tags.
- **Attachment row → file.** `Container_v1/Files` held 2 files; the mapping from
  `ZREMCDSAVEDATTACHMENT` to a filename on disk has not been verified, so no `save_attachment` tool
  ships yet.
- **Accounts in the store.** Only `ZREMCDACCOUNTLISTDATA` with a blob, so account names stay an
  Apple Events concern.
- **Priority in the wild.** Every one of the 317 reminders had priority 0, so the 1–4 / 5 / 6–9
  bucketing is pinned by unit tests against the documented range and has never met real data.
- **A second TCC prompt.** Whether scripting Reminders also requires `kTCCServiceReminders` on top
  of Automation was not isolated, because the grant already existed when the probe ran.
