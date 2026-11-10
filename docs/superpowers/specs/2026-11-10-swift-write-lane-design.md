# The store lane: writes in Swift, inside the app

**Status:** approved 2026-11-10.

## Why

Measured on 2026-11-10 ([docs/voice-memos.md](../../voice-memos.md), "Writing"): a rename of a
Voice Memo by SQL stayed on the Mac forever, and the same rename saved through Core Data, with
Voice Memos' own model, reached an iPhone within a minute. An app that syncs with
`NSPersistentCloudKitContainer` uploads only what Core Data's persistent history lists. Only a
Core Data save writes that history, and Node cannot make one.

That changes what the write tools can be. Four surfaces have a better write path that only Swift
can reach:

| Surface     | Writes today                        | Better path                    | What it fixes                                                                                                                            |
| ----------- | ----------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Voice Memos | none                                | Core Data, the app's own model | rename, move, favourite, delete become possible                                                                                          |
| Maps        | SQL via `node:sqlite`               | Core Data, the app's own model | inserts sync today because Core Data reconciles new objects; deletes and updates are **unmeasured**, and `remove_favorite` says it syncs |
| Calendar    | JXA, ~2 s per Apple Event           | EventKit                       | speed, transactions, the operations JXA cannot do (one occurrence, calendars by id)                                                      |
| Reminders   | JXA, ~1 s per Apple Event           | EventKit                       | speed, and a move keeps the reminder's id                                                                                                |
| Contacts    | JXA, `save()` commits the whole app | Contacts.framework             | a save that touches only its own contact, and delete                                                                                     |

## The decision this reverses

`docs/surfaces.md` says the app "links no data frameworks — it is a pure broker", `docs/calendar.md`
says "Calendar does not need EventKit", and `Permissions.swift:570-574` avoids Contacts.framework
so that no user is shown `NSContactsUsageDescription`. Those were right for reads, and reads stay
as they are. For writes the measurement above is new evidence. EventKit and Contacts.framework cost
three new permission prompts. They are asked for on the first write that needs them, never at
launch, and someone who never writes never sees them. Core Data costs no new permission: the
store is already under Full Disk Access.

## Goals

- Each write is saved by the framework that owns the data, so the app's own sync uploads it like
  a change made in the app.
- The read tools, the npm packages and every TypeScript file stay as they are. A surface installed
  from npm keeps the writes it has today.
- One lane, shared by every surface, reused rather than rebuilt per surface.

## Non-goals

- No reads in Swift. The file lane is measured, tested and fast.
- No rewrite of a TypeScript server, and no Swift binary on npm.
- No private API, and no persistent-history rows written by hand.
- Mail, Messages, Notes and Safari keep Apple Events: none has a better path, and Notes and
  Reminders' own store sync through engines that persistent history does not describe.

## Anti-goals

- **Never open a store with a model that does not match it.** A Core Data writer refuses unless
  `isConfiguration(withName:compatibleWithStoreMetadata:)` is true, with migration off. Migrating
  Apple's store is the one mistake here that cannot be undone.
- **Never claim a write synced without a measurement.** Each surface's write is measured on a
  throwaway item, on two devices, before its tool ships, as Voice Memos was.
- **Never prompt at launch** for a permission only writes need.

## Architecture

```
editor ── cupertino-bridge ── Cupertino.app ── node server (reads; write tools call the lane)
                                   │                         │
                                   └──── cupertino.sock ─────┘  "cupertino/1 store for=<surface>"
                                   │
                                   └── StoreLane (Swift, in-process): one writer per surface
```

**Transport.** The node servers already reach the app over `cupertino.sock`, with
`cupertino/1 desktop for=<surface>`: the PID is checked against the servers this host spawned,
and the borrower's own `allowWrites` and gates apply (`ServerHost.swift:559-633`). The store lane
is a second verb on that socket, `cupertino/1 store for=<surface>`, with the same PID check and
the same gate check, done again on the app side. After the handshake it speaks newline-delimited
JSON-RPC, as the desktop lend does. The methods are the lane's own (`voiceMemos.rename`), not MCP
tools, so nothing new appears in any tool list.

**Node side.** `packages/core/src/store-lane.ts`, `openStoreLane(surface)`, mirrors `openAxChannel`:
it is null without the app's environment, connects lazily, serialises calls, and has a timeout.
The env vars are the ones `ServerLocator` already sets (`CUPERTINO_AX_SOCKET`, `CUPERTINO_AX_FOR`).

**Registration.**

- A tool that exists only on the lane (all of Voice Memos' new writes) is registered only when the
  lane is present and `allowWrites` is on, as Maps' Accessibility writes are.
- A tool that already exists keeps its name and its fallback, and switches path underneath, as
  Mail and Safari switch lanes. Calendar, Reminders and Contacts keep JXA under npm. Maps keeps
  SQL under npm.
- Diagnostics names which path a write takes and why.

**App side.** `apps/apple/Cupertino/StoreLane/`:

- `StoreLane.swift`: dispatch by surface and method.
- `CoreDataStore.swift`: the shared Core Data opener.
- One writer per surface, from Phase 1 on: `VoiceMemosWriter.swift`, then `MapsWriter.swift`,
  `CalendarWriter.swift`, `RemindersWriter.swift` and `ContactsWriter.swift`.

### The Core Data opener

The opener does this, in order:

1. Loads the app's compiled model from its framework path. For Voice Memos that is
   `VoiceMemos.framework/.../VoiceMemos.momd`, and Maps' path is found in Phase 2. It copies the
   model so it can be edited.
2. Applies that surface's measured runtime patches. Voice Memos has one: `audioFuture` has
   `allowsExternalBinaryDataStorage` set. Each patch is a line in the writer, with a pointer to
   where it was measured.
3. Refuses unless the store's metadata is compatible with the model.
4. Opens the store with persistent history tracking and remote-change notifications on, and
   automatic migration and inferred mapping off.
5. Saves with `transactionAuthor = "cupertino"`, one save per call. It fetches by the stable id the
   read tools already return, refuses unless that finds exactly one object, and changes only the
   named attributes.

**When the app is closed** (my call): `voicememod` is launched on demand and may exit under
memory pressure, so a save can land while nothing is listening for the remote-change
notification. The lane does not launch Voice Memos, or anything else, to force an upload. The
exporter resumes from its last exported transaction, so the write should go up when the daemon
next runs. The tools say "syncs when Voice Memos next runs", and Phase 1's live check adds an
app-closed case to prove it.

**Which macOS versions write** (Olivier's call, option A): a write goes ahead on any macOS
whose model, after the patches, is compatible with the store. Sync is promised only where it
was measured. Each writer keeps a list of the model versions that passed the two-device check:
the compiled model's current version name, `NSManagedObjectModel_CurrentVersionName` in the
`.momd`'s `VersionInfo.plist` (`VoiceMemos14` for Voice Memos on 27.2). The store's own
`NSStoreModelVersionIdentifiers` is `[""]`, so it cannot be the key. On any other version, the write result carries "sync not yet measured on
this macOS" and diagnostics says the same. Writes keep working across macOS updates, and a
release adds a version to the list once it has been measured.

A coordinator is opened per call and dropped after it, so the app never holds Apple's store open
between writes. When the store and the model disagree after a macOS update, the write tools stay
registered and refuse, naming the mismatched entity. Diagnostics reports it before anyone tries.

### EventKit and Contacts

Those writers request access on their first call: full access for events and for reminders, and
contacts. A denial is an error that names the permission and where to grant it. The app gains the
three usage strings and the hardened-runtime entitlements
`com.apple.security.personal-information.calendars` and `…addressbook`. The Permissions pane gains
three rows, shown as "only needed for writes".

## Phases

Each phase is its own probe, plan and release. This document fixes the lane; each later phase
starts by measuring its surface the way Voice Memos was measured.

1. **The lane, and Voice Memos writes.** The socket verb, the node client, the Core Data opener,
   and `rename_recording`, `move_recording` (to a folder, or out of one), `set_favorite` and
   `delete_recording` (to Recently Deleted, as the app does: `ZEVICTIONDATE` set by Core Data,
   never a row removed). Each is measured on a throwaway memo, on two devices, before it ships.
2. **Maps on Core Data.** First, measure whether today's SQL `remove_favorite` reaches another
   device. Then move add and remove onto the lane, with SQL kept for npm. Until that measurement
   exists, `remove_favorite`'s description stops saying the delete syncs.
3. **Reminders and Calendar on EventKit.** The same tool names, the lane when the app hosts them,
   JXA under npm.
4. **Contacts on Contacts.framework.** The same, plus the delete the dictionary never had.

## Tests

- **Swift.** A test target builds a store in a temporary directory from the real framework model,
  plus the runtime patch, and exercises each writer against it. It also checks that the opener
  refuses a store made from an unpatched model.
- **Node.** `store-lane.ts` is tested against a fake socket server: the handshake, serialisation,
  the timeout, and null without the env.
- **Registration.** Each surface's `tools.test.ts` covers three cases: lane present, lane absent,
  and writes off.
- **Live.** A throwaway item per write, checked on the Mac and on an iPhone. Written down in the
  surface's findings doc before the tool ships. It is not automated: it needs a second device.

## Left to the builder

The JSON-RPC method names and payload shapes; the lane's timeout; how the opener caches the
patched model; the diagnostics wording; whether `move_recording` and `set_favorite` are one tool
or two.
