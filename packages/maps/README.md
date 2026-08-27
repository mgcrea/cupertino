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
| `apple_maps_list_recents`           | where you have looked recently                         |
| `apple_maps_search_places`          | all three at once, by name, label or address           |
| `apple_maps_get_place`              | one place, by ref                                      |
| `apple_maps_diagnostics`            | what opened, which columns resolved, what it cannot do |

## What it does not do

It reads what is **saved on this Mac**. It does not search Apple's map of the world, geocode an
address, give directions or compute a travel time. Those are network calls to Apple's services,
not data on your disk.

It is also **read-only**, and that is a decision rather than a gap. The store is mirrored to iCloud
by `NSPersistentCloudKitContainer`, so writing means editing one replica of a synchronising object
graph underneath an app that is also editing it. That needs measuring before it needs shipping.

## Full Disk Access is mandatory

Not an optimisation. Maps ships no scripting dictionary, so there is no Apple Events lane to fall
back to — without the grant this server returns an **error**, never an empty list. Grant it to the
app running the server, not to Maps.

If a listing comes back empty, that means you have saved nothing of that kind. Run
`apple_maps_diagnostics` to tell the two apart.

## Configuration

| Variable                    | Default    | What                                                   |
| --------------------------- | ---------- | ------------------------------------------------------ |
| `APPLE_MAPS_STORE`          | discovered | explicit store path, for tests and forensic copies     |
| `APPLE_MAPS_INDEX_MODE`     | `auto`     | `auto` / `ro` / `immutable` / `off`                    |
| `APPLE_MAPS_MAX_RESULTS`    | 50         | default result ceiling                                 |
| `APPLE_MAPS_EXPOSE_PROMPTS` | on         | register the prompt and `cupertino://maps/*` resources |
| `APPLE_MAPS_DEBUG`          | off        | verbose logging on stderr                              |

`APPLE_MAPS_ALLOW_WRITES` is accepted and ignored: there is no mutating tool for it to gate.

See [docs/maps.md](../../docs/maps.md) for the phase-0 measurements, including the three separate
occasions on which this store was declared not to exist.
