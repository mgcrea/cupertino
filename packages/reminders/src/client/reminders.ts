import {
  createOsascriptRunner,
  withBusyRetry,
  type Logger,
  type OsascriptRunner,
} from "@mgcrea/mcp-apple-core";

import type { Config } from "../config.js";
import { parseBound, parseDate, type ParsedDate } from "./dates.js";
import { ListNotFoundError, ReminderNotFoundError, REMINDERS_SURFACE } from "./errors.js";
import { BULK_REMINDERS, GET_REMINDERS, LIST_ACCOUNTS, LIST_LISTS } from "./jxa/read.js";
import {
  COMPLETE_REMINDERS,
  CREATE_REMINDER,
  DELETE_REMINDERS,
  MOVE_REMINDERS,
  UPDATE_REMINDER,
} from "./jxa/write.js";
import { locateStore, type LocateResult } from "./locate.js";
import { toPriorityName, toPriorityValue, type PriorityName } from "./priority.js";
import { decodeRef, encodeRef, refFromUuid } from "./ref.js";
import { openStore, ReminderStore, type IndexEnrichment, type IndexReminder } from "./store.js";

export type LaneStatus = {
  applescript: "live" | "unavailable";
  index: "live" | "unavailable" | "disabled";
  indexMode: string | null;
  storeFingerprint: string | null;
  reason: string | null;
};

export type ReminderAccount = {
  id: string | null;
  name: string | null;
  isDefault: boolean;
  listCount: number;
  reminderCount: number;
};

export type ReminderList = {
  id: string | null;
  name: string | null;
  accountId: string | null;
  accountName: string | null;
  depth: number;
  color: string | null;
  emblem: string | null;
  isDefault: boolean;
  reminderCount: number | null;
  incompleteCount: number | null;
};

export type ReminderSummary = {
  ref: string;
  name: string | null;
  completed: boolean;
  /** The effective due instant, whichever of the two properties carries it. */
  due: string | null;
  /** True when the due date names a day rather than a time. */
  dueAllDay: boolean;
  /**
   * Where `dueAllDay` came from.
   *
   * `index` is `ZALLDAY`, which is authoritative. `heuristic` means the index
   * was unavailable and the flag was inferred from the due time being local
   * midnight — because Apple Events populates BOTH date properties for every
   * dated reminder and so cannot answer the question itself.
   */
  dueAllDaySource: "index" | "heuristic";
  remindMe: string | null;
  priority: PriorityName;
  flagged: boolean;
  list: string | null;
  account: string | null;
  /** Set when this reminder's container is another reminder, i.e. it is a subtask. */
  parentRef: string | null;
  created: string | null;
  modified: string | null;
  source: "index" | "apple-events";
};

export type ReminderDetail = ReminderSummary & {
  body: string | null;
  completionDate: string | null;
  /** Kept separate from `due` so a caller can see which property actually holds it. */
  dueDate: string | null;
  alldayDueDate: string | null;
  subtasks: ReminderSummary[];
  /**
   * Fields the scripting dictionary has no class for. Null — not empty — when
   * the index lane is unavailable, so a caller can tell "none" from "unknown".
   */
  attachments: { id: string | null; filename: string | null; uti: string | null }[] | null;
  alarms: IndexEnrichment | null;
};

/** Filters accepted by list and search. Every one is applied in JS over bulk arrays. */
export type ReminderFilters = {
  list?: string | undefined;
  includeCompleted?: boolean | undefined;
  dueBefore?: string | undefined;
  dueAfter?: string | undefined;
  flagged?: boolean | undefined;
  priority?: PriorityName | undefined;
  hasDueDate?: boolean | undefined;
  limit: number;
};

/** The fields a create or update may set. Absent means "leave alone". */
export type ReminderFields = {
  name?: string | undefined;
  body?: string | null | undefined;
  due?: string | undefined;
  remindMe?: string | undefined;
  priority?: PriorityName | undefined;
  flagged?: boolean | undefined;
  completed?: boolean | undefined;
};

/** One row as the bulk read returns it, before any interpretation. */
type RawReminder = {
  id: string;
  name: string | null;
  body: string | null;
  completed: boolean | null;
  completionDate: string | null;
  dueDate: string | null;
  alldayDueDate: string | null;
  remindMeDate: string | null;
  priority: number | null;
  flagged: boolean | null;
  created: string | null;
  modified: string | null;
  list: string | null;
  listId: string | null;
  account: string | null;
  accountId: string | null;
  parentId: string | null;
  /** Local-midnight heuristic computed inside JXA, where the time zone is real. */
  allDayGuess?: boolean;
  /** The local calendar day, also computed inside JXA. See jxa/core.ts. */
  dueDay?: string | null;
};

type BulkPayload = {
  count: number;
  reminders: RawReminder[];
  lists: { id: string | null; name: string | null; accountId: string | null }[];
  unmapped: number;
  membershipVia: "nested" | "per-list";
};

type BulkCache = { at: number; data: BulkPayload };

/**
 * Render a due date for the caller.
 *
 * An all-day reminder names a DAY, and reporting it as an instant is wrong
 * rather than merely ugly — the same value reads as a different date either
 * side of Greenwich.
 *
 * Which day, though, depends on the lane, because the two genuinely disagree.
 * The same reminder, due 9 November, measured on a real library:
 *
 *     Apple Events   2025-11-08T23:00:00Z   LOCAL midnight (Paris, UTC+1)
 *     ZDUEDATE       2025-11-09T00:00:00Z   UTC   midnight
 *
 * So neither lane's string can be sliced by the other's rule. Each converts on
 * its own terms — JXA formats from local components, the store from UTC — and
 * hands the finished day in here.
 */
const renderDue = (instant: string | null, allDay: boolean, day: string | null): string | null =>
  allDay ? day : instant;

/** The store keeps all-day dates at UTC midnight, so the UTC date IS the day. */
const utcDay = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);

/** Sort key for due dates: undated reminders sort last rather than first. */
const dueAt = (s: ReminderSummary): number =>
  s.due ? new Date(s.due).getTime() : Number.MAX_SAFE_INTEGER;

export type AppleRemindersClientOptions = {
  config: Config;
  logger?: Logger | undefined;
  /** Injected by tests so nothing spawns a process or touches a real Reminders. */
  osascript?: OsascriptRunner | undefined;
  /** Injected by tests so the TTL cache can be exercised without waiting. */
  now?: (() => Date) | undefined;
};

/**
 * The Reminders client.
 *
 * Two lanes, and which one answers depends on what was granted:
 *
 * - **Apple Events** — accounts, lists, every mutation, and the whole core
 *   model. Always the authority: after a write, the result is what Reminders
 *   re-read, never what was requested.
 * - **Index** — the Core Data store, for the fields the scripting dictionary
 *   has no class for at all: tags, url, recurrence, alarms.
 *
 * That split is the opposite way round from Mail, where the file lane exists
 * because Apple Events search took 74 seconds. Here the dictionary is complete
 * enough to ship on, and the permission buys capability rather than speed —
 * which is the rule recorded in docs/distribution.md.
 */
export class AppleRemindersClient {
  readonly config: Config;
  readonly runner: OsascriptRunner;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;
  #cache: BulkCache | null = null;
  #store: ReminderStore | null = null;
  #storeTried = false;

  constructor(opts: AppleRemindersClientOptions) {
    this.config = opts.config;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => new Date());
    this.runner =
      opts.osascript ??
      createOsascriptRunner({
        osascriptPath: opts.config.osascriptPath,
        timeoutMs: opts.config.osascriptTimeoutMs,
        surface: REMINDERS_SURFACE,
        logger: opts.logger,
      });
  }

  locate(): LocateResult {
    return locateStore({ storePath: this.config.storePath });
  }

  /** Open the index once and remember the outcome, including the failure. */
  index(): ReminderStore | null {
    if (this.#storeTried) return this.#store;
    this.#storeTried = true;
    if (this.config.indexMode === "off") return null;
    try {
      this.#store = openStore(this.locate().storePath, this.config.indexMode, this.#logger);
    } catch (err) {
      this.#logger?.debug?.("index lane unavailable", err);
      this.#store = null;
    }
    return this.#store;
  }

  /**
   * Probe both lanes.
   *
   * Apple Events is probed twice with a gap: the first event is what triggers
   * the Automation prompt, and it can return failure while the user is still
   * deciding — reporting "denied" then would be wrong.
   */
  async lanes(): Promise<LaneStatus> {
    let applescript: LaneStatus["applescript"] = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.runner.run(LIST_ACCOUNTS);
        applescript = "live";
        break;
      } catch (err) {
        this.#logger?.debug?.("applescript probe failed", err);
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }

    const located = this.locate();
    const store = this.index();
    return {
      applescript,
      index: this.config.indexMode === "off" ? "disabled" : store ? "live" : "unavailable",
      indexMode: store?.mode ?? null,
      storeFingerprint: store?.caps.fingerprint ?? null,
      reason: store ? null : located.reason,
    };
  }

  // ─── reads ────────────────────────────────────────────────────────────────

  #allowedAccount(name: string | null): boolean {
    const list = this.config.accounts;
    if (!list.length) return true;
    return Boolean(name && list.some((a) => a.toLowerCase() === name.toLowerCase()));
  }

  #allowedList(name: string | null): boolean {
    const list = this.config.lists;
    if (!list.length) return true;
    return Boolean(name && list.some((l) => l.toLowerCase() === name.toLowerCase()));
  }

  async accounts(): Promise<ReminderAccount[]> {
    const data = await withBusyRetry(() =>
      this.runner.run<{ accounts: ReminderAccount[] }>(LIST_ACCOUNTS),
    );
    return data.accounts.filter((a) => this.#allowedAccount(a.name));
  }

  async lists(): Promise<ReminderList[]> {
    const all = await withBusyRetry(() => this.runner.run<ReminderList[]>(LIST_LISTS));
    return all.filter((l) => this.#allowedAccount(l.accountName) && this.#allowedList(l.name));
  }

  /**
   * Every reminder, cached on a TTL.
   *
   * Same trade Notes documented: there is no cheap way to ask "has anything
   * changed" — the freshness check is itself a bulk fetch of ids and
   * modification dates, which costs about what re-reading everything costs. So
   * a TTL with bounded staleness is the honest option, and it is configurable
   * because the right bound depends on whether a person is actively editing.
   */
  async #bulk(): Promise<BulkPayload> {
    const ttl = this.config.searchCacheTtlMs;
    const now = this.#now().getTime();
    if (this.#cache && ttl > 0 && now - this.#cache.at < ttl) return this.#cache.data;

    const data = await withBusyRetry(() => this.runner.run<BulkPayload>(BULK_REMINDERS, {}));
    // ~700ms per property fetch on this bridge, so the nested membership call
    // is the difference between one round trip and one per list.
    if (data.membershipVia === "per-list") {
      this.#logger?.debug?.(
        `the chained membership fetch did not work; fell back to one call per list ` +
          `(${data.lists.length} extra Apple Events).`,
      );
    }
    if (data.unmapped) {
      this.#logger?.debug?.(
        `${data.unmapped} reminders belong to no list — usually subtasks, whose parentage ` +
          `only the index lane can resolve.`,
      );
    }
    this.#cache = { at: now, data };
    return data;
  }

  /** Drop the cache after a write, so the next read reflects it. */
  invalidate(): void {
    this.#cache = null;
  }

  #summarise(r: RawReminder, source: ReminderSummary["source"] = "apple-events"): ReminderSummary {
    // MEASURED: Reminders populates BOTH date properties for every dated
    // reminder (144 of 144), so presence discriminates nothing and the earlier
    // "allday wins" rule marked every dated reminder as all-day. The JXA side
    // computes a local-midnight guess instead; `ZALLDAY` overrides it whenever
    // the index is live.
    const allDay = Boolean(r.allDayGuess);
    return {
      ref: encodeRef(r.id),
      name: r.name,
      completed: Boolean(r.completed),
      due: renderDue(r.dueDate ?? r.alldayDueDate, allDay, r.dueDay ?? null),
      dueAllDay: allDay,
      dueAllDaySource: "heuristic",
      remindMe: r.remindMeDate,
      priority: toPriorityName(r.priority),
      flagged: Boolean(r.flagged),
      list: r.list,
      account: r.account,
      parentRef: r.parentId ? encodeRef(r.parentId) : null,
      created: r.created,
      modified: r.modified,
      source,
    };
  }

  #matches(r: RawReminder, f: ReminderFilters, now: Date): boolean {
    if (!this.#allowedAccount(r.account) || !this.#allowedList(r.list)) return false;

    const includeCompleted = f.includeCompleted ?? this.config.includeCompleted;
    if (!includeCompleted && r.completed) return false;

    if (f.list) {
      const want = f.list.toLowerCase();
      if ((r.list ?? "").toLowerCase() !== want && r.listId !== f.list) return false;
    }
    if (f.flagged !== undefined && Boolean(r.flagged) !== f.flagged) return false;
    if (f.priority && toPriorityName(r.priority) !== f.priority) return false;

    const due = r.alldayDueDate ?? r.dueDate;
    if (f.hasDueDate !== undefined && Boolean(due) !== f.hasDueDate) return false;

    // A range bound over reminders with no due date at all would be a silent
    // "no": excluding them explicitly is the same answer, arrived at on purpose.
    if (f.dueBefore || f.dueAfter) {
      if (!due) return false;
      const at = new Date(due).getTime();
      if (f.dueBefore && at > parseBound("dueBefore", f.dueBefore, "end", now).getTime()) {
        return false;
      }
      if (f.dueAfter && at < parseBound("dueAfter", f.dueAfter, "start", now).getTime()) {
        return false;
      }
    }
    return true;
  }

  /** Soonest-due first, then by urgency, with undated reminders last. */
  static #order(a: ReminderSummary, b: ReminderSummary): number {
    return dueAt(a) - dueAt(b) || a.name?.localeCompare(b.name ?? "") || 0;
  }

  /** An index row wears the same shape as an Apple Events one. */
  #fromIndex(r: IndexReminder, listName?: string | null): ReminderSummary {
    return {
      ref: r.uuid ? refFromUuid(r.uuid) : encodeRef(String(r.primaryKey)),
      name: r.title,
      completed: r.completed,
      due: renderDue(r.due, r.allDay, utcDay(r.due)),
      // ZALLDAY is the authoritative flag and exists nowhere else.
      dueAllDay: r.allDay,
      dueAllDaySource: "index",
      remindMe: null,
      priority: toPriorityName(r.priority),
      flagged: r.flagged,
      list: listName ?? r.listName,
      account: null,
      parentRef: r.parentUuid ? refFromUuid(r.parentUuid) : null,
      created: r.created,
      modified: r.modified,
      source: "index",
    };
  }

  /** Resolve a list name to its index primary key, for an index-side filter. */
  #listPk(store: ReminderStore, name: string): number | undefined {
    const want = name.toLowerCase();
    return store.lists().find((l) => l.name?.toLowerCase() === want)?.primaryKey;
  }

  /**
   * Post-filter index rows for the predicates SQL did not apply.
   *
   * Dates are compared here rather than in SQL because the bounds accept
   * relative offsets, which have to be resolved against the same clock the rest
   * of the request uses.
   */
  #matchesIndex(r: ReminderSummary, f: ReminderFilters, now: Date): boolean {
    if (!this.#allowedList(r.list)) return false;
    if (f.flagged !== undefined && r.flagged !== f.flagged) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.hasDueDate !== undefined && Boolean(r.due) !== f.hasDueDate) return false;
    if (f.dueBefore || f.dueAfter) {
      if (!r.due) return false;
      const at = new Date(r.due).getTime();
      if (f.dueBefore && at > parseBound("dueBefore", f.dueBefore, "end", now).getTime()) {
        return false;
      }
      if (f.dueAfter && at < parseBound("dueAfter", f.dueAfter, "start", now).getTime()) {
        return false;
      }
    }
    return true;
  }

  /**
   * The index path for listing and search.
   *
   * Preferred whenever the store is readable, and not only for scale: a bulk
   * Apple Events read costs ~700ms PER PROPERTY on this bridge — about nine
   * seconds for a full listing, whatever the library size. It is also the only
   * lane that knows whether a due date is all-day.
   */
  #fromStore(
    store: ReminderStore,
    filters: ReminderFilters,
    query: string | undefined,
    scope: "title" | "full" | undefined,
    now: Date,
  ): ReminderSummary[] {
    const listPk = filters.list ? this.#listPk(store, filters.list) : undefined;
    // A named list that the index does not know would otherwise silently widen
    // the query to every list, which is worse than returning nothing.
    if (filters.list && listPk === undefined) return [];
    const rows = store.search({
      ...(query ? { query } : {}),
      ...(scope ? { scope } : {}),
      ...(listPk === undefined ? {} : { listPk }),
      includeCompleted: filters.includeCompleted ?? this.config.includeCompleted,
      // Over-fetch, because the date and flag predicates are applied after SQL.
      limit: Math.min(filters.limit * 4 + 50, 2_000),
    });
    return rows
      .map((r) => this.#fromIndex(r))
      .filter((r) => this.#matchesIndex(r, filters, now))
      .slice(0, filters.limit);
  }

  /**
   * Whether the index can answer this request faithfully.
   *
   * The store has no readable account name — `ZREMCDACCOUNTLISTDATA` is a blob
   * and nothing else carries one — so an account allowlist cannot be applied on
   * that lane. Returning index rows anyway would silently ignore the setting
   * whose entire job is limiting what gets read, and would do so ONLY on
   * machines with Full Disk Access, which is exactly where it matters. So a
   * configured allowlist takes the slower Apple Events lane instead.
   */
  #indexCanAnswer(): boolean {
    return this.config.accounts.length === 0;
  }

  async listReminders(filters: ReminderFilters): Promise<ReminderSummary[]> {
    const now = this.#now();
    const store = this.#indexCanAnswer() ? this.index() : null;
    if (store) return this.#fromStore(store, filters, undefined, undefined, now);

    const data = await this.#bulk();
    return data.reminders
      .filter((r) => this.#matches(r, filters, now))
      .map((r) => this.#summarise(r))
      .toSorted(AppleRemindersClient.#order)
      .slice(0, Math.min(filters.limit, this.config.degradedMaxReminders));
  }

  /**
   * Text search over name and, optionally, body.
   *
   * Filtering happens in JS over the bulk arrays rather than through a `whose`
   * specifier. `whose` evaluates per item across the Apple Event bridge, which
   * Notes measured at 6.9x slower for a substring match on a comparable library.
   */
  async searchReminders(
    query: string,
    opts: { scope?: "title" | "full" } & ReminderFilters,
  ): Promise<ReminderSummary[]> {
    const now = this.#now();
    const needle = query.trim().toLowerCase();
    const full = (opts.scope ?? "full") === "full";

    const store = this.#indexCanAnswer() ? this.index() : null;
    if (store) return this.#fromStore(store, opts, query.trim(), opts.scope ?? "full", now);

    const data = await this.#bulk();
    return data.reminders
      .filter((r) => this.#matches(r, opts, now))
      .filter((r) => {
        if (!needle) return true;
        if ((r.name ?? "").toLowerCase().includes(needle)) return true;
        return full && (r.body ?? "").toLowerCase().includes(needle);
      })
      .map((r) => this.#summarise(r))
      .toSorted(AppleRemindersClient.#order)
      .slice(0, Math.min(opts.limit, this.config.degradedMaxReminders));
  }

  /**
   * One reminder in full.
   *
   * Apple Events is the authority for the core model, and the index supplies
   * what the dictionary has no class for: the authoritative all-day flag,
   * subtasks (`container()` throws on every reminder, so there is no other
   * way), attachments, alarms, recurrence and location.
   *
   * The two are joined on the UUID inside the Apple Events id — measured, by
   * scanning every TEXT column in the store for a real id rather than guessing
   * a column name.
   */
  async getReminder(ref: string): Promise<ReminderDetail> {
    const { id, uuid } = decodeRef(ref);
    const rows = await withBusyRetry(() =>
      this.runner.run<(RawReminder & { found: boolean; containerClass: string | null })[]>(
        GET_REMINDERS,
        { ids: [id] },
      ),
    );
    const row = rows[0];
    if (!row?.found) throw new ReminderNotFoundError(ref);

    const summary = this.#summarise(row);
    const store = this.index();
    const indexed = store && uuid ? store.byUuid(uuid) : null;

    // Null, not [], when the index is unavailable: "none" and "unknown" are
    // different answers and a caller acts differently on each.
    let subtasks: ReminderSummary[] = [];
    let attachments: ReminderDetail["attachments"] = null;
    let alarms: IndexEnrichment | null = null;

    if (store && indexed) {
      subtasks = store.subtasksOf(indexed.primaryKey).map((r) => this.#fromIndex(r));
      attachments = store.attachmentsOf(indexed.primaryKey).map((a) => ({
        id: a.uuid,
        filename: a.filename,
        uti: a.uti,
      }));
      alarms = store.enrichmentOf(indexed.primaryKey);
    }

    return {
      ...summary,
      // ZALLDAY beats the local-midnight guess whenever it is available.
      ...(indexed
        ? {
            dueAllDay: indexed.allDay,
            dueAllDaySource: "index" as const,
            due: renderDue(indexed.due, indexed.allDay, utcDay(indexed.due)),
          }
        : {}),
      body: row.body,
      completionDate: row.completionDate,
      dueDate: row.dueDate,
      alldayDueDate: row.alldayDueDate,
      subtasks,
      attachments,
      alarms,
    };
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  /** Resolve a list by name or id, erroring with what is available. */
  async resolveList(nameOrId: string): Promise<string> {
    const lists = await this.lists();
    const want = nameOrId.toLowerCase();
    const hit =
      lists.find((l) => l.id === nameOrId) ?? lists.find((l) => l.name?.toLowerCase() === want);
    if (!hit?.id) {
      throw new ListNotFoundError(
        nameOrId,
        lists.map((l) => l.name).filter((n): n is string => Boolean(n)),
      );
    }
    return hit.id;
  }

  /**
   * Turn the caller's field bag into JXA parameters.
   *
   * The due date is where the shape of the input picks the property: a bare day
   * sets `allday due date`, a date-time sets `due date`. See dates.ts.
   */
  #toJxaFields(fields: ReminderFields): Record<string, unknown> & { resolved?: ParsedDate } {
    const now = this.#now();
    const out: Record<string, unknown> = {};
    if (fields.name !== undefined) out.name = fields.name;
    if (fields.body !== undefined) out.body = fields.body;
    if (fields.priority !== undefined) out.priority = toPriorityValue(fields.priority);
    if (fields.flagged !== undefined) out.flagged = fields.flagged;
    if (fields.completed !== undefined) out.completed = fields.completed;
    if (fields.remindMe !== undefined) {
      out.remindMeDate = parseDate("remindMe", fields.remindMe, now).iso;
    }
    if (fields.due !== undefined) {
      const parsed = parseDate("due", fields.due, now);
      if (parsed.kind === "allDay") out.alldayDueDate = parsed.iso;
      else out.dueDate = parsed.iso;
      out.resolved = parsed;
    }
    return out;
  }

  async createReminder(
    fields: ReminderFields & { name: string; list?: string | undefined },
  ): Promise<ReminderDetail> {
    const target = fields.list ?? this.config.defaultList;
    const listId = target ? await this.resolveList(target) : undefined;
    const jxa = this.#toJxaFields(fields);
    delete jxa.resolved;
    const made = await withBusyRetry(() =>
      this.runner.run<RawReminder>(CREATE_REMINDER, {
        ...jxa,
        name: fields.name,
        ...(listId ? { listId } : {}),
      }),
    );
    this.invalidate();
    return this.getReminder(encodeRef(made.id));
  }

  async updateReminder(ref: string, fields: ReminderFields): Promise<ReminderDetail> {
    const { id } = decodeRef(ref);
    const jxa = this.#toJxaFields(fields);
    delete jxa.resolved;
    await withBusyRetry(() => this.runner.run<RawReminder>(UPDATE_REMINDER, { ...jxa, id }));
    this.invalidate();
    return this.getReminder(ref);
  }

  async completeReminders(
    refs: string[],
    completed = true,
  ): Promise<{ ref: string; found: boolean; completed: boolean }[]> {
    const ids = refs.map((r) => decodeRef(r).id);
    const rows = await withBusyRetry(() =>
      this.runner.run<{ id: string; found: boolean; completed: boolean }[]>(COMPLETE_REMINDERS, {
        ids,
        completed,
      }),
    );
    this.invalidate();
    return rows.map((r) => ({
      ref: encodeRef(r.id),
      found: Boolean(r.found),
      completed: Boolean(r.completed),
    }));
  }

  /**
   * Move reminders to another list.
   *
   * Copy-then-delete, because `reminder.container` is read-only in the scripting
   * dictionary. The new ref is returned alongside the old one so a caller can
   * update anything it was holding — the old ref stops resolving.
   */
  async moveReminders(
    refs: string[],
    list: string,
  ): Promise<{ ref: string | null; previousRef: string; moved: boolean; error?: string }[]> {
    const listId = await this.resolveList(list);
    const ids = refs.map((r) => decodeRef(r).id);
    const rows = await withBusyRetry(() =>
      this.runner.run<
        {
          id: string | null;
          previousId?: string;
          found: boolean;
          moved?: boolean;
          error?: string;
        }[]
      >(MOVE_REMINDERS, { ids, listId }),
    );
    this.invalidate();
    return rows.map((r, i) => ({
      ref: r.id ? encodeRef(r.id) : null,
      previousRef: r.previousId ? encodeRef(r.previousId) : (refs[i] as string),
      moved: Boolean(r.moved),
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  async deleteReminders(refs: string[]): Promise<{ deleted: number; missing: string[] }> {
    const ids = refs.map((r) => decodeRef(r).id);
    const out = await withBusyRetry(() =>
      this.runner.run<{ deleted: number; missing: string[] }>(DELETE_REMINDERS, { ids }),
    );
    this.invalidate();
    return { deleted: out.deleted, missing: out.missing.map((id) => encodeRef(id)) };
  }
}
