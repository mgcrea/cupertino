/**
 * JXA script fragments.
 *
 * Every script here is a static constant. None of them may contain a template
 * interpolation — `assertStaticScript` rejects any script containing `${`, and
 * that includes JavaScript template literals written *inside* the JXA source.
 * Use string concatenation in JXA code.
 *
 * Every script follows the same contract:
 *   - it reads its parameters from `JSON.parse(argv[0])`
 *   - it returns `JSON.stringify({ok: true, data})` on success
 *   - it returns `JSON.stringify({ok: false, error: {code, message}})` on an
 *     application-level failure, still exiting 0
 * so that a non-zero exit always means infrastructure rather than "no such note".
 *
 * ## Two rules the measurements impose
 *
 * 1. **Never read a property per note in a loop.** One note's `plaintext` costs
 *    ~116ms, so a 921-note library would take ~107 seconds. Every read here is a
 *    bulk array fetch (`N.notes.plaintext()`), which is one Apple Event whatever
 *    the size.
 * 2. **Never use `whose` for text search.** `notes.whose({plaintext: ...})` took
 *    671ms against 97ms for pulling everything and filtering in JS — 6.9x slower,
 *    because the specifier evaluates per note across the Apple Event bridge while
 *    the bulk form is a single round trip.
 */

/**
 * Shared prelude.
 *
 * The liveness gate matters more than it looks. `Application("Notes").notes`
 * *launches* Notes if it isn't running — which steals focus as a side effect of
 * a read. `NSRunningApplication` answers the same question without launching
 * anything and without a second TCC prompt.
 *
 * Deliberately NOT shared with Mail's prelude: 45% of that file is a UI-scripting
 * workaround for Mail's forced blockquote citation, which every script there
 * carries whether it composes mail or lists accounts. Notes needs none of it.
 */
export const PRELUDE = `
ObjC.import("AppKit");

function isNotesRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.Notes");
  return apps.count > 0;
}

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message) { return JSON.stringify({ ok: false, error: { code: code, message: String(message) } }); }

function iso(d) {
  try { return d ? d.toISOString() : null; } catch (e) { return null; }
}

/** Read one property defensively: Notes throws on properties it cannot supply. */
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

/** Walk the folder tree. Folders nest in the dictionary, so this recurses. */
function folderTree(container, accountId, depth, out) {
  if (depth > 8) return out;
  var subs = [];
  try { subs = container.folders(); } catch (e) { return out; }
  for (var i = 0; i < subs.length; i++) {
    var f = subs[i];
    var id = prop(function () { return String(f.id()); }, null);
    out.push({
      id: id,
      name: prop(function () { return String(f.name()); }, null),
      accountId: accountId,
      depth: depth,
      shared: prop(function () { return f.shared(); }, false),
      noteCount: prop(function () { return f.notes().length; }, null)
    });
    folderTree(f, accountId, depth + 1, out);
  }
  return out;
}
`;

/**
 * Wrap a script body in the prelude and the liveness gate.
 *
 * `allowLaunch` is opt-in per script, and only tools whose whole purpose is to
 * make Notes do something set it. A read that silently launches Notes is a read
 * with a side effect.
 */
export const script = (body: string, opts: { allowLaunch?: boolean } = {}): string => `
${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0] || "{}");
  if (!isNotesRunning() && !${opts.allowLaunch ? "true" : "false"}) {
    return err("APP_NOT_RUNNING", "Notes is not running.");
  }
  try {
    var N = Application("Notes");
    ${body}
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (msg.indexOf("-1743") !== -1) return err("NOT_AUTHORIZED", msg);
    return err("SCRIPT_ERROR", msg);
  }
}
`;
