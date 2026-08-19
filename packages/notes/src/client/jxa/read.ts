import { script } from "./core.js";

/** Accounts, with the folder count each one holds. */
export const LIST_ACCOUNTS = script(`
  var accounts = N.accounts();
  var out = [];
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    out.push({
      id: prop(function () { return String(a.id()); }, null),
      name: prop(function () { return String(a.name()); }, null),
      defaultFolder: prop(function () { return String(a.defaultFolder.name()); }, null),
      folderCount: prop(function () { return a.folders().length; }, 0),
      noteCount: prop(function () { return a.notes().length; }, 0)
    });
  }
  return ok(out);
`);

/** The folder tree. Folders nest, so this is depth-first rather than a flat list. */
export const LIST_FOLDERS = script(`
  var accounts = N.accounts();
  var out = [];
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    var accountId = prop(function () { return String(a.id()); }, null);
    var accountName = prop(function () { return String(a.name()); }, null);
    var folders = folderTree(a, accountId, 1, []);
    for (var j = 0; j < folders.length; j++) {
      folders[j].accountName = accountName;
      out.push(folders[j]);
    }
  }
  return ok(out);
`);

/**
 * Every note's metadata, as bulk arrays.
 *
 * One Apple Event per property for the whole library — ~0.1ms per note — versus
 * ~116ms per note for reading properties one note at a time. Folder membership
 * is resolved with one bulk call per *folder*, which is a handful of round trips
 * rather than one per note.
 */
export const BULK_NOTES = script(`
  var ids = N.notes.id();
  var count = ids.length;
  var rows = zip(
    ["id", "name", "modified", "created", "locked", "shared"],
    [
      ids,
      prop(function () { return N.notes.name(); }, []),
      prop(function () { return N.notes.modificationDate(); }, []),
      prop(function () { return N.notes.creationDate(); }, []),
      prop(function () { return N.notes.passwordProtected(); }, []),
      prop(function () { return N.notes.shared(); }, [])
    ],
    count
  );

  // Note -> folder, one bulk call per folder rather than one per note.
  var folderOf = {};
  var accounts = N.accounts();
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    var accountId = prop(function () { return String(a.id()); }, null);
    var accountName = prop(function () { return String(a.name()); }, null);
    var folders = folderTree(a, accountId, 1, []);
    for (var j = 0; j < folders.length; j++) {
      var f = folders[j];
      var noteIds = [];
      try {
        var handle = N.folders.byId(f.id);
        noteIds = handle.notes.id();
      } catch (e) { noteIds = []; }
      for (var k = 0; k < noteIds.length; k++) {
        folderOf[String(noteIds[k])] = { folderId: f.id, folder: f.name, accountId: accountId, account: accountName };
      }
    }
  }

  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    row.id = String(row.id);
    row.modified = iso(row.modified);
    row.created = iso(row.created);
    var where = folderOf[row.id];
    row.folder = where ? where.folder : null;
    row.folderId = where ? where.folderId : null;
    row.account = where ? where.account : null;
    row.accountId = where ? where.accountId : null;
  }
  return ok({ count: count, notes: rows });
`);

/**
 * Every note's id and plaintext, in one round trip.
 *
 * This is the search lane when the index is unavailable: pull everything, filter
 * in JS. Measured at 97ms over 921 notes and 250KB — against 671ms for the
 * equivalent `whose` specifier.
 */
export const BULK_PLAINTEXT = script(`
  return ok({ ids: N.notes.id(), texts: N.notes.plaintext() });
`);

/** Bodies for a specific set of notes, by id. Used after the index narrows things down. */
export const GET_NOTE_BODIES = script(`
  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    var note = null;
    try { note = N.notes.byId(id); } catch (e) { note = null; }
    if (!note) { out.push({ id: id, found: false }); continue; }
    var locked = prop(function () { return note.passwordProtected(); }, false);
    out.push({
      id: id,
      found: true,
      locked: locked,
      name: prop(function () { return String(note.name()); }, null),
      plaintext: locked ? null : prop(function () { return String(note.plaintext()); }, null),
      body: locked ? null : prop(function () { return String(note.body()); }, null),
      modified: iso(prop(function () { return note.modificationDate(); }, null)),
      created: iso(prop(function () { return note.creationDate(); }, null))
    });
  }
  return ok(out);
`);

/** Attachment metadata for one note. There is no filesystem path in the dictionary. */
export const LIST_ATTACHMENTS = script(`
  var note = null;
  try { note = N.notes.byId(String(p.id)); } catch (e) { note = null; }
  if (!note) return err("NOTE_NOT_FOUND", "No note with id " + p.id);
  var atts = prop(function () { return note.attachments(); }, []);
  var out = [];
  for (var i = 0; i < atts.length; i++) {
    var a = atts[i];
    out.push({
      id: prop(function () { return String(a.id()); }, null),
      name: prop(function () { return String(a.name()); }, null),
      contentIdentifier: prop(function () { return String(a.contentIdentifier()); }, null),
      url: prop(function () { return String(a.URL()); }, null),
      created: iso(prop(function () { return a.creationDate(); }, null)),
      modified: iso(prop(function () { return a.modificationDate(); }, null))
    });
  }
  return ok(out);
`);
