# @mgcrea/mcp-apple-core

Shared machinery for the Apple-app MCP servers — the osascript boundary, a TCC-aware error
taxonomy, and read-only SQLite access.

> **A library, not a server.** It registers no tools and has no `bin`. You want
> [`@mgcrea/mcp-apple-mail`](https://npmjs.com/package/@mgcrea/mcp-apple-mail),
> [`-notes`](https://npmjs.com/package/@mgcrea/mcp-apple-notes),
> [`-reminders`](https://npmjs.com/package/@mgcrea/mcp-apple-reminders),
> [`-calendar`](https://npmjs.com/package/@mgcrea/mcp-apple-calendar) or
> [`-contacts`](https://npmjs.com/package/@mgcrea/mcp-apple-contacts). This is published because
> they depend on it.

## What is in here

| Module         | What                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `osascript.ts` | the runner, the serialising queue, `assertStaticScript`, `mapOsaError`           |
| `errors.ts`    | the taxonomy, written against a required `SurfaceContext`                        |
| `fs.ts`        | `inspectFile` / `describeStore` — the exists-vs-readable distinction             |
| `sqlite.ts`    | the `ro` → `immutable` ladder, `toFileUri`, `escapeLike`, `PRAGMA query_only`    |
| `schema.ts`    | `columnsOf`, `tableMap`, `fingerprintSchema`, `detectEpoch`, the Core Data epoch |
| `config.ts`    | the four env parsers and `BaseConfigSchema`                                      |
| `tools.ts`     | `wrap`, `toFailure`, `ok`/`okText`/`fail`, `compact`, `limitArg`, `confirmArg`   |
| `cli.ts`       | `runStdioServer`, carrying the stdout-is-JSON-RPC rule and the darwin guard      |

## Why these and not more

The line was never module size. `assertStaticScript` is a shell-injection tripwire and the
serialising queue is the `-1712` guard — an invariant kept in two copies is one refactor away from
being enforced in one. Things that are structurally shaped by a single surface stayed with that
surface, because an interface designed from one sample would be wrong.

Two rules the taxonomy enforces rather than documents:

- **`SurfaceContext` is required** wherever it appears in a message. `TccDeniedError` once took an
  optional hint defaulting to `"Mail"`, hardcoded `"Mail"` again later in the same string, and was
  never passed a hint at either call site.
- **`PRAGMA query_only` is set on every store.** Not a preference: the Apple app owns the file,
  holds it open and reconciles it against a server, so writing to it corrupts sync state. Every
  mutation in every server goes through Apple Events instead.

## Platform

macOS only (`"os": ["darwin"]`), Node >= 24 — `node:sqlite` is used directly, with no native
dependency to build.

## Licence

[MIT](LICENSE).
