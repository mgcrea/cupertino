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

## Writing, when Cupertino hosts this server

With writes on and Cupertino hosting this server, five tools save through Maps'
own data model inside Cupertino, as a change made in the app is. They are the
only way this server writes: run from npm it only reads, and none of them is
listed. If the user asks for a change then, say it needs Cupertino.

| Change | Tool |
| --- | --- |
| Pin a place (the Pinned list) | \`apple_maps_add_favorite\` |
| Unpin it | \`apple_maps_remove_favorite\` |
| Save a place to the library, in no Guide | \`apple_maps_save_place\` |
| Remove a saved place | \`apple_maps_remove_saved_place\` |
| File a place in an existing Guide | \`apple_maps_add_place_to_guide\` |

**Unpinning is not removing.** As in Maps, \`apple_maps_remove_favorite\` keeps
the place in the user's library as a saved place. To take a place out of Maps
entirely, unpin it and then remove the saved place with
\`apple_maps_remove_saved_place\`, by a ref from \`apple_maps_list_unfiled_places\`
or \`apple_maps_list_collection_places\`.

**Removes take a ref** from a listing, never a coordinate.
\`apple_maps_add_place_to_guide\` takes a ref to a saved place, or a \`query\` to
save a new place and file it in one call.

**A new place lands in Recents.** Only Maps can make a place record, so unless the
place is already in the store near the coordinate given, Maps resolves it by
name, and it then also appears in the user's Recents. Give a coordinate when
you have one. The answer says so in \`recentsNote\`; tell the user.

**On the measured model, a save reaches iCloud without the app:** when the
result's \`syncMeasured\` is true, Maps' background service uploads it even
with Maps closed. Say the change is saved on this Mac and on its way to
other devices, not that it is already on the iPhone. When the result's
\`syncMeasured\` is false, the save still happened but sync is not yet measured on
this macOS: pass on its \`sync\` sentence, which asks to check the place on another
device.

A refusal's reason is in \`details.reason\`. A place Maps resolved more than about
250 m from the coordinate given is refused as \`invalid\`: confirm the place with
the user rather than retrying without a coordinate. \`incompatible\` and
\`writesOff\` will not pass on a retry.

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
