import { script } from "./core.js";

/** Accounts, with the list count each one holds. */
export const LIST_ACCOUNTS = script(`
  var accounts = R.accounts();
  var out = [];
  var defaultAccountId = prop(function () { return String(R.defaultAccount.id()); }, null);
  var defaultListId = prop(function () { return String(R.defaultList.id()); }, null);
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    var id = prop(function () { return String(a.id()); }, null);
    out.push({
      id: id,
      name: prop(function () { return String(a.name()); }, null),
      isDefault: id !== null && id === defaultAccountId,
      listCount: prop(function () { return a.lists().length; }, 0),
      // Answers "Can't get object." on a live Reminders (macOS 27), so this is
      // null there: unknown, never a 0 nobody counted.
      reminderCount: prop(function () { return a.reminders().length; }, null)
    });
  }
  return ok({ accounts: out, defaultAccountId: defaultAccountId, defaultListId: defaultListId });
`);

/**
 * The list tree. Lists nest inside other lists (Reminders calls them groups),
 * so this is depth-first rather than a flat account.lists() read.
 */
export const LIST_LISTS = script(`
  var accounts = R.accounts();
  var out = [];
  var defaultListId = prop(function () { return String(R.defaultList.id()); }, null);
  for (var i = 0; i < accounts.length; i++) {
    var a = accounts[i];
    var accountId = prop(function () { return String(a.id()); }, null);
    var accountName = prop(function () { return String(a.name()); }, null);
    var lists = listTree(a, accountId, 1, []);
    for (var j = 0; j < lists.length; j++) {
      lists[j].accountName = accountName;
      lists[j].isDefault = lists[j].id !== null && lists[j].id === defaultListId;
      out.push(lists[j]);
    }
  }

  // Counts, unless the caller has them from the store. Every list's completed
  // flags in one chained event (2.2 s measured, matching the store on 12 of 12
  // lists), keyed by the flat R.lists ids; one event per list only when the
  // chained form does not answer.
  var counts = {};
  if (p.withCounts) {
    var flatIds = prop(function () { return R.lists.id(); }, []);
    var flags = prop(function () { return R.lists.reminders.completed(); }, null);
    if (!flags || flags.length !== flatIds.length) {
      flags = [];
      for (var f = 0; f < flatIds.length; f++) {
        var fid = flatIds[f];
        flags.push(prop(function () { return R.lists.byId(fid).reminders.completed(); }, null));
      }
    }
    for (var k = 0; k < flatIds.length; k++) {
      var done = flags[k];
      if (!done) continue;
      var open = 0;
      for (var d = 0; d < done.length; d++) if (!done[d]) open++;
      counts[String(flatIds[k])] = { total: done.length, incomplete: open };
    }
  }
  for (var o = 0; o < out.length; o++) {
    var c = out[o].id === null ? undefined : counts[out[o].id];
    out[o].reminderCount = c ? c.total : null;
    out[o].incompleteCount = c ? c.incomplete : null;
  }
  return ok(out);
`);

/**
 * Every reminder's metadata, as bulk arrays.
 *
 * MEASURED on macOS 26.6 over 317 reminders: each bulk property fetch costs
 * ~700ms and is independent of library size, so this is ~9 seconds of Apple
 * Events. That is the price of the unprivileged lane, and it is why the result
 * is cached on a TTL and why the index lane carries listing whenever it is
 * live. The per-reminder alternative would be twelve events EACH.
 *
 * ## Subtasks are not reachable here
 *
 * The dictionary types `reminder.container` as "list OR reminder", which reads
 * like subtasks are addressable over Apple Events. They are not: calling
 * `container()` on a reminder threw on 60 of 60 attempts. So parentage is left
 * null on this lane and the index fills it in from `ZPARENTREMINDER`.
 *
 * Subtasks are still LISTED — `R.reminders()` returns all 317, matching the
 * store exactly — they simply arrive without a parent. Missing parentage and a
 * missing reminder are very different claims, so `parentId` is null rather than
 * the row being dropped.
 */
export const BULK_REMINDERS = script(`
  var ids = R.reminders.id();
  var count = ids.length;
  var dueDates = prop(function () { return R.reminders.dueDate(); }, []);
  var allDayDates = prop(function () { return R.reminders.alldayDueDate(); }, []);

  var rows = zip(
    ["id", "name", "body", "completed", "completionDate", "remindMeDate",
     "priority", "flagged", "created", "modified"],
    [
      ids,
      prop(function () { return R.reminders.name(); }, []),
      prop(function () { return R.reminders.body(); }, []),
      prop(function () { return R.reminders.completed(); }, []),
      prop(function () { return R.reminders.completionDate(); }, []),
      prop(function () { return R.reminders.remindMeDate(); }, []),
      prop(function () { return R.reminders.priority(); }, []),
      prop(function () { return R.reminders.flagged(); }, []),
      prop(function () { return R.reminders.creationDate(); }, []),
      prop(function () { return R.reminders.modificationDate(); }, [])
    ],
    count
  );

  var accounts = R.accounts();
  var lists = [];
  for (var i = 0; i < accounts.length; i++) {
    var accountId = prop(function () { return String(accounts[i].id()); }, null);
    lists = lists.concat(listTree(accounts[i], accountId, 1, []));
  }
  var member = membership(lists);
  var listOf = member.map;
  var accountNames = {};
  for (var n = 0; n < accounts.length; n++) {
    accountNames[String(prop(function () { return String(accounts[n].id()); }, ""))] =
      prop(function () { return String(accounts[n].name()); }, null);
  }

  var unmapped = 0;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    row.id = String(row.id);
    row.completionDate = iso(row.completionDate);
    row.remindMeDate = iso(row.remindMeDate);
    row.created = iso(row.created);
    row.modified = iso(row.modified);

    // Both properties are populated for every dated reminder, so the local
    // time component is the only signal available without the index.
    var due = r < dueDates.length ? dueDates[r] : null;
    var allday = r < allDayDates.length ? allDayDates[r] : null;
    row.dueDate = iso(due);
    row.alldayDueDate = iso(allday);
    row.allDayGuess = isMidnight(allday || due);
    row.dueDay = dayOf(allday || due);

    // Apple Events cannot answer this; the index does. Null means unknown.
    row.parentId = null;

    var where = listOf[row.id];
    if (where) {
      row.list = where.list;
      row.listId = where.listId;
      row.accountId = where.accountId;
      row.account = accountNames[String(where.accountId)] || null;
    } else {
      row.list = null; row.listId = null; row.accountId = null; row.account = null;
      unmapped++;
    }
  }

  return ok({
    count: count,
    reminders: rows,
    lists: lists,
    unmapped: unmapped,
    membershipVia: member.via
  });
`);

/**
 * Full detail for a specific set of reminders, by id.
 *
 * Used after the index narrows things down, and to re-read a reminder after a
 * write so the result reflects what Reminders actually stored rather than what
 * was requested.
 */
export const GET_REMINDERS = script(`
  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = String(p.ids[i]);
    // One event for every field. Each event on a reminder re-resolves byId
    // across the application, ~1 s apiece measured on macOS 27, so reading
    // the properties one at a time ran past the 30 s timeout on every call.
    var all;
    try {
      all = R.reminders.byId(id).properties();
    } catch (e) {
      if (String(e && e.message ? e.message : e).indexOf("Can't get") !== -1) {
        out.push({ id: id, found: false });
        continue;
      }
      throw e;
    }
    var dueRaw = all.dueDate || null;
    var allDayRaw = all.alldayDueDate || null;
    out.push({
      id: id,
      found: true,
      name: all.name === null || all.name === undefined ? null : String(all.name),
      body: all.body === null || all.body === undefined ? null : String(all.body),
      completed: all.completed === undefined ? null : all.completed,
      completionDate: iso(all.completionDate),
      dueDate: iso(dueRaw),
      alldayDueDate: iso(allDayRaw),
      allDayGuess: isMidnight(allDayRaw || dueRaw),
      dueDay: dayOf(allDayRaw || dueRaw),
      remindMeDate: iso(all.remindMeDate),
      priority: all.priority === undefined || all.priority === null ? 0 : all.priority,
      flagged: all.flagged === undefined || all.flagged === null ? false : all.flagged,
      created: iso(all.creationDate),
      modified: iso(all.modificationDate)
    });
  }
  return ok(out);
`);
