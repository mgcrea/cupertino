import type { Logger } from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { parseRange, renderInstant, type EventInstant } from "./dates.js";
import { CalendarNotFoundError, EventNotFoundError, IndexUnavailableError } from "./errors.js";
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

export type CreateClientOptions = {
  config: Config;
  logger?: Logger;
  /** Injected by tests so a relative range resolves against a frozen clock. */
  now?: () => Date;
};

export class AppleCalendarClient {
  readonly config: Config;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;

  #located: LocateResult | null = null;
  #store: CalendarStore | null = null;
  #storeTried = false;

  constructor(opts: CreateClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => new Date());
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
