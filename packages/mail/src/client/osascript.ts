/**
 * Mail's osascript boundary.
 *
 * The runner, the serialising queue and the `assertStaticScript` tripwire moved
 * to `@mgcrea/mcp-apple-core`: they are security invariants, and an invariant
 * kept in two copies is one refactor away from being enforced in one. This
 * module stays as the import path the rest of the package already uses.
 */

export {
  assertStaticScript,
  createOsascriptRunner,
  mapOsaError,
  withBusyRetry,
  type ExecImpl,
  type JxaEnvelope,
  type Logger,
  type OsascriptOptions,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";
