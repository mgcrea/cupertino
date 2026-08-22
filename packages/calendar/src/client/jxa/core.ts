/**
 * JXA script fragments.
 *
 * Every script here is a static constant. None may contain a template
 * interpolation — `assertStaticScript` rejects any script containing a dollar
 * sign followed by a brace, including template literals written INSIDE the JXA
 * source. Use string concatenation in JXA code.
 *
 * Every script follows the same contract:
 *   - it reads its parameters from `JSON.parse(argv[0])`
 *   - it returns `JSON.stringify({ok: true, data})` on success
 *   - it returns `JSON.stringify({ok: false, error: {code, message}})` on an
 *     application-level failure, still exiting 0
 * so a non-zero exit always means infrastructure rather than "no such event".
 *
 * ## There is no read.ts here, and that is the design
 *
 * Mail, Notes and Reminders all carry an Apple Events read lane. Calendar does
 * not, because `docs/calendar.md` measured one: a single ±90-day range query
 * costs 3.4 s over 1,349 events, and the cost falls per ROUND TRIP rather than
 * per event — about 2 s per property, flat — so no batching rescues it. That is
 * not a slower fallback, it is no fallback. Reads go through the file lane and
 * these scripts exist only to make Calendar change something.
 *
 * `test/jxa.test.ts` asserts that `read.ts` does not exist, so this stays a
 * decision rather than an accident.
 *
 * ## Finding an event costs a bulk fetch, which is why refs carry a calendar
 *
 * Calendar has no `events.byId()`. The two options are `whose({uid})`, measured
 * at 4.5-7.3 s and — worse than slow — UNSTABLE across runs, or one bulk
 * `cal.events.uid()` fetch plus an index in JS at about 1.8 s. The second only
 * stays affordable if it is scoped to ONE calendar, so `ref.ts` carries the
 * calendar uid and every script below narrows before it scans.
 */

/**
 * Shared prelude.
 *
 * THE BUNDLE IDENTIFIER IS `com.apple.iCal`. Calendar.app kept the id it
 * shipped with as iCal, and this is the only surface in the project where the
 * display name and the bundle id disagree — `Application("Calendar")` is
 * correct, and `com.apple.Calendar` does not exist.
 * `runningApplicationsWithBundleIdentifier` matches exactly and does not fold
 * case, so getting this wrong makes every write report "not running".
 */
export const PRELUDE = `
ObjC.import("AppKit");

function isCalendarRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.iCal");
  return apps.count > 0;
}

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message) { return JSON.stringify({ ok: false, error: { code: code, message: String(message) } }); }

function iso(d) {
  try { return d ? d.toISOString() : null; } catch (e) { return null; }
}

/** Read one property defensively: Calendar throws on properties it cannot supply. */
function prop(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * Find a calendar BY NAME.
 *
 * MEASURED, macOS 26.6: \`calendar.uid()\` throws \`AppleEvent handler failed\`
 * (-10000) for EVERY calendar, including ones this process just created. So a
 * calendar cannot be addressed by uid across Apple Events at all, and the
 * store's \`Calendar.UUID\` has no counterpart on this side.
 *
 * This is NOT the event id bridge, which docs/calendar.md measured as exact
 * (\`CalendarItem.UUID\` matched an event's \`uid\` 198/198). That result was
 * assumed to carry over to calendars; it does not. Events are addressable by
 * uid, calendars are addressable by name, and the caller resolves the name
 * before it gets here — including refusing an ambiguous one, which this side
 * has no way to detect.
 */
function findCalendar(C, wanted) {
  if (!wanted) {
    return prop(function () { return C.defaultCalendar(); }, null);
  }
  var cals = prop(function () { return C.calendars(); }, []);
  for (var i = 0; i < cals.length; i++) {
    var name = prop(function () { return String(cals[i].name()); }, null);
    if (name === wanted) return cals[i];
  }
  return null;
}

/**
 * Find one event inside a calendar, by uid.
 *
 * ONE bulk fetch of every uid in the calendar, then an index in JS.
 *
 * Deliberately NOT a specifier applied to the events collection, which was
 * measured slower AND unstable — 4,564 / 5,290 / 7,303 ms across three runs of
 * the same query — against a steady 3.4 s for a bulk scan. test/jxa.test.ts
 * enforces that by string match, which is why the disallowed form is described
 * here rather than written out.
 */
function findEvent(cal, uid) {
  var uids = prop(function () { return cal.events.uid(); }, null);
  if (!uids) return null;
  for (var i = 0; i < uids.length; i++) {
    if (String(uids[i]) === uid) {
      return prop(function () { return cal.events[i]; }, null);
    }
  }
  return null;
}

/** Millisecond-tolerant instant comparison, for the excluded-dates path. */
function sameInstant(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) < 1000;
}

/**
 * Whether a calendar accepts writes.
 *
 * Subscribed calendars — holidays, birthdays, anything added by URL — are
 * read-only, and assigning to one fails deep inside Calendar with a message
 * that does not say so. Asking first turns that into an error naming the cause.
 */
function isWritable(cal) {
  return prop(function () { return cal.writable(); }, true);
}

function readback(ev, cal) {
  return {
    uid: prop(function () { return String(ev.uid()); }, null),
    summary: prop(function () { return String(ev.summary()); }, null),
    startDate: iso(prop(function () { return ev.startDate(); }, null)),
    endDate: iso(prop(function () { return ev.endDate(); }, null)),
    alldayEvent: prop(function () { return ev.alldayEvent(); }, false),
    location: prop(function () { var v = ev.location(); return v === null ? null : String(v); }, null),
    description: prop(function () { var v = ev.description(); return v === null ? null : String(v); }, null),
    url: prop(function () { var v = ev.url(); return v === null ? null : String(v); }, null),
    stampDate: iso(prop(function () { return ev.stampDate(); }, null)),
    // No calendarUid: cal.uid() throws on every calendar (see findCalendar).
    // The caller already knows which calendar it targeted, and re-derives the
    // store uuid from this name.
    calendarName: prop(function () { return String(cal.name()); }, null)
  };
}

/**
 * Apply the optional fields a create and an update have in common.
 *
 * ## The dates go first, and in an order that is never briefly invalid
 *
 * MEASURED: moving an event later failed with
 *
 *     Failed to save event [...], with error
 *     [{ NSLocalizedDescription = "The start date must be before the end date." }]
 *
 * because start and end are two assignments, not one. Setting start to 16:00 on
 * an event still ending at 15:30 makes the interval invalid, and EventKit
 * validates on save rather than on assignment. Which order is safe depends on
 * which way the event is moving, so the current end decides: moving later, the
 * end is pushed out first; moving earlier, the start is pulled back first.
 *
 * They also go BEFORE the text fields. Apple Events has no transaction, so a
 * failure part-way through leaves whatever already applied — and the first
 * version of this wrote the new location, then failed on the dates, leaving the
 * event half-updated. Doing the fragile part first means a date failure changes
 * nothing else.
 */
function applyFields(ev, f) {
  var newStart = f.startDate !== undefined && f.startDate !== null ? new Date(f.startDate) : null;
  var newEnd = f.endDate !== undefined && f.endDate !== null ? new Date(f.endDate) : null;

  if (newStart !== null && newEnd !== null) {
    var currentEnd = prop(function () { return ev.endDate(); }, null);
    var movingLater = currentEnd === null || newEnd.getTime() >= currentEnd.getTime();
    if (movingLater) {
      ev.endDate = newEnd;
      ev.startDate = newStart;
    } else {
      ev.startDate = newStart;
      ev.endDate = newEnd;
    }
  } else if (newStart !== null) {
    ev.startDate = newStart;
  } else if (newEnd !== null) {
    ev.endDate = newEnd;
  }

  if (f.allDay !== undefined && f.allDay !== null) ev.alldayEvent = Boolean(f.allDay);
  if (f.summary !== undefined && f.summary !== null) ev.summary = String(f.summary);
  if (f.location !== undefined) ev.location = f.location === null ? "" : String(f.location);
  if (f.description !== undefined) ev.description = f.description === null ? "" : String(f.description);
  if (f.url !== undefined) ev.url = f.url === null ? "" : String(f.url);
}
`;

/**
 * Wrap a script body in the prelude and the liveness gate.
 *
 * Every script in `write.ts` sets `allowLaunch`, and that is not an oversight:
 * a write is a deliberate side effect, so launching Calendar to perform one is
 * expected in a way that launching it for a read never is. There are no read
 * scripts here to keep it false for.
 */
export const script = (body: string, opts: { allowLaunch?: boolean } = {}): string => `
${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0] || "{}");
  if (!isCalendarRunning() && !${opts.allowLaunch ? "true" : "false"}) {
    return err("APP_NOT_RUNNING", "Calendar is not running.");
  }
  try {
    var C = Application("Calendar");
    ${body}
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (msg.indexOf("-1743") !== -1) return err("NOT_AUTHORIZED", msg);
    return err("SCRIPT_ERROR", msg);
  }
}
`;
