/**
 * Date parsing for the Reminders tools.
 *
 * ## Why this module is now four lines
 *
 * The grammar it used to hold lives in `@mgcrea/mcp-apple-core`. It was written
 * here, copied verbatim into Calendar, copied again into Safari with the
 * backward forms added, and never reached Mail, Messages or Notes at all —
 * which is where the date bugs were. Core's header has the full account.
 *
 * ## What that grammar decides here, and why it matters more here than anywhere
 *
 * The scripting dictionary carries two separate due-date properties:
 *
 *   due date          "will set both date and time"
 *   allday due date   "will only set a date"
 *
 * So the *shape of the input* picks the property. A caller that writes
 * "2026-08-20" means a day; one that writes "2026-08-20T09:00" means an
 * instant. Collapsing those into one field is how a reminder ends up silently
 * due at midnight, which Reminders then renders as an all-day item anyway — the
 * bug is invisible until someone misses something. `kind` is what keeps them
 * apart, and it is the reason this surface asked for the grammar first.
 *
 * `+2d` is timed rather than all-day on purpose: it names a duration from now,
 * and the natural reading of "in two days" keeps the current time of day.
 *
 * One change came back with the hoist. A bare day used as an upper bound now
 * resolves to the NEXT day's midnight, and the comparisons below are `>=`
 * rather than `>`. Same bracket, and it no longer depends on 23:59:59.999
 * being the last instant anyone can name.
 */

export {
  addLocalDays,
  endOfLocalDay,
  parseBound,
  parseDate,
  startOfLocalDay,
  toLocalIso,
  type ParsedDate,
} from "@mgcrea/mcp-apple-core";

import type { DateKind } from "@mgcrea/mcp-apple-core";

/** What a parsed date turned out to be, which selects the Reminders property. */
export type DueKind = DateKind;
