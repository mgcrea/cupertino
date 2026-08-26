/**
 * The Notes operating manual, served as `cupertino://notes/guide` and embedded
 * ahead of every Notes prompt.
 *
 * Static by design — see the same note in the Mail guide. Nothing here may
 * depend on a probe: account names, folder names and permission verdicts belong
 * to `cupertino://notes/inventory` and `cupertino://notes/diagnostics`, both of
 * which are allowed to fail.
 */
export const NOTES_GUIDE = `# Apple Notes — how to drive this server

## Refs are opaque

Notes come back with a \`ref\` like \`n1:x-coredata://…/ICNote/p123\`. Pass it back
verbatim; never build or parse one, and never carry it to another surface.

## Which tool, under which constraint

- **Finding anything by content** is \`apple_notes_search_notes\`.
- **\`apple_notes_list_notes\`** is a capped listing of a folder in date order —
  for "what did I write last week", not for "where did I write about X".
- **\`apple_notes_get_note\`** returns the body. Search results are summaries;
  do not quote a note you have only seen the title of.
- **Folders** are \`apple_notes_list_folders\`, and folder names must match what
  Notes actually calls them. Read the inventory rather than guessing.

## Locked notes are not empty notes

A password-protected note is encrypted at rest and comes back with its text
null. **No permission unlocks it** — not Full Disk Access, not Automation.
Report it as locked. Reporting it as empty invents an absence of content that
may be the exact content someone is looking for.

Without Full Disk Access the index lane is gone and search falls back to an
Apple Events scan: correct, but linear in the size of the library. A slow
search on a big library is this, not a hang.

Attachment bytes need Full Disk Access outright — the scripting dictionary
carries no file path — so \`apple_notes_save_attachment\` fails without it while
the rest of the server keeps working.

## Writes

Mutating tools exist only when writes are enabled. If you cannot see
\`apple_notes_create_note\`, writes are off; say so rather than describing a note
you did not create.

\`apple_notes_update_note\` **replaces** a note's body. It does not append. Read
the note first and write back the whole thing, or the rest of it is gone.
`;
