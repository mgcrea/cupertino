/**
 * CalendarRef — the one identifier any tool accepts or returns.
 *
 * Wire format:  c1:<calendarUid>/<occurrence>/<eventUid>
 *
 *   calendarUid  `Calendar.UUID`. Always a UUID in this store.
 *   occurrence   "-" for a single event or a whole series, otherwise the
 *                occurrence start as ISO-8601 basic with offset,
 *                e.g. 20260821T090000+0200.
 *   eventUid     `CalendarItem.UUID`, verbatim, as the greedy tail.
 *
 * The `c1:` prefix follows the same reasoning as Notes' `n1:` and Reminders'
 * `r1:`: if the scheme ever changes, a versioned prefix makes that an additive
 * change instead of a silent reinterpretation of every ref already sitting in a
 * conversation.
 *
 * ## Why the uid is the greedy tail, and why `@` is not a separator
 *
 * `docs/calendar.md` measured the id bridge on an iCloud account, where every
 * uid is a bare UUID. That is a property of the ACCOUNT, not of Calendar: a
 * Google event's uid looks like `abc123def@google.com`, and an Exchange one is
 * a long hex blob. Requiring a UUID here would work perfectly on the machine it
 * was written on and fail completely on anyone else's — so the uid is carried
 * through verbatim and the UUID is only extracted opportunistically.
 *
 * That also rules out `@` as a field separator, which is otherwise the obvious
 * choice for pinning an occurrence to a time.
 *
 * ## Why the calendar uid rides along
 *
 * Calendar's scripting dictionary has no `events.byId()`. Finding an event over
 * Apple Events means either `whose({uid})` — measured at 4.5-7.3 s and, worse,
 * UNSTABLE across runs — or one bulk `cal.events.uid()` fetch and an index in
 * JS, at about 1.8 s. The bulk fetch is only affordable if it is scoped to ONE
 * calendar, so every write narrows by calendar before it scans.
 *
 * That is a concrete thing the file lane hands the write lane: the store knows
 * which calendar an event is in, so Apple Events never has to search for it.
 */

import { PreconditionError } from "./errors.js";

export const REF_VERSION = "c1";

/** Used to FIND a uuid inside an id, never to require one. */
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** `20260821T090000+0200` / `20260821T070000Z` — ISO-8601 basic. */
const BASIC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})$/;

const SEPARATOR = "/";
const NO_OCCURRENCE = "-";

export type CalendarRef = {
  /** `Calendar.UUID` — which calendar to narrow to before scanning. */
  calendarUid: string;
  /** `CalendarItem.UUID`, exactly as stored. This is what resolves. */
  eventUid: string;
  /** Null for a single event or a whole series. */
  occurrenceStart: Date | null;
  /** True when this ref names one occurrence rather than the series. */
  isOccurrence: boolean;
};

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** The inverse of BASIC: local wall clock plus its offset, no punctuation. */
const toBasic = (d: Date): string => {
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? "-" : "+";
  const abs = Math.abs(mins);
  const zone = mins === 0 ? "Z" : `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${zone}`
  );
};

const fromBasic = (text: string): Date | null => {
  const m = BASIC.exec(text);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  const iso =
    `${y}-${mo}-${d}T${hh}:${mm}:${ss}` +
    (zone === "Z" ? "Z" : `${zone!.slice(0, 3)}:${zone!.slice(3)}`);
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : when;
};

export const encodeRef = (
  calendarUid: string,
  eventUid: string,
  occurrenceStart?: Date | null,
): string =>
  [
    REF_VERSION + ":" + String(calendarUid ?? ""),
    occurrenceStart ? toBasic(occurrenceStart) : NO_OCCURRENCE,
    String(eventUid ?? ""),
  ].join(SEPARATOR);

export const decodeRef = (raw: string): CalendarRef => {
  const text = String(raw ?? "");
  const colon = text.indexOf(":");
  const version = colon === -1 ? "" : text.slice(0, colon);

  if (version !== REF_VERSION) {
    // Distinguish a wrong-surface ref from a malformed one. A caller handing an
    // `r1:` ref to a calendar tool has made a different mistake from one that
    // invented a string, and telling them apart saves a retry.
    if (/^[a-z]\d+$/.test(version)) {
      throw new PreconditionError(
        `That is a "${version}:" ref, which belongs to another surface. This server issues ` +
          `"${REF_VERSION}:" refs — get one from apple_calendar_list_events or ` +
          `apple_calendar_search_events.`,
      );
    }
    throw new PreconditionError(
      `Malformed calendar ref ${JSON.stringify(raw)}. Refs come from the search and list tools — ` +
        `construct them from those results rather than by hand.`,
      { expected: `${REF_VERSION}:<calendarUid>/<occurrence>/<eventUid>` },
    );
  }

  const body = text.slice(colon + 1);
  const first = body.indexOf(SEPARATOR);
  const second = body.indexOf(SEPARATOR, first + 1);
  if (first === -1 || second === -1) {
    throw new PreconditionError(
      `Malformed calendar ref ${JSON.stringify(raw)}: expected two "${SEPARATOR}" separators.`,
      { expected: `${REF_VERSION}:<calendarUid>/<occurrence>/<eventUid>` },
    );
  }

  const calendarUid = body.slice(0, first);
  const occurrence = body.slice(first + 1, second);
  // Greedy: everything after the second separator. A Google uid contains no
  // "/" but is not a UUID, and an Exchange one is neither — so the tail is
  // taken whole rather than validated into a shape.
  const eventUid = body.slice(second + 1);

  if (!eventUid) {
    throw new PreconditionError(
      `Malformed calendar ref ${JSON.stringify(raw)}: it names no event.`,
      { expected: `${REF_VERSION}:<calendarUid>/<occurrence>/<eventUid>` },
    );
  }

  const occurrenceStart = occurrence === NO_OCCURRENCE ? null : fromBasic(occurrence);
  if (occurrence !== NO_OCCURRENCE && !occurrenceStart) {
    throw new PreconditionError(
      `Malformed calendar ref ${JSON.stringify(raw)}: ${JSON.stringify(occurrence)} is not an ` +
        `occurrence start. Expected ISO-8601 basic, e.g. 20260821T090000+0200, or "-".`,
    );
  }

  return { calendarUid, eventUid, occurrenceStart, isOccurrence: occurrenceStart !== null };
};

/** The series a ref belongs to. Identity for a ref that is already a series. */
export const seriesRefOf = (ref: CalendarRef): string => encodeRef(ref.calendarUid, ref.eventUid);

/** The bare UUID inside an id, when there is one. Null is legitimate, not an error. */
export const uuidOf = (id: string): string | null =>
  UUID.exec(String(id ?? ""))?.[1]?.toUpperCase() ?? null;
