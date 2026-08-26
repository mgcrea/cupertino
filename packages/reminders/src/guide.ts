/**
 * The Reminders operating manual, served as `cupertino://reminders/guide` and
 * embedded ahead of every Reminders prompt. Static by design — see the note in
 * the Mail guide.
 */
export const REMINDERS_GUIDE = `# Apple Reminders — how to drive this server

## Refs are opaque

Reminders come back with a \`ref\` like \`r1:x-apple-reminder://…\`. Pass it back
verbatim; never build, parse or reuse one across surfaces.

## Which tool, under which constraint

- **Anything with a date bound, a list or a completion state** is
  \`apple_reminders_list_reminders\` — it takes all of those as filters.
- **Text** is \`apple_reminders_search_reminders\`. \`scope: "full"\` (the default)
  matches the name and the notes body; \`scope: "title"\` matches only the name.
  It accepts the same filters, so search *within* a list or a date range rather
  than searching everything and filtering afterwards.
- **List names** must match what Reminders calls them. Read
  \`apple_reminders_list_lists\` — or the inventory resource — before filtering
  on one, because a name that does not match returns nothing rather than an
  error, and that looks exactly like an empty list.
- **\`apple_reminders_get_reminder\`** returns the notes body and any subtasks.

## Subtasks, and what the index cannot see

A subtask's container is another reminder, not a list. Reminders whose parent
is unresolved are reported as unmapped: that is parentage the Apple Events lane
cannot reach, **not** a set of orphans to re-file.

Tags, URLs, recurrence and alarms are index-only. On a ref that did not come
from the index they are unavailable — absent from the answer, which is not the
same as absent from the reminder.

## Writes

Mutating tools exist only when writes are enabled. If you cannot see
\`apple_reminders_create_reminder\`, writes are off — say so rather than
describing reminders you did not create.

When creating in bulk, **search for what already exists first**. Re-running a
capture over the same source is the normal way this surface accumulates
duplicates, and nothing here deduplicates for you.
`;
