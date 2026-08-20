/**
 * JXA script fragments.
 *
 * Every script here is a static constant. None of them may contain a template
 * interpolation — `assertStaticScript` rejects any script containing a dollar
 * sign followed by a brace, and that includes JavaScript template literals
 * written *inside* the JXA source. Use string concatenation in JXA code.
 *
 * Every script follows the same contract:
 *   - it reads its parameters from `JSON.parse(argv[0])`
 *   - it returns `JSON.stringify({ok: true, data})` on success
 *   - it returns `JSON.stringify({ok: false, error: {code, message}})` on an
 *     application-level failure, still exiting 0
 * so that a non-zero exit always means infrastructure rather than "no such
 * reminder".
 *
 * ## The read discipline
 *
 * A bulk array fetch (`R.reminders.name()`) is ONE Apple Event whatever the
 * library holds. Reading the same property one reminder at a time is one event
 * each. So every read here fetches columns, never rows: a server that reads
 * twelve properties pays twelve round trips total, not twelve per reminder.
 *
 * Whether a `whose` specifier beats that for a *boolean* filter is a genuinely
 * open question, and `scripts/probe-reminders.mjs` measures it. Notes settled
 * the same question for `whose` over *text* — 6.9x slower, because the
 * specifier evaluates per item across the bridge — but a boolean predicate can
 * be pushed into the app in a way a substring match cannot, so that answer does
 * not transfer. Until it is measured, these scripts use the form that is known
 * to be size-independent.
 *
 * ## What the dictionary does not allow
 *
 * `reminder.container` and `list.container` are both declared `access="r"`.
 * There is therefore **no way to move a reminder between lists by assignment** —
 * see `write.ts`, where move is implemented as copy-then-delete and says so.
 */

/**
 * Shared prelude.
 *
 * The liveness gate matters more than it looks. `Application("Reminders").lists`
 * *launches* Reminders if it isn't running — which steals focus and starts a
 * sync as a side effect of a read. `NSRunningApplication` answers the same
 * question without launching anything and without a second TCC prompt.
 *
 * Note the bundle identifier is lower-case `com.apple.reminders`. Notes uses
 * `com.apple.Notes`, and `runningApplicationsWithBundleIdentifier` matches
 * exactly — getting the case wrong makes every read report "not running".
 *
 * Deliberately NOT shared with Mail's or Notes' prelude. Mail's is 45% a
 * UI-scripting workaround for its forced blockquote citation; Notes' knows
 * about password-protected notes and folder trees. Neither is about reminders.
 */
export const PRELUDE = `
ObjC.import("AppKit");

function isRemindersRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.reminders");
  return apps.count > 0;
}

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message) { return JSON.stringify({ ok: false, error: { code: code, message: String(message) } }); }

function iso(d) {
  try { return d ? d.toISOString() : null; } catch (e) { return null; }
}

/** Read one property defensively: Reminders throws on properties it cannot supply. */
function prop(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * Zip parallel bulk arrays into records.
 *
 * Bulk fetches are the only affordable read shape, and they come back as
 * separate arrays that line up by index. Rebuilding records here keeps that
 * assumption in one place.
 */
function zip(keys, columns, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var row = {};
    for (var k = 0; k < keys.length; k++) {
      var col = columns[k];
      row[keys[k]] = col && i < col.length ? col[i] : null;
    }
    out.push(row);
  }
  return out;
}

/**
 * Walk the list tree.
 *
 * \`list.container\` is typed "account OR list", so lists nest — Reminders calls
 * the nesting "groups" in its UI. A flat \`account.lists()\` would silently drop
 * everything inside a group, which is why this recurses even on libraries where
 * no group exists today.
 */
function listTree(container, accountId, depth, out) {
  if (depth > 8) return out;
  var subs = [];
  try { subs = container.lists(); } catch (e) { return out; }
  for (var i = 0; i < subs.length; i++) {
    var l = subs[i];
    var id = prop(function () { return String(l.id()); }, null);
    out.push({
      id: id,
      name: prop(function () { return String(l.name()); }, null),
      accountId: accountId,
      depth: depth,
      color: prop(function () { return String(l.color()); }, null),
      emblem: prop(function () { return String(l.emblem()); }, null)
    });
    listTree(l, accountId, depth + 1, out);
  }
  return out;
}

/**
 * Build reminder-id -> list.
 *
 * MEASURED: a bulk property fetch costs ~700ms on this bridge whatever the
 * library size (317 reminders, macOS 26.6), so round trips are the only thing
 * that matters here. One call per list would be 12 events — 8 seconds — on a
 * perfectly ordinary account.
 *
 * \`R.lists.reminders.id()\` is a chained element fetch that returns one array
 * per list in a SINGLE event. It is not documented to work, so the per-list
 * form stays as a fallback and the script reports which one answered.
 */
function membership(lists) {
  var map = {};
  var app = Application("Reminders");

  var nested = prop(function () { return app.lists.reminders.id(); }, null);
  if (nested && nested.length === lists.length) {
    for (var n = 0; n < lists.length; n++) {
      var group = nested[n] || [];
      for (var g = 0; g < group.length; g++) {
        map[String(group[g])] = { listId: lists[n].id, list: lists[n].name, accountId: lists[n].accountId };
      }
    }
    return { map: map, via: "nested" };
  }

  for (var i = 0; i < lists.length; i++) {
    var l = lists[i];
    var ids = prop(function () { return app.lists.byId(l.id).reminders.id(); }, []);
    for (var j = 0; j < ids.length; j++) {
      map[String(ids[j])] = { listId: l.id, list: l.name, accountId: l.accountId };
    }
  }
  return { map: map, via: "per-list" };
}

/**
 * Whether a due date names a whole day, and which day that is.
 *
 * MEASURED, and there are two traps stacked here.
 *
 * **First:** Reminders populates BOTH \`due date\` and \`allday due date\` for
 * every dated reminder — 144 of each over 144 dated reminders, all carrying
 * both. So presence discriminates nothing, and "allday is set, therefore
 * all-day" marks every dated reminder as all-day.
 *
 * **Second:** the two lanes disagree about how an all-day date is stored, and
 * verifying against only one of them gets the other backwards. The same
 * reminder, due 9 November:
 *
 *     Apple Events   2025-11-08T23:00:00Z   = LOCAL midnight (Paris, UTC+1)
 *     ZDUEDATE       2025-11-09T00:00:00Z   = UTC   midnight
 *
 * Both mean the 9th. So the check here reads **local** time, because this
 * script runs in the user's zone and that is the convention Apple Events uses.
 * The store's UTC convention is converted separately, on the store's side.
 *
 * \`dayOf\` exists for the same reason: an all-day reminder names a day, and
 * deriving that day from the UTC ISO string would land on the 8th for everyone
 * east of Greenwich. Formatting it here, from local components, cannot.
 *
 * This is still a heuristic — a reminder deliberately set to local midnight
 * defeats it — and is labelled as one. \`ZALLDAY\` in the store is the
 * authoritative flag, so the index lane overrides it whenever it is live.
 */
function isMidnight(d) {
  try {
    return Boolean(d) && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  } catch (e) {
    return false;
  }
}

/** Local calendar day as YYYY-MM-DD. Never derive this from a UTC string. */
function dayOf(d) {
  try {
    if (!d) return null;
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  } catch (e) {
    return null;
  }
}
`;

/**
 * Wrap a script body in the prelude and the liveness gate.
 *
 * `allowLaunch` is opt-in per script, and only tools whose whole purpose is to
 * make Reminders do something set it. A read that silently launches Reminders is
 * a read with a side effect.
 */
export const script = (body: string, opts: { allowLaunch?: boolean } = {}): string => `
${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0] || "{}");
  if (!isRemindersRunning() && !${opts.allowLaunch ? "true" : "false"}) {
    return err("APP_NOT_RUNNING", "Reminders is not running.");
  }
  try {
    var R = Application("Reminders");
    ${body}
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (msg.indexOf("-1743") !== -1) return err("NOT_AUTHORIZED", msg);
    return err("SCRIPT_ERROR", msg);
  }
}
`;
