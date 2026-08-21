/**
 * JXA script fragments.
 *
 * Every script here is a static constant. None of them may contain a template
 * interpolation — `osascript.assertStaticScript` rejects any script containing
 * `${`, and that includes JavaScript template literals written *inside* the JXA
 * source. Use string concatenation in JXA code.
 *
 * Every script follows the same contract:
 *   - it reads its parameters from `JSON.parse(argv[0])`
 *   - it returns `JSON.stringify({ok: true, data})` on success
 *   - it returns `JSON.stringify({ok: false, error: {code, message}})` on an
 *     application-level failure, still exiting 0
 * so that a non-zero exit always means infrastructure rather than "no such mailbox".
 */

/**
 * Shared prelude.
 *
 * The liveness gate matters more than it looks. `Application("Mail").accounts`
 * *launches* Mail if it isn't running — which steals focus and kicks off a sync
 * as a side effect of a read. `NSRunningApplication` answers the same question
 * without launching anything and without a second TCC prompt, so read tools can
 * fail cleanly instead of taking over the user's screen.
 */
export const PRELUDE = `
ObjC.import("AppKit");

function isMailRunning() {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.mail");
  return apps.count > 0;
}

function ok(data) { return JSON.stringify({ ok: true, data: data }); }
function err(code, message) { return JSON.stringify({ ok: false, error: { code: code, message: String(message) } }); }

function iso(d) {
  try { return d ? d.toISOString() : null; } catch (e) { return null; }
}

/** Read one property defensively: Mail throws on properties it cannot supply. */
function prop(fn, fallback) {
  try {
    var v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** Resolve a mailbox by the ladder: exact path, [Gmail]-stripped, final segment, case-insensitive. */
function resolveMailbox(acct, wanted) {
  var boxes = acct.mailboxes();
  var names = boxes.map(function (b) { return b.name(); });

  var candidates = [wanted];
  if (wanted.indexOf("[Gmail]/") === 0) candidates.push(wanted.slice(8));
  if (wanted.indexOf("/") !== -1) candidates.push(wanted.split("/").pop());

  for (var c = 0; c < candidates.length; c++) {
    var idx = names.indexOf(candidates[c]);
    if (idx !== -1) return boxes[idx];
  }
  for (var c2 = 0; c2 < candidates.length; c2++) {
    var lower = String(candidates[c2]).toLowerCase();
    for (var i = 0; i < names.length; i++) {
      if (String(names[i]).toLowerCase() === lower) return boxes[i];
    }
  }
  return null;
}

function findAccount(M, uuid) {
  var accts = M.accounts();
  for (var i = 0; i < accts.length; i++) {
    if (accts[i].id() === uuid) return accts[i];
  }
  return null;
}

function pause(seconds) { $.NSThread.sleepForTimeInterval(seconds); }

/**
 * Does the haystack contain the needle, ignoring how Mail rewrote whitespace?
 *
 * Used to verify a body we just wrote into a composer. A literal comparison
 * fails on text that was stored correctly: Mail hands back CR or CRLF line
 * endings, re-wraps runs of spaces and drops trailing ones, so an indented,
 * blank-line-separated body never reads back byte-identical. Collapsing every
 * whitespace run on both sides compares what a reader would see, which is the
 * question being asked -- the alternative is a false "the body was dropped" on
 * a draft that is in fact fine.
 */
function containsText(haystack, needle) {
  var squash = function (s) { return String(s).replace(/\\s+/g, " ").trim(); };
  var n = squash(needle);
  if (!n) return true;
  return squash(haystack).indexOf(n) !== -1;
}

/** Depth-first hunt for the composer's body, which is a web area, not a text field. */
function findBodyArea(el, depth) {
  if (depth > 6) return null;
  var kids;
  try { kids = el.uiElements(); } catch (e) { return null; }
  for (var i = 0; i < kids.length; i++) {
    try { if (kids[i].role() === "AXWebArea") return kids[i]; } catch (e) {}
    var found = findBodyArea(kids[i], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Deepest quote level reported anywhere in the body; 0 once the citation is gone. */
function maxQuoteLevel(el, depth) {
  var worst = 0;
  if (depth > 5) return worst;
  var kids;
  try { kids = el.uiElements(); } catch (e) { return worst; }
  for (var i = 0; i < kids.length; i++) {
    var level = prop(function () { return kids[i].attributes.byName("AXBlockQuoteLevel").value(); }, 0);
    if (level && level > worst) worst = level;
    var deeper = maxQuoteLevel(kids[i], depth + 1);
    if (deeper > worst) worst = deeper;
  }
  return worst;
}

/**
 * Undo Mail's citation wrapper on a composer window.
 *
 * Mail wraps *any* body set by AppleScript in <blockquote type="cite">, so the
 * message arrives looking like a quoted reply and its text/plain alternative
 * carries "> " on every line. This is FB11734014, filed in 2023 and still open.
 * No scriptable property avoids it: the content setter goes through Mail's
 * NSSharingService composer, and constructor-vs-assignment, visible true/false,
 * htmlContent, plain message format and a relaunch all produce the same markup.
 *
 * The composer's own Format > Quote Level > Decrease does remove it, so we drive
 * that menu. AppKit only gives the *active* application a key window, and the
 * menu item validates to disabled without one, so Mail genuinely has to come
 * forward — driving it in the background was measured, not assumed. What we can
 * do is make that as close to invisible as the window server allows: shrink the
 * composer to its minimum and push it off-screen first (macOS clamps it back to
 * leave a 40px sliver — that residue is not removable from outside Mail's
 * process, as the window server ignores alpha changes from a foreign
 * connection), then hand the user's app back before sending.
 *
 * Failure is reported, never fatal: a quoted send still beats a lost one.
 */
function stripCitation(windowName) {
  var SE = Application("System Events");
  var proc = SE.processes.byName("Mail");

  var wins = prop(function () { return proc.windows(); }, []);
  if (!wins.length) return false;

  var win = null;
  for (var i = 0; i < wins.length; i++) {
    if (prop(function () { return wins[i].name(); }, "") === windowName) { win = wins[i]; break; }
  }
  // An empty subject names the window something else; the composer is frontmost regardless.
  if (!win) win = wins[0];

  // Out of sight before Mail comes forward, so the user sees as little as possible.
  try { win.size = [1, 1]; } catch (e) {}
  try { win.position = [-100000, -100000]; } catch (e) {}

  var previous = prop(function () {
    return SE.applicationProcesses.whose({ frontmost: true })[0].name();
  }, null);

  var stripped = false;
  try {
    proc.frontmost = true;
    pause(0.6);

    var body = findBodyArea(win, 0);
    if (body) {
      body.focused = true;
      pause(0.3);
      SE.keystroke("a", { using: ["command down"] });
      pause(0.3);

      var decrease = proc.menuBars[0].menuBarItems.byName("Format").menus[0]
                         .menuItems.byName("Quote Level").menus[0].menuItems.byName("Decrease");
      var clicks = 0;
      while (clicks < 3 && prop(function () { return decrease.enabled(); }, false)) {
        decrease.click();
        clicks++;
        pause(0.25);
      }
      // Ask the composer itself rather than trusting the click count.
      stripped = maxQuoteLevel(body, 0) === 0;
    }
  } catch (e) {
    stripped = false;
  }

  if (previous && previous !== "Mail") {
    try { SE.processes.byName(previous).frontmost = true; } catch (e) {}
  }
  return stripped;
}

/** Shape one message into the wire format every tool consumes. */
function messageSummary(m, accountUuid, mailboxName) {
  return {
    id: prop(function () { return m.id(); }, null),
    accountUuid: accountUuid,
    mailbox: mailboxName,
    subject: prop(function () { return m.subject(); }, null),
    sender: prop(function () { return m.sender(); }, null),
    dateReceived: iso(prop(function () { return m.dateReceived(); }, null)),
    dateSent: iso(prop(function () { return m.dateSent(); }, null)),
    messageId: prop(function () { return m.messageId(); }, null),
    read: prop(function () { return m.readStatus(); }, null),
    flagged: prop(function () { return m.flaggedStatus(); }, null),
    junk: prop(function () { return m.junkMailStatus(); }, null),
    size: prop(function () { return m.messageSize(); }, null),
    wasRepliedTo: prop(function () { return m.wasRepliedTo(); }, null),
    wasForwarded: prop(function () { return m.wasForwarded(); }, null)
  };
}
`;

/**
 * Wrap a script body in the prelude and the liveness gate.
 *
 * `allowLaunch` is opt-in per script, and only the tools whose whole purpose is
 * to make Mail do something (send, reply, forward, check for new mail) set it.
 * A read that silently launches Mail is a read with a side effect.
 */
export const script = (body: string, opts: { allowLaunch?: boolean } = {}): string => `
${PRELUDE}
function run(argv) {
  var p = JSON.parse(argv[0] || "{}");
  if (!isMailRunning() && !${opts.allowLaunch ? "true" : "false"}) {
    return err("MAIL_NOT_RUNNING", "Mail is not running.");
  }
  try {
    var M = Application("Mail");
    ${body}
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    if (msg.indexOf("-1743") !== -1) return err("NOT_AUTHORIZED", msg);
    return err("SCRIPT_ERROR", msg);
  }
}
`;
