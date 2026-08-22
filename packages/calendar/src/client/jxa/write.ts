import { script } from "./core.js";

/**
 * Mutating scripts.
 *
 * These are the only place Calendar is asked to change anything, and every one
 * re-reads the affected event afterwards: what a tool returns is what Calendar
 * STORED, never what the caller requested. The two differ more often than you
 * would expect — setting `alldayEvent` reshapes the start and end, and Calendar
 * decides the final values, not us.
 *
 * Dates arrive as ISO-8601 strings carrying an explicit offset (see `dates.ts`)
 * and are turned back into Date objects here. Passing a bare local string would
 * have Calendar resolve it in whatever zone it feels like.
 *
 * ## Real side effects, said plainly
 *
 * A create on a CalDAV or Exchange calendar syncs within seconds and other
 * people see it. There is no draft state and no undo. That is why the tools
 * that call these carry the warning in their descriptions, and why attendees
 * are not a parameter anywhere in this file: adding one emails a human.
 */

export const CREATE_EVENT = script(
  `
  var cal = findCalendar(C, p.calendar);
  if (!cal) return err("CALENDAR_NOT_FOUND", p.calendar || "(default)");
  if (!isWritable(cal)) return err("CALENDAR_NOT_WRITABLE", prop(function () { return String(cal.name()); }, "?"));

  // Build with the required dates, push, THEN apply the optional fields.
  // An object that is not yet in a container has nowhere to store a property,
  // so assignments made before the push are silently lost.
  var ev = C.Event({
    summary: String(p.summary),
    startDate: new Date(p.startDate),
    endDate: new Date(p.endDate)
  });
  cal.events.push(ev);
  applyFields(ev, p);

  return ok(readback(ev, cal));
`,
  { allowLaunch: true },
);

export const UPDATE_EVENT = script(
  `
  var cal = findCalendar(C, p.calendar);
  if (!cal) return err("CALENDAR_NOT_FOUND", p.calendar || "(default)");
  if (!isWritable(cal)) return err("CALENDAR_NOT_WRITABLE", prop(function () { return String(cal.name()); }, "?"));

  var ev = findEvent(cal, String(p.uid));
  if (!ev) return err("EVENT_NOT_FOUND", String(p.uid));

  applyFields(ev, p);
  return ok(readback(ev, cal));
`,
  { allowLaunch: true },
);

/**
 * Delete whole events, and VERIFY that each one actually went.
 *
 * MEASURED, macOS 26.6: `C.delete(ev)` on a RECURRING event neither throws nor
 * deletes. Event count before 1, after 1, still present — while the same call
 * removes a non-repeating event correctly. Trusting "it did not throw" therefore
 * reported `deleted: true` for an event that is still on the calendar, which is
 * the worst thing a delete can say.
 *
 * So the uid list is re-read afterwards and `deleted` is decided by ABSENCE.
 * The sibling script that excluded one occurrence had this check from the start
 * and it is what caught that property being broken; this one did not, and this
 * is what that omission cost.
 *
 * Per-id results rather than a bulk throw: deleting five events where the third
 * has already gone should remove four and say which one was missing.
 */
export const DELETE_EVENTS = script(
  `
  var cal = findCalendar(C, p.calendar);
  if (!cal) return err("CALENDAR_NOT_FOUND", p.calendar || "(default)");
  if (!isWritable(cal)) return err("CALENDAR_NOT_WRITABLE", prop(function () { return String(cal.name()); }, "?"));

  var results = [];
  for (var i = 0; i < p.uids.length; i++) {
    var uid = String(p.uids[i]);
    var ev = findEvent(cal, uid);
    if (!ev) {
      results.push({ uid: uid, found: false, deleted: false, repeats: false });
      continue;
    }
    var repeats = false;
    try {
      var r = ev.recurrence();
      repeats = r !== null && r !== undefined && String(r) !== "";
    } catch (e) {
      repeats = false;
    }
    var threw = null;
    try { C.delete(ev); } catch (e) { threw = String(e).slice(0, 120); }
    results.push({ uid: uid, found: true, deleted: null, repeats: repeats, error: threw });
  }

  // ONE bulk re-read decides the truth for every id at once.
  var after = prop(function () { return cal.events.uid(); }, null);
  for (var j = 0; j < results.length; j++) {
    if (!results[j].found) continue;
    if (after === null) {
      results[j].deleted = null;
      results[j].reason = "could not re-read the calendar to confirm";
      continue;
    }
    var gone = true;
    for (var k = 0; k < after.length; k++) {
      if (String(after[k]) === results[j].uid) gone = false;
    }
    results[j].deleted = gone;
    if (!gone) {
      results[j].reason = results[j].repeats
        ? "Calendar did not delete it and reported no error, which is what it does for a repeating event. Delete it in Calendar.app."
        : "Calendar reported no error but the event is still there.";
    }
  }
  return ok({ results: results });
`,
  { allowLaunch: true },
);

/**
 * REMOVED: excluding one occurrence, which Calendar cannot do.
 *
 * MEASURED, macOS 26.6, against a real repeating event:
 *
 *   ev.excludedDates()            -> ["1903-12-31T23:50:39.000Z"]
 *   ev.excludedDates = [aDate]    -> TypeError: undefined is not an object
 *
 * The read returns a sentinel rather than the empty list the event actually
 * has, and the assignment throws — while `ev.summary = "x"` on the very same
 * specifier works, so this is the property, not the specifier or the lane.
 *
 * A script was written here that assigned the whole array back and then read it
 * again to confirm, precisely because a silent no-op on a delete is the worst
 * lie this surface could tell. The verification worked: it caught this. But a
 * write path that can only ever report failure is not a capability, so the tool
 * no longer offers "delete one occurrence" at all — `delete_events` refuses an
 * occurrence ref and says why, which is the same shape as `update_event`.
 *
 * Deleting a single occurrence is possible in Calendar.app itself, so this is a
 * limit of the scripting interface rather than of the data.
 */
