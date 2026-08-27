/**
 * The Maps operating manual, served as `cupertino://maps/guide` and embedded
 * ahead of every Maps prompt. Static by design — see the note in the Mail guide.
 */
export const MAPS_GUIDE = `# Maps — how to drive this server

## What this surface is, and is not

It reads the places **saved on this Mac**: favourites, collections (Guides) and
recents. It does **not** search Apple's map of the world, geocode an address,
give directions, or compute a travel time. If asked for any of those, say so
plainly rather than searching the saved places and presenting a near-miss —
"the nearest coffee shop" is not a question this server can answer, and a
favourite called "Coffee" is not the answer to it.

## One lane, and no fallback

Maps ships **no scripting dictionary** — there is no \`.sdef\` in the app bundle
— so unlike every other surface here there is no Apple Events lane to fall back
to. Everything comes from a Core Data store under **Full Disk Access**.

The consequence matters: without the grant this server returns an **error**, not
an empty list. If a tool ever does return an empty list, that means the user has
genuinely saved nothing of that kind. Check
\`cupertino://maps/diagnostics\` before concluding either way.

## Which tool answers which question

| Question | Tool |
| --- | --- |
| What places has the user saved? | \`apple_maps_list_favorites\` |
| What Guides do they keep? | \`apple_maps_list_collections\` |
| What is filed in one Guide? | \`apple_maps_list_collection_places\` |
| Where have they looked recently? | \`apple_maps_list_recents\` |
| Find a saved place by name or address | \`apple_maps_search_places\` |
| One place, in full | \`apple_maps_get_place\` |

## Four things not to say

**\`linked: false\` is not a broken row.** Some favourites have no place
attached, no name and no coordinate. They are Maps' unconfigured Home / Work /
School slots. Report them as unset, not as places.

**A null date is unknown, not old.** Timestamps are placed on an epoch detected
from the store. When detection fails every date reads \`null\` rather than being
guessed, because a date wrong by 31 years reads exactly like a correct one.

**A collection with no listable places may still have places.** How an item
belongs to a collection is not exposed by every version of this store. When the
key is missing, \`placesCount\` is still Maps' own accurate number and the
places simply cannot be enumerated. Say that, rather than reporting an empty
Guide.

**Refs expire.** They address a row in a store that iCloud re-syncs, and Core
Data reuses row ids after a delete. A ref is good for this conversation. Do not
store one or hand it back later.

## Privacy, worth holding in mind

Saved places are a home address, a doctor, a school, a partner's flat. This is
among the most sensitive data any surface here reads. Answer what was asked;
do not enumerate everything because a listing tool is available.
`;
