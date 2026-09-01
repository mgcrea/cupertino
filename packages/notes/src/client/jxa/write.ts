import { script } from "./core.js";
import { REPAIR_BODY_SRC } from "./repair.js";

/**
 * Mutations may launch Notes.
 *
 * A read that silently launches an app is a read with a side effect, which is
 * why the read scripts refuse. A tool whose whole purpose is to create or change
 * a note has no such problem — the user asked for the change.
 */
const MUTATION = { allowLaunch: true } as const;

/**
 * Create a note.
 *
 * Notes derives a note's `name` from the first line of its body rather than from
 * a settable property, so the title is prepended as a heading instead of
 * assigned. Setting `name` directly is silently ignored.
 */
export const CREATE_NOTE = script(
  `
  var folder = null;
  if (p.folderId) {
    try { folder = N.folders.byId(String(p.folderId)); } catch (e) { folder = null; }
    if (!folder) return err("FOLDER_NOT_FOUND", "No folder with id " + p.folderId);
  } else {
    var accounts = N.accounts();
    if (!accounts.length) return err("NO_ACCOUNT", "Notes reports no accounts.");
    folder = accounts[0].defaultFolder;
  }

  var html = "";
  if (p.title) html += "<h1>" + p.title + "</h1>";
  if (p.body) html += p.body;
  if (!html) return err("EMPTY_NOTE", "A note needs a title or a body.");

  var note = N.Note({ body: html });
  folder.notes.push(note);
  return ok({
    id: prop(function () { return String(note.id()); }, null),
    name: prop(function () { return String(note.name()); }, null),
    folder: prop(function () { return String(folder.name()); }, null)
  });
`,
  MUTATION,
);

/**
 * Replace a note's body. The title follows the first line, as it does on create.
 *
 * Append re-serialises the *existing* body through Notes' HTML parser, which is
 * lossy in both directions — see `repair.ts`. `repairBody` undoes the getter's
 * damage before the concatenation, so an append leaves untouched content byte
 * identical instead of silently flattening indentation and eating characters.
 */
export const UPDATE_NOTE = script(
  REPAIR_BODY_SRC +
    `
  var note = null;
  try { note = N.notes.byId(String(p.id)); } catch (e) { note = null; }
  if (!note) return err("NOTE_NOT_FOUND", "No note with id " + p.id);
  if (prop(function () { return note.passwordProtected(); }, false)) {
    return err("NOTE_LOCKED", "That note is password-protected; unlock it in Notes first.");
  }

  var current = prop(function () { return String(note.body()); }, "");
  var next = p.mode === "append" ? repairBody(current) + (p.body || "") : (p.body || "");
  note.body = next;
  return ok({
    id: String(p.id),
    name: prop(function () { return String(note.name()); }, null),
    bodyLength: next.length,
    mode: p.mode || "replace"
  });
`,
  MUTATION,
);

/** Move a note to another folder. */
export const MOVE_NOTE = script(
  `
  var note = null;
  try { note = N.notes.byId(String(p.id)); } catch (e) { note = null; }
  if (!note) return err("NOTE_NOT_FOUND", "No note with id " + p.id);
  var folder = null;
  try { folder = N.folders.byId(String(p.folderId)); } catch (e) { folder = null; }
  if (!folder) return err("FOLDER_NOT_FOUND", "No folder with id " + p.folderId);

  N.move(note, { to: folder });
  return ok({
    id: String(p.id),
    folder: prop(function () { return String(folder.name()); }, null)
  });
`,
  MUTATION,
);

/**
 * Attach a file to a note.
 *
 * The scripting dictionary looks read-only on attachments — every property of
 * the `attachment` class is `access="r"` — but that reads the wrong half of it.
 * `note` declares `<element type="attachment">`, and `make` comes from the
 * Standard Suite, so it appears in no command list of the Notes suite. Apple
 * says so outright in a comment on the hidden `contents` property: the point of
 * hiding it is "to facilitate creating an attachment like this: make new
 * attachment with data myFile".
 *
 * THE FORM MATTERS. Measured on macOS 26.6, only one of the three works:
 *
 *   N.make({new: "attachment", at: note, withData: Path(f)})       works
 *   N.make({new: "attachment", at: note.attachments, withData: f}) -10014
 *   note.attachments.push(N.Attachment({contents: Path(f)}))       -10000
 *
 * `at:` takes the note itself, not its attachment collection — the opposite of
 * how `folder.notes.push` creates a note two functions up.
 *
 * Setting an image through the note `body` instead does NOT work and fails
 * deceptively: `<img src="file://...">` creates an attachment row whose bytes
 * are never fetched, and a `data:` URI lands as `public.data` with no preview.
 * See docs/notes.md.
 */
export const ADD_ATTACHMENT = script(
  `
  var note = null;
  try { note = N.notes.byId(String(p.id)); } catch (e) { note = null; }
  if (!note) return err("NOTE_NOT_FOUND", "No note with id " + p.id);
  if (prop(function () { return note.passwordProtected(); }, false)) {
    return err("NOTE_LOCKED", "That note is password-protected; unlock it in Notes first.");
  }

  var before = {};
  var existing = prop(function () { return note.attachments(); }, []);
  for (var i = 0; i < existing.length; i++) {
    try { before[String(existing[i].id())] = true; } catch (e) {}
  }

  try {
    N.make({ new: "attachment", at: note, withData: Path(String(p.path)) });
  } catch (e) {
    return err("ATTACH_FAILED", "Notes refused the file: " + e);
  }

  // Report the attachment that appeared, not a count. Notes can enumerate the
  // same attachment more than once, so a count would be wrong as often as right.
  var added = null;
  var after = prop(function () { return note.attachments(); }, []);
  for (var j = 0; j < after.length; j++) {
    var id = null;
    try { id = String(after[j].id()); } catch (e) { continue; }
    if (!before[id]) {
      added = { id: id, name: prop((function (a) { return function () { return String(a.name()); }; })(after[j]), null) };
      break;
    }
  }
  if (!added) return err("ATTACH_FAILED", "Notes reported no new attachment on that note.");

  return ok({ noteId: String(p.id), attachment: added });
`,
  MUTATION,
);

/**
 * Delete notes.
 *
 * Notes moves them to Recently Deleted rather than destroying them, which is
 * what makes this safe enough to expose at all — but it is still gated behind an
 * explicit confirm at the tool layer.
 */
export const DELETE_NOTES = script(
  `
  var deleted = [];
  var missing = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    var note = null;
    try { note = N.notes.byId(id); } catch (e) { note = null; }
    if (!note) { missing.push(id); continue; }
    try { N.delete(note); deleted.push(id); } catch (e) { missing.push(id); }
  }
  return ok({ deleted: deleted, missing: missing, note: "Deleted notes go to Recently Deleted." });
`,
  MUTATION,
);
