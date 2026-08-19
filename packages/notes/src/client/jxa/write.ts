import { script } from "./core.js";

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

/** Replace a note's body. The title follows the first line, as it does on create. */
export const UPDATE_NOTE = script(
  `
  var note = null;
  try { note = N.notes.byId(String(p.id)); } catch (e) { note = null; }
  if (!note) return err("NOTE_NOT_FOUND", "No note with id " + p.id);
  if (prop(function () { return note.passwordProtected(); }, false)) {
    return err("NOTE_LOCKED", "That note is password-protected; unlock it in Notes first.");
  }

  var current = prop(function () { return String(note.body()); }, "");
  var next = p.mode === "append" ? current + (p.body || "") : (p.body || "");
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
