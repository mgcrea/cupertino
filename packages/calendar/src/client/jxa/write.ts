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
 * Delete whole events.
 *
 * Per-id results rather than a bulk throw: deleting five events where the third
 * has already gone should remove four and say which one was missing, not fail
 * the batch and leave the caller guessing what happened.
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
      results.push({ uid: uid, found: false, deleted: false });
      continue;
    }
    var gone = false;
    try {
      C.delete(ev);
      gone = true;
    } catch (e) {
      gone = false;
    }
    results.push({ uid: uid, found: true, deleted: gone });
  }
  return ok({ results: results });
`,
  { allowLaunch: true },
);

/**
 * Remove ONE occurrence of a repeating event, by excluding its date.
 *
 * This is what Calendar itself does for "Delete This Event" on a series, and it
 * is reversible in the app by removing the exclusion.
 *
 * Two details that are easy to get wrong:
 *
 * 1. The whole array is assigned back rather than pushed into. Push-in-place on
 *    an Apple Events list property is not reliable — the mutation happens on a
 *    local copy and never reaches the app.
 * 2. The result is VERIFIED by reading `excludedDates` back and looking for the
 *    instant. Without that check a silent no-op reports success, which on a
 *    delete is the worst possible lie.
 */
export const EXCLUDE_OCCURRENCE = script(
  `
  var cal = findCalendar(C, p.calendar);
  if (!cal) return err("CALENDAR_NOT_FOUND", p.calendar || "(default)");
  if (!isWritable(cal)) return err("CALENDAR_NOT_WRITABLE", prop(function () { return String(cal.name()); }, "?"));

  var ev = findEvent(cal, String(p.uid));
  if (!ev) return err("EVENT_NOT_FOUND", String(p.uid));

  var target = new Date(p.occurrenceStart);
  var current = prop(function () { return ev.excludedDates(); }, []);

  for (var i = 0; i < current.length; i++) {
    if (sameInstant(current[i], target)) {
      return ok({ uid: String(p.uid), excluded: true, alreadyExcluded: true, count: current.length });
    }
  }

  var next = [];
  for (var j = 0; j < current.length; j++) next.push(current[j]);
  next.push(target);
  ev.excludedDates = next;

  var after = prop(function () { return ev.excludedDates(); }, []);
  var confirmed = false;
  for (var k = 0; k < after.length; k++) {
    if (sameInstant(after[k], target)) confirmed = true;
  }
  if (!confirmed) {
    return err(
      "EXCLUSION_NOT_APPLIED",
      "Calendar accepted the excluded-dates assignment but the occurrence is still there."
    );
  }
  return ok({ uid: String(p.uid), excluded: true, alreadyExcluded: false, count: after.length });
`,
  { allowLaunch: true },
);
