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
