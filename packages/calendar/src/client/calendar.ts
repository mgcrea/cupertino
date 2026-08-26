import {
  createOsascriptRunner,
  withBusyRetry,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import {
  alignUp,
  dayWindows,
  DEFAULT_WEEKDAYS,
  localDay,
  mergeIntervals,
  nextLocalDayMs,
  parseClock,
  startOfLocalDayMs,
  subtractBusy,
  weekdaySet,
  type Interval,
  type WeekdayKey,
} from "./availability.js";
import {
  parseBound,
  parseDate,
  parseDuration,
  parseRange,
  renderInstant,
  toLocalIso,
  type EventInstant,
} from "./dates.js";
import {
  CALENDAR_SURFACE,
  CalendarNotFoundError,
  CalendarNotWritableError,
  EventNotFoundError,
  IndexUnavailableError,
  PreconditionError,
} from "./errors.js";
import { CREATE_EVENT, DELETE_EVENTS, UPDATE_EVENT } from "./jxa/write.js";
import { locateStore, type LocateResult } from "./locate.js";
import { mergeRange, type ExpansionState } from "./recurrence.js";
import { decodeRef, encodeRef, seriesRefOf } from "./ref.js";
import { CalendarStore, openStore, type EventRow, type IndexAccount } from "./store.js";

/**
 * The lane orchestrator.
 *
 * Thinner than `packages/reminders`' by design. That surface arbitrates between
 * two read lanes and caches an expensive Apple Events bulk fetch; Calendar has
 * exactly one read lane, because `docs/distribution.md` sets the policy for new
 * surfaces — file-lane reads, Apple Events for writes and live state — and
 * `docs/calendar.md` measured why: a range query over Apple Events costs 3.4 s
 * and does not improve with batching.
 *
 * So there is nothing to arbitrate. Either the store opens or the surface says
 * plainly that it cannot answer, and never returns an empty list that reads like
 * an empty calendar.
 */
export type LaneStatus = {
  /**
   * Always reported, never probed here.
   *
   * Reminders probes its Apple Events lane on every `lanes()` call because that
   * lane answers reads. Calendar's does not: it exists only for writes, which
   * are not implemented yet. Probing it would fire the Automation prompt for a
   * capability the server does not currently have, which is a worse trade than
   * saying so.
   */
  applescript: "not-used" | "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexMode: string | null;
  storeFingerprint: string | null;
  reason: string | null;
};

/**
 * EventKit's public status constants, which this store appears to mirror.
 *
 * Taken from the framework rather than measured: `EKEventStatus` and
 * `EKParticipantStatus` are documented API, and a store written by EventKit is
 * overwhelmingly likely to hold the same integers. "Overwhelmingly likely" is
 * not "measured", so both filters are off unless the caller asks, every result
 * reports its own raw `status`, and `diagnostics` says the mapping is inferred.
 * Confirming it is on the probe's list.
 */
const STATUS_CANCELLED = 3;
const PARTICIPANT_DECLINED = 3;

/**
 * `EKEventAvailability.free`, on the same inference as the two above — and held
 * to a stricter standard, because the direction it can fail in is worse.
 *
 * Reading this number wrongly makes a busy event look free, which is the one
 * error `findAvailability` exists to avoid. So unlike `status`, it is not
 * applied by default at all: `respectFreeMarking` is opt-in, the raw value
 * travels on every busy block, and until someone measures the column against a
 * live store every event blocks time regardless of how it is marked.
 */
const AVAILABILITY_FREE = 1;

/**
 * How many events `findAvailability` will read from one leg before refusing.
 *
 * `listEvents` over-fetches `limit * 4 + 50` and caps at 5,000 because it only
 * needs enough rows to fill a page. This tool needs EVERY row in the window, so
 * the number here is not a page size — it is the point past which the tool
 * stops claiming to know what is on the calendar. Sized against the measured
 * store in `docs/calendar.md` (1,350 items, 1,946 cached occurrences across
 * four years), so a year-long window on an ordinary calendar sits far under it
 * and a runaway one is caught rather than answered.
 */
const BUSY_SCAN_BOUND = 5_000;

export type EventSummary = {
  /** Opaque; feed it back to get_event or a write tool. */
  ref: string;
  summary: string | null;
  start: EventInstant | null;
  end: EventInstant | null;
  allDay: boolean;
  calendar: string | null;
  location: string | null;
  /** True when this row is one instance of a repeating event. */
  isOccurrence: boolean;
  /** Present on an occurrence: the ref naming the whole series. */
  seriesRef?: string;
  /** Raw store value, reported because the mapping above is inferred. */
  status: number | null;
  invitationStatus: number | null;
  /** Which lane produced the row. */
  source: EventRow["source"];
};

export type EventDetail = EventSummary & {
  description: string | null;
  url: string | null;
  conferenceUrl: string | null;
  hasAttendees: boolean;
  hasRecurrences: boolean;
  timeZone: string | null;
};

export type EventPage = {
  events: EventSummary[];
  expansion: ExpansionState;
  expansionReason?: string;
  /** The window actually queried, echoed so a clamp is visible. */
  window: { from: string; to: string; clamped: boolean };
  coverage: { from: string; to: string; rows: number } | null;
  truncated?: { reason: string; affects: string; uncoveredFrom?: string; uncoveredTo?: string };
  dropped?: number;
};

export type EventFilters = {
  from?: string | undefined;
  to?: string | undefined;
  calendar?: string | undefined;
  includeDeclined?: boolean | undefined;
  includeCancelled?: boolean | undefined;
  limit: number;
};

/**
 * A window of time nothing is on the calendar, long enough to hold the meeting
 * that was asked for.
 */
export type FreeSlot = {
  /** Local wall clock with its offset, ready to hand back to create_event. */
  start: string;
  end: string;
  /** The local day it falls on, so a caller can group without re-parsing. */
  day: string;
  /** How long the whole gap is — usually longer than the duration requested. */
  minutes: number;
};

export type AvailabilityFilters = {
  from?: string | undefined;
  to?: string | undefined;
  durationMinutes: number;
  calendar?: string | undefined;
  dayStart: string;
  dayEnd: string;
  weekdays?: readonly WeekdayKey[] | undefined;
  granularityMinutes: number;
  /** Let an all-day event block its whole day. Off by default — see below. */
  allDayBusy: boolean;
  /** Trust `CalendarItem.availability`. Off by default — the mapping is inferred. */
  respectFreeMarking: boolean;
  includeDeclined?: boolean | undefined;
  includeCancelled?: boolean | undefined;
  limit: number;
};

/**
 * Why an availability answer was withheld.
 *
 * A separate shape from an empty `slots` array on purpose, and the distinction
 * is the whole point of the tool: "nothing is free" and "I cannot see enough of
 * the calendar to say" look identical to a model unless one of them says so.
 */
export type AvailabilityRefusal = {
  degraded: true;
  capability: string;
  reason: string;
  hint: string;
};

export type AvailabilityResult = {
  slots: FreeSlot[];
  durationMinutes: number;
  window: {
    from: string;
    to: string;
    clamped: boolean;
    /** True when the start was pulled forward to now, dropping time already past. */
    startedAtNow: boolean;
  };
  workingHours: {
    dayStart: string;
    dayEnd: string;
    weekdays: readonly WeekdayKey[];
    granularityMinutes: number;
    /** The zone the working hours were read in — always this machine's. */
    timeZone: string;
  };
  busy: {
    /** Events that blocked time, after every filter. */
    blocking: number;
    /** Contiguous busy intervals they collapsed into. */
    intervals: number;
  };
  /**
   * All-day events overlapping the window, reported whether or not they were
   * applied. See `allDayBusy` on the tool for why this is not a default.
   */
  allDayEvents: { day: string; summary: string | null; calendar: string | null }[];
  expansion: ExpansionState;
  coverage: { from: string; to: string; rows: number } | null;
  /** Set when the window was cut back to what the expansion actually covers. */
  truncated?: { reason: string; requestedTo?: string; requestedFrom?: string };
  /** Set when the window survived every check but held no time at all. */
  note?: string;
};

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so nothing spawns a process or touches a real Calendar. */
  osascript?: OsascriptRunner;
  /** Injected by tests so a relative range resolves against a frozen clock. */
  now?: () => Date;
};

/** What a write returns: what Calendar STORED, never what was requested. */
export type WriteResult = {
  ref: string;
  uid: string | null;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  calendar: string | null;
  /** Always "apple-events": writes never touch the store. */
  source: "apple-events";
};

export type CreateEventFields = {
  summary: string;
  calendar?: string | undefined;
  start: string;
  end?: string | undefined;
  durationMinutes?: number | undefined;
  allDay?: boolean | undefined;
  location?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
};

export type UpdateEventFields = {
  ref: string;
  summary?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  durationMinutes?: number | undefined;
  allDay?: boolean | undefined;
  location?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
};

export class AppleCalendarClient {
  readonly config: Config;
  readonly runner: OsascriptRunner;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;

  #located: LocateResult | null = null;
  #store: CalendarStore | null = null;
  #storeTried = false;

  constructor(opts: CreateClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => new Date());
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        surface: CALENDAR_SURFACE,
        logger: opts.logger,
      });
  }

  /** Cached: the answer cannot change without the process being restarted anyway. */
  locate(): LocateResult {
    this.#located ??= locateStore({ storePath: this.config.storePath });
    return this.#located;
  }

  /**
   * The store, opened lazily and at most once.
   *
   * Returns null rather than throwing, because "no index" is a state the caller
   * has to render, not an exception. The reason lives on the locate result.
   */
  index(): CalendarStore | null {
    if (this.#storeTried) return this.#store;
    this.#storeTried = true;
    if (this.config.indexMode === "off") return null;
    try {
      this.#store = openStore(this.locate().storePath, this.config.indexMode, this.#logger);
    } catch (err) {
      this.#logger?.debug?.("could not open the Calendar store", err);
      this.#store = null;
    }
    return this.#store;
  }

  /**
   * Drop the open handle so the next read reopens.
   *
   * Called after a write: Calendar owns the store and reconciles it against a
   * server, so an event created over Apple Events lands in the file on the
   * app's schedule, not ours.
   */
  invalidate(): void {
    this.#store?.close();
    this.#store = null;
    this.#storeTried = false;
    this.#located = null;
  }

  // ─── reads ────────────────────────────────────────────────────────────────

  /**
   * The store, or a structured refusal.
   *
   * Never an empty list: Calendar has no Apple Events read lane to fall back to
   * (`docs/distribution.md`), so "no index" means this server cannot answer at
   * all — and an empty array would read as an empty calendar, which is the one
   * answer that must never be invented.
   */
  #require(): CalendarStore {
    const store = this.index();
    if (store) return store;
    const located = this.locate();
    throw new IndexUnavailableError(
      located.reason ??
        "The Calendar store could not be opened, and this surface has no Apple Events read " +
          "lane to fall back to. Run apple_calendar_diagnostics for the details.",
    );
  }

  #toApple(d: Date, store: CalendarStore): number {
    return Math.round(d.getTime() / 1000) - store.caps.epochOffset;
  }

  #fromApple(seconds: number, store: CalendarStore): string {
    return new Date((seconds + store.caps.epochOffset) * 1000).toISOString();
  }

  /** Resolve a caller's calendar name or uid to the uids the SQL filters on. */
  #calendarUuids(store: CalendarStore, named: string | undefined): string[] | undefined {
    const configured = this.config.calendars;
    const all = store.calendars();
    const pick = (want: string): string[] => {
      const lower = want.toLowerCase();
      const hits = all.filter(
        (c) => c.uuid?.toLowerCase() === lower || c.title?.toLowerCase() === lower,
      );
      if (!hits.length) {
        throw new CalendarNotFoundError(want, all.map((c) => c.title ?? "").filter(Boolean));
      }
      return hits.map((c) => c.uuid).filter((u): u is string => Boolean(u));
    };
    if (named) {
      const chosen = pick(named);
      // An allowlist is a boundary, not a default: naming a calendar outside it
      // must fail rather than quietly widen the scope.
      if (configured.length) {
        const allowed = new Set(configured.flatMap(pick));
        const kept = chosen.filter((u) => allowed.has(u));
        if (!kept.length) {
          throw new CalendarNotFoundError(named, configured as string[]);
        }
        return kept;
      }
      return chosen;
    }
    if (configured.length) return configured.flatMap(pick);
    return undefined;
  }

  #visible(row: EventRow, opts: { declined: boolean; cancelled: boolean }): boolean {
    if (!opts.cancelled && row.status === STATUS_CANCELLED) return false;
    if (!opts.declined && row.invitationStatus === PARTICIPANT_DECLINED) return false;
    return true;
  }

  #summarise(row: EventRow, store: CalendarStore): EventSummary {
    const start = renderInstant(row.startApple, row.startTz, row.allDay, store.caps.epochOffset);
    /**
     * OPEN: the all-day `end` convention is not settled, so it is reported RAW.
     *
     * Measured against a live calendar, creating one all-day event on
     * 21 September: Apple Events reads the end back as `2026-09-21T21:59:59`
     * (23:59:59 local — inclusive), while the store renders a day later. The two
     * legs also disagree with each other: an occurrence row reports end on the
     * same day as start, an item row a day after.
     *
     * A "subtract a second before rendering" normalisation was tried and turned
     * out to be a no-op on real data, which means the anchoring differs in a way
     * that has not been pinned down — `start_date` reads as local midnight while
     * `end_date` appears to be anchored differently. Guessing again on top of an
     * unverified premise is how the start-of-day bug got here in the first
     * place, so this stays raw and documented until the raw columns are read.
     * See docs/calendar.md, "Still open".
     */
    const end = renderInstant(
      row.endApple,
      row.endTz ?? row.startTz,
      row.allDay,
      store.caps.epochOffset,
    );
    const isOccurrence = row.source === "occurrence";
    const ref = encodeRef(
      row.calendarUuid ?? "",
      row.uuid ?? "",
      isOccurrence && row.startApple !== null
        ? new Date((row.startApple + store.caps.epochOffset) * 1000)
        : null,
    );
    return {
      ref,
      summary: row.summary,
      start,
      end,
      allDay: row.allDay,
      calendar: row.calendarTitle,
      location: row.locationTitle,
      isOccurrence,
      ...(isOccurrence ? { seriesRef: encodeRef(row.calendarUuid ?? "", row.uuid ?? "") } : {}),
      status: row.status,
      invitationStatus: row.invitationStatus,
      source: row.source,
    };
  }

  listEvents(filters: EventFilters): EventPage {
    const store = this.#require();
    const range = parseRange(
      {
        from: filters.from,
        to: filters.to,
        defaultRangeDays: this.config.defaultRangeDays,
        maxRangeDays: this.config.maxRangeDays,
      },
      this.#now(),
    );
    const fromApple = this.#toApple(range.from, store);
    const toApple = this.#toApple(range.to, store);
    const calendarUuids = this.#calendarUuids(store, filters.calendar);

    // Over-fetch each leg: status filters are applied in JS below, so a limit
    // pushed into SQL would cut the result before those ran.
    const legLimit = Math.min(filters.limit * 4 + 50, 5_000);
    const q = { fromApple, toApple, limit: legLimit, ...(calendarUuids ? { calendarUuids } : {}) };

    const merged = mergeRange({
      items: store.rangeItems(q),
      occurrences: store.rangeOccurrences(q),
      coverage: store.coverage(),
      hasOccurrenceCache: store.caps.hasOccurrenceCache,
      fromApple,
      toApple,
      limit: legLimit,
      epochOffset: store.caps.epochOffset,
    });

    const declined = filters.includeDeclined ?? this.config.includeDeclined;
    const cancelled = filters.includeCancelled ?? this.config.includeCancelled;
    const events = merged.rows
      .filter((r) => this.#visible(r, { declined, cancelled }))
      .slice(0, filters.limit)
      .map((r) => this.#summarise(r, store));

    return {
      events,
      expansion: merged.expansion,
      ...(merged.expansionReason ? { expansionReason: merged.expansionReason } : {}),
      window: {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        clamped: range.clamped,
      },
      coverage: merged.coverage
        ? {
            from: this.#fromApple(merged.coverage.fromApple, store),
            to: this.#fromApple(merged.coverage.toApple, store),
            rows: merged.coverage.rows,
          }
        : null,
      ...(merged.truncated
        ? {
            truncated: {
              reason: merged.truncated.reason,
              affects: merged.truncated.affects,
              ...(merged.truncated.uncoveredFromApple !== undefined
                ? { uncoveredFrom: this.#fromApple(merged.truncated.uncoveredFromApple, store) }
                : {}),
              ...(merged.truncated.uncoveredToApple !== undefined
                ? { uncoveredTo: this.#fromApple(merged.truncated.uncoveredToApple, store) }
                : {}),
            },
          }
        : {}),
      ...(merged.dropped ? { dropped: merged.dropped } : {}),
    };
  }

  /**
   * Text search over events.
   *
   * Runs on items only. An occurrence carries no text of its own, so matching
   * the series once is what a search result should be — expanding it here would
   * bury one answer under fifty identical ones.
   */
  searchEvents(
    args: EventFilters & { query: string; scope?: "summary" | "full" | undefined },
  ): EventPage {
    const store = this.#require();
    const now = this.#now();
    // Unbounded by default: search is the one place a caller legitimately wants
    // all of history, so an absent bound means "no bound" rather than a week.
    const fromApple = args.from
      ? this.#toApple(
          parseRange({ from: args.from, to: args.from, defaultRangeDays: 1, maxRangeDays: 1 }, now)
            .from,
          store,
        )
      : Number.MIN_SAFE_INTEGER;
    const toApple = args.to
      ? this.#toApple(
          parseRange({ from: args.to, to: args.to, defaultRangeDays: 1, maxRangeDays: 1 }, now).to,
          store,
        )
      : Number.MAX_SAFE_INTEGER;
    const calendarUuids = this.#calendarUuids(store, args.calendar);

    const rows = store.searchItems({
      fromApple,
      toApple,
      limit: Math.min(args.limit * 4 + 50, 5_000),
      text: args.query,
      scope: args.scope ?? "summary",
      ...(calendarUuids ? { calendarUuids } : {}),
    });

    const declined = args.includeDeclined ?? this.config.includeDeclined;
    const cancelled = args.includeCancelled ?? this.config.includeCancelled;
    return {
      events: rows
        .filter((r) => this.#visible(r, { declined, cancelled }))
        .slice(0, args.limit)
        .map((r) => this.#summarise(r, store)),
      // Search does not expand, and says so rather than implying it did.
      expansion: "unavailable",
      expansionReason:
        "search matches each event once, at its series start; use apple_calendar_list_events " +
        "with a date range to see individual occurrences",
      window: {
        from: args.from ? this.#fromApple(fromApple, store) : "unbounded",
        to: args.to ? this.#fromApple(toApple, store) : "unbounded",
        clamped: false,
      },
      coverage: null,
    };
  }

  /**
   * When nothing is on the calendar, for long enough to hold a meeting.
   *
   * ## Why this is not list_events with arithmetic bolted on
   *
   * Every other read here returns what it found and flags what it missed, and
   * a caller reads the flag or does not. This one INVERTS the events: what it
   * returns is the complement of what it read, so anything the read missed
   * comes back as free time. A page limit, an unexpanded weekly meeting, an
   * event past the coverage edge — each of those shortens a `list_events`
   * result harmlessly and each of them, here, invents a slot that is already
   * booked. `docs/calendar.md` names the failure directly: "a short list of
   * events is indistinguishable from a free afternoon."
   *
   * So the busy set is either complete or the answer is withheld. Three checks
   * enforce that, and each returns a refusal rather than a short list:
   *
   *   1. the scan bound, so a saturated leg never passes for a quiet week
   *   2. the expansion, because an unexpanded series is invisible on every
   *      date but one
   *   3. the coverage edge, past which repeating events simply are not there
   *
   * The third clips the window rather than refusing outright, because the part
   * inside the edge is genuinely answerable — but it says what it cut.
   */
  findAvailability(args: AvailabilityFilters): AvailabilityResult | AvailabilityRefusal {
    const store = this.#require();
    const now = this.#now();
    const range = parseRange(
      {
        from: args.from,
        to: args.to,
        defaultRangeDays: this.config.defaultRangeDays,
        maxRangeDays: this.config.maxRangeDays,
      },
      now,
    );

    const dayStart = parseClock("dayStart", args.dayStart);
    const dayEnd = parseClock("dayEnd", args.dayEnd);
    const weekdayKeys = args.weekdays?.length ? args.weekdays : DEFAULT_WEEKDAYS;
    const weekdays = weekdaySet(weekdayKeys);
    const calendarUuids = this.#calendarUuids(store, args.calendar);

    const fromApple = this.#toApple(range.from, store);
    const toApple = this.#toApple(range.to, store);
    const q = {
      fromApple,
      toApple,
      limit: BUSY_SCAN_BOUND,
      ...(calendarUuids ? { calendarUuids } : {}),
    };
    const items = store.rangeItems(q);
    const occurrences = store.rangeOccurrences(q);

    // A leg that came back exactly full was cut by SQL's LIMIT, and what it cut
    // is the tail of the window — so the later half of the answer would be
    // uniformly free. A refusal, not an empty result.
    if (items.length >= BUSY_SCAN_BOUND || occurrences.length >= BUSY_SCAN_BOUND) {
      return {
        degraded: true,
        capability: "busy-set",
        reason:
          `The window holds at least ${BUSY_SCAN_BOUND} events, which is the bound on what this ` +
          'tool reads. Nothing was computed, so this is not "you have no free time" and not ' +
          '"you are entirely free" — it is no answer at all.',
        hint:
          "Ask for a shorter window, or scope it to the calendars that matter with `calendar`. " +
          "apple_calendar_list_events will still page through the range as it is.",
      };
    }

    const merged = mergeRange({
      items,
      occurrences,
      coverage: store.coverage(),
      hasOccurrenceCache: store.caps.hasOccurrenceCache,
      fromApple,
      toApple,
      // Nothing may be sliced off: both legs are already under the bound above.
      limit: items.length + occurrences.length,
      epochOffset: store.caps.epochOffset,
    });

    if (merged.expansion === "unavailable") {
      return {
        degraded: true,
        capability: "occurrence-expansion",
        reason:
          "Repeating events are not expanded on this store, so a weekly meeting exists on the " +
          "date its series begins and nowhere else. Every gap computed from that would be wrong " +
          `in the same direction — free where it is booked. ${merged.expansionReason ?? ""}`.trim(),
        hint:
          "Read the schedule directly with apple_calendar_list_events, which reports the same " +
          "limitation rather than hiding it behind an answer.",
      };
    }

    let windowFrom = range.from;
    let windowTo = range.to;
    let truncated: AvailabilityResult["truncated"];
    const cov = merged.coverage;
    if (cov) {
      const covFrom = new Date((cov.fromApple + store.caps.epochOffset) * 1000);
      const covTo = new Date((cov.toApple + store.caps.epochOffset) * 1000);
      const reason =
        "the requested window runs past the range this store has expanded, where repeating " +
        "events are missing entirely; it was cut back rather than reporting that time as free";
      if (windowTo.getTime() > covTo.getTime()) {
        truncated = { reason, requestedTo: toLocalIso(range.to) };
        windowTo = covTo;
      }
      if (windowFrom.getTime() < covFrom.getTime()) {
        truncated = { ...(truncated ?? { reason }), requestedFrom: toLocalIso(range.from) };
        windowFrom = covFrom;
      }
      if (truncated && windowTo.getTime() <= windowFrom.getTime()) {
        return {
          degraded: true,
          capability: "occurrence-coverage",
          reason:
            "The whole requested window lies outside the range this store has expanded, so " +
            "every gap in it would be invented rather than found.",
          hint:
            `The expansion reaches ${toLocalIso(covFrom)} to ${toLocalIso(covTo)}. ` +
            "Ask inside that, or use apple_calendar_list_events, which reports single events " +
            "correctly at any distance.",
        };
      }
    }

    // Time already gone is not availability. Applied after the coverage cut so
    // the two reasons a window shrank stay distinguishable in the result.
    const startedAtNow = windowFrom.getTime() < now.getTime();
    if (startedAtNow) windowFrom = now;

    const shell = {
      durationMinutes: args.durationMinutes,
      window: {
        from: toLocalIso(windowFrom),
        to: toLocalIso(windowTo),
        clamped: range.clamped,
        startedAtNow,
      },
      workingHours: {
        dayStart: args.dayStart,
        dayEnd: args.dayEnd,
        weekdays: weekdayKeys,
        granularityMinutes: args.granularityMinutes,
        // The machine's zone, always: working hours are wall-clock hours, and
        // this server does not re-anchor a calendar day in another zone.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      expansion: merged.expansion,
      coverage: cov
        ? {
            from: this.#fromApple(cov.fromApple, store),
            to: this.#fromApple(cov.toApple, store),
            rows: cov.rows,
          }
        : null,
      ...(truncated ? { truncated } : {}),
    };

    if (windowTo.getTime() <= windowFrom.getTime()) {
      return {
        ...shell,
        slots: [],
        busy: { blocking: 0, intervals: 0 },
        allDayEvents: [],
        note:
          "The window holds no future time — every moment in it has already passed. Nothing was " +
          "checked, so this is not a report that you are busy.",
      };
    }

    const declined = args.includeDeclined ?? this.config.includeDeclined;
    const cancelled = args.includeCancelled ?? this.config.includeCancelled;
    const busy: Interval[] = [];
    const allDayEvents: AvailabilityResult["allDayEvents"] = [];
    let blocking = 0;

    for (const row of merged.rows) {
      if (row.startApple === null) continue;
      if (!this.#visible(row, { declined, cancelled })) continue;
      const startMs = (row.startApple + store.caps.epochOffset) * 1000;

      if (row.allDay) {
        const dayOpen = startOfLocalDayMs(startMs);
        const dayShut = nextLocalDayMs(startMs);
        if (dayOpen < windowTo.getTime() && dayShut > windowFrom.getTime()) {
          const rendered = renderInstant(row.startApple, row.startTz, true, store.caps.epochOffset);
          allDayEvents.push({
            day: rendered?.allDay ? rendered.day : localDay(startMs),
            summary: row.summary,
            calendar: row.calendarTitle,
          });
        }
        if (!args.allDayBusy) continue;
        /*
         * The stored end of an all-day event is not settled — see #summarise,
         * and docs/calendar.md, "Still open". So the block is anchored on the
         * DAY the event renders on and closed at the later of the next midnight
         * and whatever the end column says, which errs long. Long is the safe
         * direction: an over-long block hides a slot that existed, a short one
         * offers a slot that did not.
         */
        const endMs =
          row.endApple === null ? dayShut : (row.endApple + store.caps.epochOffset) * 1000;
        busy.push({ from: dayOpen, to: Math.max(dayShut, startOfLocalDayMs(endMs)) });
        blocking += 1;
        continue;
      }

      if (args.respectFreeMarking && row.availability === AVAILABILITY_FREE) continue;
      const endMs =
        row.endApple === null ? startMs : (row.endApple + store.caps.epochOffset) * 1000;
      // A zero-length event is a marker, not an appointment; it blocks nothing.
      if (endMs <= startMs) continue;
      busy.push({ from: startMs, to: endMs });
      blocking += 1;
    }

    const blocks = mergeIntervals(busy);
    const needMs = args.durationMinutes * 60_000;
    const slots: FreeSlot[] = [];
    outer: for (const w of dayWindows({
      from: windowFrom,
      to: windowTo,
      dayStart,
      dayEnd,
      weekdays,
    })) {
      for (const gap of subtractBusy(w, blocks)) {
        // Align first, then re-measure: a gap opening at 09:07 offers a 09:15
        // start, and the seven minutes in between are not bookable time.
        const start = alignUp(gap.from, args.granularityMinutes);
        if (gap.to - start < needMs) continue;
        slots.push({
          start: toLocalIso(new Date(start)),
          end: toLocalIso(new Date(gap.to)),
          day: localDay(start),
          minutes: Math.round((gap.to - start) / 60_000),
        });
        if (slots.length >= args.limit) break outer;
      }
    }

    return {
      ...shell,
      slots,
      busy: { blocking, intervals: blocks.length },
      allDayEvents,
    };
  }

  getEvent(ref: string): EventDetail {
    const store = this.#require();
    const decoded = decodeRef(ref);
    const row = store.byUuid(decoded.eventUid);
    if (!row) throw new EventNotFoundError(ref);

    // An occurrence ref names an instant the master row does not carry, so the
    // start is taken from the ref rather than from the row it resolved to.
    const shaped: EventRow = decoded.occurrenceStart
      ? {
          ...row,
          startApple: this.#toApple(decoded.occurrenceStart, store),
          endApple:
            row.startApple !== null && row.endApple !== null
              ? this.#toApple(decoded.occurrenceStart, store) + (row.endApple - row.startApple)
              : row.endApple,
          source: "occurrence",
        }
      : row;

    const summary = this.#summarise(shaped, store);
    return {
      ...summary,
      ref,
      ...(decoded.isOccurrence ? { seriesRef: seriesRefOf(decoded) } : {}),
      description: row.description,
      url: row.url,
      conferenceUrl: row.conferenceUrl,
      hasAttendees: row.hasAttendees,
      hasRecurrences: row.hasRecurrences,
      timeZone: summary.start && !summary.start.allDay ? summary.start.timeZone : null,
    };
  }

  calendars() {
    return this.#require().calendars();
  }

  accounts(): IndexAccount[] {
    return this.#require().accounts();
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  /**
   * Resolve the calendar a write targets, and refuse a read-only one up front.
   *
   * Asking the store first means the refusal names the cause. Letting the Apple
   * Event fail instead produces a message from deep inside Calendar that does
   * not mention writability at all.
   */
  #writeTarget(named: string | undefined): { name: string | undefined; uuid: string | null } {
    const store = this.index();
    const wanted = named ?? this.config.defaultCalendar;
    if (!store) {
      // No store to check against. The JXA script asks Calendar itself, so the
      // guard is not lost — only the earlier, better-worded error is.
      return { name: wanted, uuid: null };
    }
    const all = store.calendars();
    if (!wanted) return { name: undefined, uuid: null };

    const lower = wanted.toLowerCase();
    const hits = all.filter(
      (c) => c.uuid?.toLowerCase() === lower || c.title?.toLowerCase() === lower,
    );
    if (!hits.length) {
      throw new CalendarNotFoundError(wanted, all.map((c) => c.title ?? "").filter(Boolean));
    }

    /**
     * Duplicate titles are real: the machine this was measured on has two
     * calendars both named `olouvignes@me.com`. A read can legitimately span
     * both, but a write has to land in exactly one — and only a NAME crosses to
     * Apple Events, so an ambiguous one is refused rather than resolved by coin
     * flip.
     */
    if (hits.length > 1) {
      throw new PreconditionError(
        `"${wanted}" matches ${hits.length} calendars, and a write has to name exactly one. ` +
          `Calendars are addressed by name when writing — Apple Events cannot resolve a ` +
          `calendar uid at all — so duplicates cannot be told apart. Rename one in Calendar.app, ` +
          `or write to a calendar whose name is unique.`,
        { requested: wanted, matches: hits.length },
      );
    }
    const hit = hits[0]!;
    if (hit.isSubscribed) throw new CalendarNotWritableError(hit.title ?? wanted);
    // The NAME is what crosses the boundary; the uuid is kept only for the ref.
    return { name: hit.title ?? wanted, uuid: hit.uuid };
  }

  /** Map a calendar name reported by Apple Events back to its store uuid. */
  #calendarUuidByName(name: string | null): string | null {
    if (!name) return null;
    const store = this.index();
    if (!store) return null;
    return store.calendars().find((c) => c.title === name)?.uuid ?? null;
  }

  /**
   * The calendar NAME a ref points at, for a write.
   *
   * A ref carries the store uuid, which Apple Events cannot resolve, so it has
   * to be turned back into a name before it crosses.
   */
  #nameForRefCalendar(calendarUid: string): string | undefined {
    if (!calendarUid) return undefined;
    const store = this.index();
    if (!store) return undefined;
    const lower = calendarUid.toLowerCase();
    return store.calendars().find((c) => c.uuid?.toLowerCase() === lower)?.title ?? undefined;
  }

  /**
   * Run a write script, re-inflating its application-level failures.
   *
   * Core turns a `{ok:false, error:{code, message}}` envelope into a generic
   * `ProtocolError` carrying the code, which surfaces as a bare `"Birthdays"`.
   * That matters more here than it looks: the store-side writability check is
   * derived from `subcal_url` and MISSES calendars that are read-only for other
   * reasons — Birthdays and Siri Suggestions both report `writable() === false`
   * while carrying no subscription URL. The JXA lane catches them correctly, so
   * the only thing lost was the explanation. This puts it back.
   */
  async #run<T>(scriptText: string, params: unknown): Promise<T> {
    try {
      return await withBusyRetry(() => this.runner.run<T>(scriptText, params));
    } catch (err) {
      const code = (err as { details?: { code?: string } })?.details?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "CALENDAR_NOT_WRITABLE") throw new CalendarNotWritableError(message);
      if (code === "CALENDAR_NOT_FOUND") throw new CalendarNotFoundError(message);
      if (code === "EVENT_NOT_FOUND") throw new EventNotFoundError(message);
      throw err;
    }
  }

  #shapeWrite(data: Record<string, unknown>, calendarUid: string | null): WriteResult {
    const uid = typeof data.uid === "string" ? data.uid : null;
    return {
      ref: encodeRef(calendarUid ?? "", uid ?? ""),
      uid,
      summary: typeof data.summary === "string" ? data.summary : null,
      start: typeof data.startDate === "string" ? data.startDate : null,
      end: typeof data.endDate === "string" ? data.endDate : null,
      allDay: data.alldayEvent === true,
      calendar: typeof data.calendarName === "string" ? data.calendarName : null,
      source: "apple-events",
    };
  }

  /**
   * Work out an event's end from whichever of the three forms the caller used.
   *
   * `end` wins over `durationMinutes`; with neither, the configured default
   * length applies. A zero-length event is refused rather than created, because
   * Calendar renders one as a point in time that is almost impossible to click.
   */
  #resolveWindow(
    start: string,
    end: string | undefined,
    durationMinutes: number | undefined,
  ): { startIso: string; endIso: string; allDayHint: boolean } {
    const now = this.#now();
    const from = parseDate("start", start, now);
    if (end !== undefined) {
      /**
       * A bare day as `end` means THROUGH that day, not midnight at its start.
       *
       * `parseBound` already encodes this for range queries, and list_events
       * documents it — "naming the same day for both gives that whole day". Using
       * plain `parseDate` here made create disagree with list about the same
       * word: `{start: "2026-09-21", end: "2026-09-21"}`, the natural way to say
       * "a one-day event", was refused as ending before it began.
       */
      const to = parseBound("end", end, "end", now);
      if (to.getTime() <= from.at.getTime()) {
        throw new PreconditionError(
          `end (${toLocalIso(to)}) is not after start (${from.iso}). An event cannot finish ` +
            `before it begins.`,
        );
      }
      return { startIso: from.iso, endIso: toLocalIso(to), allDayHint: from.kind === "allDay" };
    }
    const minutes =
      durationMinutes === undefined
        ? this.config.defaultEventDurationMinutes
        : parseDuration("durationMinutes", durationMinutes);
    const to = new Date(from.at.getTime() + minutes * 60_000);
    return {
      startIso: from.iso,
      endIso: toLocalIso(to),
      allDayHint: from.kind === "allDay",
    };
  }

  async createEvent(fields: CreateEventFields): Promise<WriteResult> {
    const target = this.#writeTarget(fields.calendar);
    const win = this.#resolveWindow(fields.start, fields.end, fields.durationMinutes);
    const data = await this.#run<Record<string, unknown>>(CREATE_EVENT, {
      calendar: target.name ?? null,
      summary: fields.summary,
      startDate: win.startIso,
      endDate: win.endIso,
      // A bare day in `start` already means all-day; an explicit flag overrides.
      allDay: fields.allDay ?? win.allDayHint,
      ...(fields.location !== undefined ? { location: fields.location } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.url !== undefined ? { url: fields.url } : {}),
    });
    this.invalidate();
    // Prefer the uuid we resolved; fall back to looking up whichever calendar
    // Calendar actually used, which is the default-calendar case.
    const uuid =
      target.uuid ??
      this.#calendarUuidByName(typeof data.calendarName === "string" ? data.calendarName : null);
    return this.#shapeWrite(data, uuid);
  }

  async updateEvent(fields: UpdateEventFields): Promise<WriteResult> {
    const ref = decodeRef(fields.ref);
    /**
     * An occurrence ref is REFUSED rather than quietly applied to the series.
     *
     * Calendar's scripting dictionary has no way to detach a single occurrence —
     * the "This Event" edit in the UI has no scripting equivalent. Applying the
     * change to the series would move every future standup because someone
     * asked to move one lunch, which is a data-loss bug wearing a success
     * message. "All future" is absent for a related reason: it needs a rule
     * split, which is two writes with no transaction between them.
     */
    if (ref.isOccurrence) {
      throw new PreconditionError(
        `That ref names one occurrence of a repeating event, and Calendar's scripting interface ` +
          `cannot edit a single occurrence — only the whole series. Applying your change to the ` +
          `series would move every other occurrence too, so this is refused rather than done ` +
          `silently. To change just this one: delete it with apple_calendar_delete_events ` +
          `(scope "occurrence"), then create a replacement. To change them all, pass the ` +
          `seriesRef from apple_calendar_get_event instead.`,
        { ref: fields.ref, seriesRef: seriesRefOf(ref) },
      );
    }

    const window =
      fields.start !== undefined
        ? this.#resolveWindow(fields.start, fields.end, fields.durationMinutes)
        : null;

    const data = await this.#run<Record<string, unknown>>(UPDATE_EVENT, {
      calendar: this.#nameForRefCalendar(ref.calendarUid) ?? null,
      uid: ref.eventUid,
      ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
      ...(window ? { startDate: window.startIso, endDate: window.endIso } : {}),
      ...(fields.allDay !== undefined ? { allDay: fields.allDay } : {}),
      ...(fields.location !== undefined ? { location: fields.location } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
      ...(fields.url !== undefined ? { url: fields.url } : {}),
    });
    this.invalidate();
    return this.#shapeWrite(data, ref.calendarUid);
  }

  /**
   * Delete whole events.
   *
   * Only whole events: Calendar's scripting interface cannot remove a single
   * occurrence of a repeating one. `excludedDates` — the property Calendar.app
   * itself uses for "Delete This Event" — reads back a 1903 sentinel and throws
   * on assignment, measured on macOS 26.6. So an occurrence ref is refused
   * rather than silently deleting the whole series, which is the same shape of
   * refusal `updateEvent` makes and for the same underlying reason.
   */
  async deleteEvents(refs: readonly string[]): Promise<{ results: unknown[]; scope: string }> {
    const decoded = refs.map((r, i) => ({ ref: refs[i]!, parsed: decodeRef(r) }));

    const occurrence = decoded.find((d) => d.parsed.isOccurrence);
    if (occurrence) {
      throw new PreconditionError(
        `That ref names one occurrence of a repeating event, and Calendar's scripting interface ` +
          `cannot delete a single occurrence — the excluded-dates property it would need is not ` +
          `writable. Deleting the series instead would remove every other occurrence too, so ` +
          `this is refused rather than done silently. Delete this one in Calendar.app, or pass ` +
          `the seriesRef from apple_calendar_get_event to delete the whole series.`,
        { ref: occurrence.ref, seriesRef: seriesRefOf(occurrence.parsed) },
      );
    }

    // Grouped by calendar: findEvent costs one bulk uid fetch per calendar, so
    // deleting five events from one calendar should pay that once, not five times.
    const byCalendar = new Map<string, string[]>();
    for (const { parsed } of decoded) {
      const key = parsed.calendarUid || "";
      byCalendar.set(key, [...(byCalendar.get(key) ?? []), parsed.eventUid]);
    }
    const results: unknown[] = [];
    for (const [calendar, uids] of byCalendar) {
      const data = await this.#run<{ results: unknown[] }>(DELETE_EVENTS, {
        calendar: this.#nameForRefCalendar(calendar) ?? null,
        uids,
      });
      results.push(...(data.results ?? []));
    }
    this.invalidate();
    return { results, scope: "series" };
  }

  lanes(): LaneStatus {
    const located = this.locate();
    const store = this.index();
    return {
      applescript: "not-used",
      index: this.config.indexMode === "off" ? "disabled" : store ? "live" : "unavailable",
      indexMode: store?.mode ?? null,
      storeFingerprint: store?.caps.fingerprint ?? null,
      reason: store ? null : located.reason,
    };
  }
}
