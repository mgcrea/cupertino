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
      reminderCount: prop(function () { return a.reminders().length; }, 0)
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
      var l = lists[j];
      l.accountName = accountName;
      l.isDefault = l.id !== null && l.id === defaultListId;
      // Counted per list, which is one Apple Event each — a handful, not one
      // per reminder. Split so a caller can see a list's live workload without
      // paging through years of finished items.
      var counts = prop(function () {
        var done = R.lists.byId(l.id).reminders.completed();
        var total = done.length, open = 0;
        for (var k = 0; k < done.length; k++) if (!done[k]) open++;
        return { total: total, incomplete: open };
      }, { total: null, incomplete: null });
      l.reminderCount = counts.total;
      l.incompleteCount = counts.incomplete;
      out.push(l);
    }
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
    var r = null;
    try { r = R.reminders.byId(id); } catch (e) { r = null; }
    if (!r) { out.push({ id: id, found: false }); continue; }
    // container() throws on a reminder on macOS 26.6 (60/60 attempts), so this
    // is expected to be null. Kept because it costs nothing when it fails and
    // would start working silently if Apple ever fixes it.
    var container = prop(function () { return r.container(); }, null);
    var containerClass = container === null ? null : prop(function () { return String(container.class()); }, null);
    var dueRaw = prop(function () { return r.dueDate(); }, null);
    var allDayRaw = prop(function () { return r.alldayDueDate(); }, null);
    out.push({
      id: id,
      found: true,
      name: prop(function () { return String(r.name()); }, null),
      body: prop(function () { var b = r.body(); return b === null ? null : String(b); }, null),
      completed: prop(function () { return r.completed(); }, null),
      completionDate: iso(prop(function () { return r.completionDate(); }, null)),
      dueDate: iso(dueRaw),
      alldayDueDate: iso(allDayRaw),
      allDayGuess: isMidnight(allDayRaw || dueRaw),
      remindMeDate: iso(prop(function () { return r.remindMeDate(); }, null)),
      priority: prop(function () { return r.priority(); }, 0),
      flagged: prop(function () { return r.flagged(); }, false),
      created: iso(prop(function () { return r.creationDate(); }, null)),
      modified: iso(prop(function () { return r.modificationDate(); }, null)),
      containerClass: containerClass,
      containerId: container === null ? null : prop(function () { return String(container.id()); }, null),
      containerName: container === null ? null : prop(function () { return String(container.name()); }, null)
    });
  }
  return ok(out);
`);
