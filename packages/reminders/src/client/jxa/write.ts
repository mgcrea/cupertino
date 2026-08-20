import { script } from "./core.js";

/**
 * Mutating scripts.
 *
 * These are the only place Reminders is asked to change anything, and every one
 * of them re-reads the affected reminder afterwards: the result a tool returns
 * is what Reminders stored, never what the caller requested. The two differ
 * more often than you would expect — setting `dueDate` on an all-day reminder
 * is a property assignment whose visible effect is decided by the app.
 *
 * Dates arrive as ISO-8601 strings carrying an explicit offset (see
 * `dates.ts`) and are turned back into Date objects here. Passing a bare local
 * string would have Reminders resolve it in whatever zone it feels like.
 */

/** Read-back shape, shared by every write so their results are uniform. */
const READBACK = `
function readback(r) {
  return {
    id: prop(function () { return String(r.id()); }, null),
    name: prop(function () { return String(r.name()); }, null),
    body: prop(function () { var b = r.body(); return b === null ? null : String(b); }, null),
    completed: prop(function () { return r.completed(); }, null),
    completionDate: iso(prop(function () { return r.completionDate(); }, null)),
    dueDate: iso(prop(function () { return r.dueDate(); }, null)),
    alldayDueDate: iso(prop(function () { return r.alldayDueDate(); }, null)),
    remindMeDate: iso(prop(function () { return r.remindMeDate(); }, null)),
    priority: prop(function () { return r.priority(); }, 0),
    flagged: prop(function () { return r.flagged(); }, false),
    created: iso(prop(function () { return r.creationDate(); }, null)),
    modified: iso(prop(function () { return r.modificationDate(); }, null))
  };
}

/** Apply the optional fields a create and an update have in common. */
function applyFields(target, f) {
  if (f.name !== undefined && f.name !== null) target.name = String(f.name);
  if (f.body !== undefined) target.body = f.body === null ? "" : String(f.body);
  if (f.dueDate !== undefined && f.dueDate !== null) target.dueDate = new Date(f.dueDate);
  if (f.alldayDueDate !== undefined && f.alldayDueDate !== null) target.alldayDueDate = new Date(f.alldayDueDate);
  if (f.remindMeDate !== undefined && f.remindMeDate !== null) target.remindMeDate = new Date(f.remindMeDate);
  if (f.priority !== undefined && f.priority !== null) target.priority = f.priority;
  if (f.flagged !== undefined && f.flagged !== null) target.flagged = f.flagged;
  if (f.completed !== undefined && f.completed !== null) target.completed = f.completed;
}
`;

/**
 * Create a reminder.
 *
 * `listId` is optional: with none, Reminders' own default list wins, which is
 * the same list the app would have used. Guessing "the first list" instead
 * would put things somewhere the person does not look.
 */
export const CREATE_REMINDER = script(
  `${READBACK}
  var target = null;
  if (p.listId) {
    try { target = R.lists.byId(String(p.listId)); } catch (e) { target = null; }
    if (!target) return err("LIST_NOT_FOUND", "No list with id " + p.listId);
  } else {
    target = prop(function () { return R.defaultList; }, null);
    if (!target) return err("NO_DEFAULT_LIST", "Reminders reports no default list.");
  }

  var fields = { name: String(p.name) };
  var r = R.Reminder(fields);
  target.reminders.push(r);
  // Set the rest AFTER the push: a Reminder object that is not yet in a
  // container has nowhere to store a date, and the assignment is dropped.
  applyFields(r, p);
  return ok(readback(r));
`,
  { allowLaunch: true },
);

/** Update whatever fields were supplied, leaving the rest untouched. */
export const UPDATE_REMINDER = script(
  `${READBACK}
  var r = null;
  try { r = R.reminders.byId(String(p.id)); } catch (e) { r = null; }
  if (!r) return err("REMINDER_NOT_FOUND", "No reminder with id " + p.id);
  applyFields(r, p);
  return ok(readback(r));
`,
  { allowLaunch: true },
);

/**
 * Complete (or un-complete) reminders in bulk.
 *
 * Separate from update because it is the single most common mutation and is
 * naturally plural — a caller ticking off four things should not have to make
 * four round trips.
 */
export const COMPLETE_REMINDERS = script(
  `${READBACK}
  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    var r = null;
    try { r = R.reminders.byId(id); } catch (e) { r = null; }
    if (!r) { out.push({ id: id, found: false }); continue; }
    r.completed = p.completed === false ? false : true;
    var after = readback(r);
    after.found = true;
    out.push(after);
  }
  return ok(out);
`,
  { allowLaunch: true },
);

/**
 * Move reminders to another list.
 *
 * **This is a copy followed by a delete, and it cannot be anything else.**
 * `reminder.container` is declared `access="r"` in the scripting dictionary, so
 * there is no assignment that relocates a reminder. Two consequences the caller
 * has to know about, and which the tool description repeats:
 *
 *   - the reminder gets a **new id**, so any ref held for it stops resolving
 *   - the creation date becomes now, because a new object is what was made
 *
 * The original is deleted only after the copy has been created and read back.
 * If the copy fails, nothing is destroyed and the failure is reported per id.
 */
export const MOVE_REMINDERS = script(
  `${READBACK}
  var target = null;
  try { target = R.lists.byId(String(p.listId)); } catch (e) { target = null; }
  if (!target) return err("LIST_NOT_FOUND", "No list with id " + p.listId);

  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    var src = null;
    try { src = R.reminders.byId(id); } catch (e) { src = null; }
    if (!src) { out.push({ id: id, found: false }); continue; }

    var snapshot = readback(src);
    var copy = R.Reminder({ name: snapshot.name === null ? "" : snapshot.name });
    target.reminders.push(copy);
    applyFields(copy, {
      body: snapshot.body,
      dueDate: snapshot.dueDate,
      alldayDueDate: snapshot.alldayDueDate,
      remindMeDate: snapshot.remindMeDate,
      priority: snapshot.priority,
      flagged: snapshot.flagged,
      completed: snapshot.completed
    });
    var made = readback(copy);
    if (made.id === null) {
      out.push({ id: id, found: true, moved: false, error: "the copy could not be read back; nothing was deleted" });
      continue;
    }
    // Only now is the original expendable.
    var deleted = true;
    try { R.delete(src); } catch (e) { deleted = false; }
    made.found = true;
    made.moved = true;
    made.previousId = id;
    made.originalDeleted = deleted;
    out.push(made);
  }
  return ok(out);
`,
  { allowLaunch: true },
);

/** Delete reminders. Irreversible: they do not land anywhere recoverable. */
export const DELETE_REMINDERS = script(
  `
  var deleted = 0;
  var missing = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    var r = null;
    try { r = R.reminders.byId(id); } catch (e) { r = null; }
    if (!r) { missing.push(id); continue; }
    try { R.delete(r); deleted++; } catch (e) { missing.push(id); }
  }
  return ok({ deleted: deleted, missing: missing });
`,
  { allowLaunch: true },
);
