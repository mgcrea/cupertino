# @mgcrea/mcp-apple-calendar

Model Context Protocol server for the macOS **Apple Calendar** app.

> **Unofficial.** Not affiliated with Apple. It reads the Calendar store already on your Mac.

## One lane for reads, one for writes

- **Index lane** — read-only SQLite over `Calendar.sqlitedb`. Every read goes through it.
- **Apple Events lane** — writes only. There is no `jxa/read.ts` in this package, and a test asserts
  there never will be.

**This is the inverse of Notes.** Notes shipped on Apple Events because search took 97 ms. Calendar
cannot: a ±90-day range query over 1,349 events takes **3,355 ms** over Apple Events, `whose` is
worse and unstable, and every per-property bulk fetch costs ~1.8 s whichever property it is — so the
cost cannot be amortised the way Notes amortises a bulk fetch. The store opens read-only in **1 ms**.
Calendar needs the file lane for speed, not capability.

It does **not** need EventKit, which is why the companion app stays a pure broker rather than
linking a framework that would drag its own TCC prompt in.

| Permission                | Needed for  | Without it                                |
| ------------------------- | ----------- | ----------------------------------------- |
| **Full Disk Access**      | all reads   | nothing works — there is no read fallback |
| **Automation → Calendar** | writes only | reads are unaffected                      |

Neither is granted to Calendar.app — it is the _reader_ that needs permission. Grant Full Disk
Access to whatever launches the server (Terminal, iTerm, VS Code, Claude), then restart it.

With writes off — the default — **no Automation prompt appears at all**. A read-only Calendar server
needs exactly one permission.

## Tools

Read: `diagnostics`, `list_accounts`, `list_calendars`, `list_events`, `search_events`, `get_event`.

Write, registered **only** when `APPLE_CALENDAR_ALLOW_WRITES=1` — with the flag off they are
invisible to the model, not merely refused: `create_event`, `update_event`, `delete_events`.

## Configuration

| Variable                                        | Default    |                                               |
| ----------------------------------------------- | ---------- | --------------------------------------------- |
| `APPLE_CALENDAR_ALLOW_WRITES`                   | off        | Register the mutating tools.                  |
| `APPLE_CALENDAR_ACCOUNTS`                       | all        | Read-side allowlist, comma-separated.         |
| `APPLE_CALENDAR_CALENDARS`                      | all        | Read-side allowlist, comma-separated.         |
| `APPLE_CALENDAR_DEFAULT_CALENDAR`               | Calendar's | Calendar a new event goes to when none named. |
| `APPLE_CALENDAR_DEFAULT_RANGE_DAYS`             | `7`        | An unbounded default would scan a decade.     |
| `APPLE_CALENDAR_MAX_RANGE_DAYS`                 | `366`      | Ceiling on a caller-supplied range.           |
| `APPLE_CALENDAR_DEFAULT_EVENT_DURATION_MINUTES` | `60`       | Used when a write names no end.               |
| `APPLE_CALENDAR_INCLUDE_DECLINED`               | off        | Include declined events in reads.             |
| `APPLE_CALENDAR_INCLUDE_CANCELLED`              | off        | Include cancelled events in reads.            |
| `APPLE_CALENDAR_TIMEZONE`                       | system     | Override the zone ranges are resolved in.     |
| `APPLE_CALENDAR_INDEX_MODE`                     | `auto`     | `auto` \| `ro` \| `immutable` \| `off`.       |
| `APPLE_CALENDAR_STORE`                          | auto       | Explicit `Calendar.sqlitedb` path.            |
| `APPLE_CALENDAR_OSASCRIPT_TIMEOUT_MS`           | `30000`    | Sized for the first-run permission prompt.    |

## Notes that will bite you

- **`~/Library/Calendars` does not exist.** The store is
  `~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb`.
- **Recurrence lives in a cache table.** A naive `SELECT ... FROM CalendarItem` over a date range
  misses expanded repeats; the range query unions items carrying no recurrence rule with everything
  in the cache. 456 of 489 cached parents carry no rule of their own.
- **Dates are seconds since 2001**, not 1970 — `CalendarItem.last_modified` and `orig_date` both.
- **A floating time zone is not the system one.** Anything matching `GMT±HHMM` is a real zone;
  treating the rest as floating is what stops a two-hour silent shift.
- **Writes always go through Apple Events**, never the store, which the app holds open and syncs.

## Licence

[MIT](LICENSE).
