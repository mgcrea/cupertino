import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppleCalendarClient } from "../client/calendar.js";
import { ok, wrap } from "./util.js";

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
    async () =>
      wrap(async () => {
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
            automation:
              "not requested — this server has no Apple Events read lane, and the write lane " +
              "is not implemented yet. A read-only Calendar surface needs no Automation grant.",
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
            "This surface is under construction. Only diagnostics is registered; the event " +
              "and calendar tools land once the recurrence question below is settled.",
            "Calendar reads through the file lane only. Apple Events was measured at 3.4s for " +
              "a single 90-day range query, with the cost falling per round trip rather than " +
              "per event, so there is no slower-but-working fallback to offer when Full Disk " +
              "Access is missing. Reads need the grant.",
            "The open question is recurrence. OccurrenceCache and OccurrenceCacheDays both " +
              "hold more rows than CalendarItem itself, so expanded occurrences of a repeating " +
              "event live outside the main table. Until `pnpm probe:calendar` has diffed a " +
              "range query against Apple Events as a set, a listing tool would risk showing a " +
              "weekly meeting once — which looks exactly like a free afternoon.",
            "Writes will go through Apple Events, targeting com.apple.iCal. Note the bundle id " +
              "is iCal, not Calendar, which is the one place this surface differs from the " +
              "other three.",
          ],
        };
      }).then((r) => r ?? ok({})),
  );
};
