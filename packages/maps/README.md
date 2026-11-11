# @mgcrea/mcp-apple-maps

MCP server for the macOS **Maps** app: the places you have saved.

```json
{
  "mcpServers": {
    "apple-maps": { "command": "npx", "args": ["-y", "@mgcrea/mcp-apple-maps"] }
  }
}
```

## What it reads

Favourites, collections (Guides) and recents, with names, addresses and **real coordinates**,
from Maps' Core Data store.

| Tool                                | What                                                   |
| ----------------------------------- | ------------------------------------------------------ |
| `apple_maps_list_favorites`         | the places saved as favourites                         |
| `apple_maps_list_collections`       | the Guides                                             |
| `apple_maps_list_collection_places` | what is filed in one Guide                             |
| `apple_maps_list_unfiled_places`    | saved places filed in no Guide                         |
| `apple_maps_list_recents`           | where you have looked recently                         |
| `apple_maps_search_places`          | all three at once, by name, label or address           |
| `apple_maps_get_place`              | one place, by ref                                      |
| `apple_maps_diagnostics`            | what opened, which columns resolved, what it cannot do |

## What it writes

Only with `APPLE_MAPS_ALLOW_WRITES=1`. The write tools are unregistered rather than refused when it
is off, so a client that has not opted in is never told they exist.

**In Cupertino**, five tools save through Maps' own Core Data model, inside Cupertino.app, so each
change is recorded the way a change made in Maps is. They exist only when Cupertino hosts this
server.

| Tool                            | What                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `apple_maps_add_favorite`       | pin a place                                                                              |
| `apple_maps_remove_favorite`    | unpin a place, by ref; as in Maps, it stays in your library as a saved place             |
| `apple_maps_save_place`         | save a place to the library, in no Guide (not the same as Pinned)                        |
| `apple_maps_remove_saved_place` | remove a saved place, by ref                                                             |
| `apple_maps_add_place_to_guide` | file a saved place (by ref) or a new one (by name) in an existing Guide, read back after |

None of them brings Maps forward or presses anything. A place record can only be minted by Maps, so
unless the place is already in the store near the coordinate given, Maps resolves it from its name:
**it is left in your Recents**, and resolving it can take tens of seconds. Sync to your other
devices is **not yet measured**: each answer's `sync` says so, and the place should be checked on
another device.

**Run from npm**, only `apple_maps_add_favorite` and `apple_maps_remove_favorite` exist, and they
write SQL straight into the store; there, `remove_favorite` deletes the pin outright. On
2026-11-11 the favourites that route inserts were found never mirrored to iCloud, and Maps was
seen turning favourites like them into saved places ([docs/maps.md](../../docs/maps.md#what-maps-changes-watched-2026-11-11)).

## What it does not do

It reads what is **saved on this Mac**. It does not search Apple's map of the world, geocode an
address, give directions or compute a travel time. Those are network calls to Apple's services,
not data on your disk.

It writes only with `APPLE_MAPS_ALLOW_WRITES` set: pins, the Places library and Guide membership.
Everything else here is read-only. The store is mirrored to iCloud by
`NSPersistentCloudKitContainer`, so a write is an edit to one replica of a synchronising object
graph underneath a running app. That is why a place record is never fabricated: Maps itself mints
it, and only then is it copied.

## Full Disk Access is mandatory

Not an optimisation. Maps ships no scripting dictionary, so there is no Apple Events lane to fall
back to — without the grant this server returns an **error**, never an empty list. Grant it to the
app running the server, not to Maps.

If a listing comes back empty, that means you have saved nothing of that kind. Run
`apple_maps_diagnostics` to tell the two apart.

## Configuration

| Variable                     | Default    | What                                                   |
| ---------------------------- | ---------- | ------------------------------------------------------ |
| `APPLE_MAPS_STORE`           | discovered | explicit store path, for tests and forensic copies     |
| `APPLE_MAPS_INDEX_MODE`      | `auto`     | `auto` / `ro` / `immutable` / `off`                    |
| `APPLE_MAPS_MAX_RESULTS`     | 50         | default result ceiling                                 |
| `APPLE_MAPS_SEED_TIMEOUT_MS` | 30000      | how long a write waits for Maps to resolve a place     |
| `APPLE_MAPS_EXPOSE_PROMPTS`  | on         | register the prompt and `cupertino://maps/*` resources |
| `APPLE_MAPS_DEBUG`           | off        | verbose logging on stderr                              |

`APPLE_MAPS_ALLOW_WRITES` (off) registers the tools under [What it writes](#what-it-writes).

See [docs/maps.md](../../docs/maps.md) for the phase-0 measurements, including the three separate
occasions on which this store was declared not to exist.

## Licence

[MIT](LICENSE).
