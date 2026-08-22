# @mgcrea/mcp-apple-contacts

Model Context Protocol server for the macOS **Apple Contacts** address book.

> **Unofficial.** Not affiliated with Apple. It reads the address book already on your Mac.

## Why it exists: resolving handles

`apple_contacts_resolve_handles` turns phone numbers and email addresses into names, in batches of up
to 500. Everything else here is in service of that.

This is the surface where the file-lane rule is about **capability, not speed**. Contacts' scripting
dictionary answers in ~65 ms — comfortably fast, and still useless for this: resolving a phone number
means a suffix-keyed index over every stored number, and no quantity of Apple Events round trips
produces one. So reads go through read-only SQLite, and there is no Apple Events read lane.

The lookup builds in **3 ms** over 947 phone keys and 295 email keys, then is kept for the life of
the process.

## Permissions — this one is different

| Permission                | Needed for  | Notes                                          |
| ------------------------- | ----------- | ---------------------------------------------- |
| **Contacts** (its own)    | reads       | **prompts** — answer the dialog, and that's it |
| **Automation → Contacts** | writes only | reads are unaffected                           |

Contacts fails differently from every other surface in this family: it sits behind its **own TCC
service** rather than behind Full Disk Access, and unlike Full Disk Access that permission
_prompts_. So the fix is usually "answer the dialog", not "go to System Settings" — and nothing here
asks you to hand over whole-disk access for an address book.

## Tools

Read: `diagnostics`, `resolve_handles`, `search_contacts`, `list_contacts`, `get_contact`.

Write, registered **only** when `APPLE_CONTACTS_ALLOW_WRITES=1` — with the flag off they are
invisible to the model, not merely refused: `create_contact`, `update_contact`.

`resolveHandles()` is also exported from the package root, for callers already inside Node that
would rather not go through MCP to reach it.

## Configuration

| Variable                              | Default |                                            |
| ------------------------------------- | ------- | ------------------------------------------ |
| `APPLE_CONTACTS_ALLOW_WRITES`         | off     | Register the mutating tools.               |
| `APPLE_CONTACTS_PHONE_SUFFIX_DIGITS`  | `9`     | Suffix key length; 6–15.                   |
| `APPLE_CONTACTS_INDEX_MODE`           | `auto`  | `auto` \| `ro` \| `immutable` \| `off`.    |
| `APPLE_CONTACTS_STORE`                | auto    | Explicit store path.                       |
| `APPLE_CONTACTS_OSASCRIPT_TIMEOUT_MS` | `30000` | Sized for the first-run permission prompt. |

## Notes that will bite you

- **The store is plural.** `locate.ts` returns a list and every query fans out — on a real machine,
  `stores=2/2, contacts=421`, matching Apple Events exactly. A server reading only the first store
  silently loses an account.
- **Nine-digit suffix keys, and the length travels inside the lookup object** so the index and the
  query cannot diverge. A self-join over a real address book at 7, 9 and 10 digits settles it: 7 and
  9 collide identically (10 of 947 keys, 1.1%), and 10 drops a key while losing the
  national-to-E.164 join.
- **Ambiguity is a status, never a guess** — `resolved` / `unknown` / `ambiguous` / `shortcode`.
  `unknown` is documented in the tool description as expected, not as an error.
- **`Z_ENT` filters to `ABCDContact`.** Without it, a list tool returns your groups as people.
- **A write can succeed and still not persist.** Contacts holds changes in an unsaved buffer, so a
  mutation can read back correctly inside the same script and never reach the store. Every write
  script saves and then re-reads.

## Licence

[MIT](LICENSE).
