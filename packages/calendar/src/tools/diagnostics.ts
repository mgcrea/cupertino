import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleCalendarClient } from "../client/calendar.js";
import { ok, wrap } from "./util.js";

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://calendar/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleCalendarClient,
  ctx: { allowWrites: boolean },
): Promise<Record<string, unknown>> => {
  const lanes = client.lanes();
  const located = client.locate();
  const store = client.index();

  /**
   * Three-valued, and the middle value is the useful one.
   *
   * Calendar's store has a constant filename, so `stat` answers "is it
   * there" even when `access(2)` is denied. That lets this separate "the
   * grant is missing" from "Calendar was never set up on this account",
   * which Reminders cannot do — its filename carries a generated UUID, so
   * without the grant there is no path to test at all.
   */
  const fullDiskAccess = located.readable
    ? "granted"
    : located.exists
      ? "denied (found the store, cannot read it)"
      : "unknown (no store file at the expected path)";

  return {
    server: { lanes },
    permissions: {
      fullDiskAccess,
      automation: ctx.allowWrites
        ? "needed for writes only. Reads never send an Apple Event, so a read-only setup " +
          "prompts for nothing."
        : "not needed — writes are off, and reads never send an Apple Event. Turning " +
          "writes on will prompt for Automation the first time one runs.",
      ...(located.readable
        ? {}
        : {
            howToGrant: [
              "System Settings > Privacy & Security > Full Disk Access",
              "Add the app that launches this server (Terminal, iTerm, VS Code, Claude...), then restart it.",
              "Granting it to Calendar.app does nothing — the reader needs the permission, not Calendar.",
            ],
          }),
    },
    store: {
      containerPath: located.containerPath,
      path: located.storePath,
      containerListable: located.containerListable,
      extrasPresent: located.extrasPresent,
      candidates: located.candidates.length,
      exists: located.exists,
      readable: located.readable,
      sizeBytes: located.size,
      walPresent: located.walPresent,
      walSizeBytes: located.walSizeBytes,
      fingerprint: lanes.storeFingerprint,
      reason: located.reason,
    },
    capabilities: store
      ? {
          hasOccurrenceCache: store.caps.hasOccurrenceCache,
          hasOccurrenceDays: store.caps.hasOccurrenceDays,
          hasRecurrence: store.caps.hasRecurrence,
          hasExceptionDates: store.caps.hasExceptionDates,
          hasLocation: store.caps.hasLocation,
          hasAttachments: store.caps.hasAttachments,
          hasParticipants: store.caps.hasParticipants,
          hasAlarms: store.caps.hasAlarms,
          itemColumns: store.caps.itemColumns.size,
          calendarColumns: store.caps.calendarColumns.size,
        }
      : null,
    settings: {
      allowWrites: ctx.allowWrites,
      // Off means the prompts and the cupertino:// resources are not registered
      // at all. Reported here because this tool still is, so it stays the one
      // place that explains a capability the client cannot see.
      exposePrompts: client.config.exposePrompts,
      accountAllowlist: client.config.accounts,
      calendarAllowlist: client.config.calendars,
      defaultCalendar: client.config.defaultCalendar ?? null,
      defaultRangeDays: client.config.defaultRangeDays,
      maxRangeDays: client.config.maxRangeDays,
      includeDeclined: client.config.includeDeclined,
      includeCancelled: client.config.includeCancelled,
      indexMode: client.config.indexMode,
      maxResults: client.config.maxResults,
      timeZone: client.config.timeZone ?? null,
    },
    caveats: [
      "Writes go through Apple Events and are real side effects: on a shared, CalDAV or " +
        "Exchange calendar a created event syncs within seconds and other people see it. " +
        "There is no draft state and no undo.",
      "Single occurrences of a repeating event can be neither edited nor deleted through " +
        "this server, and that is a limit of Calendar's scripting interface rather than a " +
        "choice: there is no way to detach one occurrence, and the excluded-dates property " +
        "reads back a 1903 sentinel and throws on assignment (measured, macOS 26.6). Both " +
        "are refused rather than applied to the whole series. Calendar.app can still do them.",
      'Attendees cannot be set, because that emails a person. There is no "all future ' +
        'occurrences" either, which would need two writes with no transaction between them.',
      "Calendar reads through the file lane only. Apple Events was measured at 3.4s for " +
        "a single 90-day range query, with the cost falling per round trip rather than " +
        "per event, so there is no slower-but-working fallback to offer when Full Disk " +
        "Access is missing. Reads need the grant.",
      "Repeating events are expanded from OccurrenceCache, which was measured to reach " +
        "about two years either side of today on the probed store. That is an edge: a " +
        "range running past it returns fewer repeating events than exist, so every " +
        "list_events result carries `coverage`, and sets `truncated` rather than " +
        "returning a short list silently.",
      "The `status` and `invitationStatus` numbers are EventKit's documented constants, " +
        "and this store is assumed to mirror them — likely, but not measured. That is why " +
        "cancelled and declined events are only hidden when you ask, and why the raw " +
        "value is on every result.",
      "Writes will go through Apple Events, targeting com.apple.iCal. Note the bundle id " +
        "is iCal, not Calendar, which is the one place this surface differs from the " +
        "other three.",
    ],
  };
};

/**
 * One tool that answers "why is this not working".
 *
 * Unlike the Reminders equivalent this probes no Apple Event before reading:
 * Calendar has no Apple Events read lane to probe (`docs/distribution.md`), so
 * firing one here would trigger the Automation prompt for a capability the
 * server does not yet have.
 */
export const registerDiagnosticsTools = (
  server: McpServer,
  client: AppleCalendarClient,
  ctx: { allowWrites: boolean },
): void => {
  server.registerTool(
    "apple_calendar_diagnostics",
    {
      description:
        "Report which lanes are live, which macOS permissions are granted, and what each " +
        "missing one is blocking. Start here when a tool fails or reports nothing — it names " +
        "the exact System Settings pane to open.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client, ctx)).then((r) => r ?? ok({})),
  );
};
