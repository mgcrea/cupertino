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
// For AXIsProcessTrusted, read by composerReach. AppKit does not
// reliably pull it in, and an unbridged symbol would throw rather than
// answer.
ObjC.import("ApplicationServices");

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

/**
 * Read the start of a composer's body, out of the window.
 *
 * Mail's scripting interface reports content as "" for every reply and forward
 * composer, and silently discards writes to it — measured on macOS 26, with and
 * without opening window, immediately and six seconds later. So the window is
 * the only place a composed body can be read, and the accessible text under its
 * web area is what a person would see on screen.
 *
 * Bounded on purpose. Every node costs an Apple Event, and a composer holding a
 * quoted newsletter runs to 160 of them — around eight seconds to walk in full,
 * twice over, on a tool whose whole budget is thirty. Reading stops once budget
 * characters are in hand, which is enough to answer the only question being
 * asked: is the text we just pasted at the top of this window. Values are read a
 * parent at a time, one event per level rather than one per node.
 *
 * Returns null when the body cannot be reached at all — a different answer from
 * "", and the two have to stay apart: one means we are blind, the other means
 * the composer is empty.
 */
function composerBodyText(body, budget) {
  if (!body) return null;
  var acc = { lines: [], chars: 0 };
  collectText(body, 0, acc, budget);
  return acc.lines.join("\\n");
}

function collectText(el, depth, acc, budget) {
  if (depth > 6 || acc.chars >= budget) return;
  var kids = prop(function () { return el.uiElements(); }, []);
  if (!kids.length) return;
  // One event for the whole level. Falls back to one per child if this composer
  // has a level whose values will not marshal as a list.
  var values = prop(function () { return el.uiElements.value(); }, null);
  for (var i = 0; i < kids.length && acc.chars < budget; i++) {
    var kid = kids[i];
    var value = values ? values[i] : prop(function () { return kid.value(); }, null);
    if (value && typeof value === "string" && value.trim()) {
      acc.lines.push(value);
      acc.chars += value.length + 1;
    } else {
      collectText(kid, depth + 1, acc, budget);
    }
  }
}

/**
 * How many elements the composer's body holds, in one Apple Event.
 *
 * A fingerprint, not a reading. Taken before and after a paste it answers "did
 * anything at all land", which is what decides whether pasting again is safe:
 * a paste that landed and cannot be read must NOT be repeated, or the reply
 * ends up in the draft twice with no way to undo it from here.
 */
function composerBodySize(body) {
  return prop(function () { return body.entireContents().length; }, -1);
}

/**
 * Can this process actually read Mail's UI, right now?
 *
 * Asked BEFORE a composer is opened, because the alternative is what shipped:
 * M.reply opens a window, the accessibility read fails, and the user is left
 * with an empty reply window on screen and an error telling them to close it by
 * hand. Every retry left another one. Nothing about that failure needed the
 * window to exist first -- the grants it depends on can be read in one event.
 *
 * Ground truth here is the functional read, not AXIsProcessTrusted. The two do
 * disagree. MEASURED, macOS 26.6: Cupertino.app's own process reported trusted
 * while an osascript grandchild of it reported the opposite and could not name
 * a single Mail window -- a green Accessibility row in System Settings beside a
 * reply that failed every time.
 *
 * The cause was not attribution, which was correct throughout (launchctl put
 * the responsible pid of the node server at the app). It was that ONE BUNDLE
 * IDENTIFIER CAN HOLD SEVERAL ACCESSIBILITY ENTRIES AT ONCE, one per path and
 * signature it has been granted at -- an installed copy, a debug build, each
 * earlier reinstall. tccutil reported resetting four of them for
 * io.mgcrea.cupertino. The app's own check matched one and the requests made on
 * its behalf were resolved against another.
 *
 * So the flag is a claim about an identity that may be ambiguous, and this is
 * the thing itself. A window list that comes back named is proof regardless of
 * what the flag says; the flag only breaks the tie when Mail has no windows.
 *
 * Returns { ok, reason, windows }. The reason separates the two grants that fail
 * identically once inside a composer: "systemEvents" when System Events cannot
 * be addressed at all, "accessibility" when it can but its UI is unreadable.
 */
function composerReach(SE) {
  try {
    SE.processes.name();
  } catch (e) {
    return { ok: false, reason: "systemEvents", windows: null };
  }

  var names;
  try {
    var proc = SE.processes.byName("Mail");
    names = proc.windows().map(function (w) {
      try { return w.name(); } catch (e2) { return null; }
    });
  } catch (e) {
    return { ok: false, reason: "accessibility", windows: null };
  }

  if (names.length) return { ok: true, reason: null, windows: names };

  // Mail with no windows at all is legitimate -- everything closed down to the
  // menu bar -- so an empty list is not evidence of anything on its own, and
  // refusing on it would break a reply that would have worked.
  var trusted = false;
  try { trusted = $.AXIsProcessTrusted(); } catch (e) { trusted = false; }
  return trusted
    ? { ok: true, reason: null, windows: names }
    : { ok: false, reason: "accessibility", windows: names };
}

/**
 * The sentence to say when a composer cannot be reached.
 *
 * Shared by the pre-flight and by the post-open failure so the two cannot drift
 * apart, and because the advice is identical: the reason a window is unreadable
 * is never anything the caller did.
 */
function composerGrantMessage(mode, reach) {
  var head =
    reach.reason === "systemEvents"
      ? "Cupertino cannot address System Events at all, which is the only route into a Mail " +
        "composer, so the " + mode + " was not started and nothing was written."
      : "Cupertino cannot read Mail's windows, which is the only route into a " + mode + " " +
        "composer, so it was not started and nothing was written.";
  return (
    head +
    " Reaching a composer needs BOTH Accessibility and Automation to System Events -- the latter " +
    "a different grant from Automation to Mail, which is why every other tool still works. Both " +
    "belong to /Applications/Cupertino.app, NOT to your terminal and NOT to node: the app is the " +
    "process macOS holds responsible and every server inherits its identity. Accessibility is in " +
    "System Settings > Privacy & Security > Accessibility; Automation is under Automation. If the " +
    "app is already listed, toggle it off and on -- the grant goes stale when the bundle is " +
    "reinstalled. Then QUIT CUPERTINO AND OPEN IT AGAIN: the servers are children of the running " +
    "app, and a child started before the grant does not see it. Run apple_mail_diagnostics to " +
    "check, which reports the two grants separately and names the windows it can see."
  );
}

/**
 * Close a composer this script opened, when nothing of the user's is in it.
 *
 * Only ever called on a window put on screen moments earlier and provably not
 * written to. Without it every failed attempt leaves an empty reply window
 * behind, and the errors below had to end by asking the user to clean up after
 * the tool -- for a window that only exists because the tool opened it.
 *
 * It goes through Mail's own scripting interface, which is working in every
 * state that reaches here: what fails on this path is reading the window, not
 * owning it.
 */
function discardComposer(M, draft) {
  try {
    M.close(draft, { saving: "no" });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Find the composer Mail just opened, by the subject Mail gave it.
 *
 * Counting windows before and after does not work: Mail closes and reuses
 * windows around a compose, so the count comes back unchanged with a new
 * composer on screen — measured. The subject is the identity that holds, and
 * requiring a body area with it rejects the main window and the drafts list.
 */
function composerWindow(proc, subject, timeoutMs) {
  var waited = 0;
  while (true) {
    var wins = prop(function () { return proc.windows(); }, []);
    for (var i = 0; i < wins.length; i++) {
      var win = wins[i];
      if (prop(function () { return win.name(); }, "") !== subject) continue;
      if (findBodyArea(win, 0)) return win;
    }
    if (waited >= timeoutMs) return null;
    pause(0.2);
    waited += 200;
  }
}

/**
 * Put text into a composer body, via the pasteboard.
 *
 * No route through the scripting interface works on a reply or a forward:
 * assigning content is dropped, and so is setting AXValue on the web area,
 * which reports itself settable first and then does nothing. Typing the text
 * keystroke by keystroke does land, but a 4 KB body takes minutes and mangles
 * accented characters. A paste is one event, exact, and encoding-safe.
 *
 * The caller must have made Mail frontmost already: a keystroke goes to the
 * active application, and raising a window inside Mail is not that.
 *
 * COST, stated because it is real: this borrows the user's clipboard. The
 * string on it is put back afterwards, but a clipboard holding an image or a
 * file promise comes back as text, because AppKit offers no way to carry an
 * arbitrary item across without knowing its type.
 */
function pasteIntoComposer(win, body, text) {
  if (!body) return false;
  var SE = Application("System Events");

  var pb = $.NSPasteboard.generalPasteboard;
  var saved = null;
  try {
    var existing = pb.stringForType($.NSPasteboardTypeString);
    saved = existing.isNil() ? null : ObjC.unwrap(existing);
  } catch (e) {
    saved = null;
  }

  var pasted = false;
  try {
    pb.clearContents;
    pb.setStringForType($(text), $.NSPasteboardTypeString);
    try { win.actions.byName("AXRaise").perform(); } catch (e) {}
    body.focused = true;
    pause(0.3);
    SE.keystroke("v", { using: ["command down"] });
    pause(0.8);
    pasted = true;
  } catch (e) {
    pasted = false;
  }

  if (saved !== null) {
    try {
      pb.clearContents;
      pb.setStringForType($(saved), $.NSPasteboardTypeString);
    } catch (e) {}
  }
  return pasted;
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
 * connection), then put the window back exactly where it was found before the
 * user's app is handed back.
 *
 * Restoring is NOT cosmetic. Mail persists the compose window's frame, so a
 * composer left at [1, 1] off-screen is inherited by the next one the user
 * opens by hand -- and on a send that only saves a draft, the window this
 * shrank is the very window the caller is told is "open in Mail for review".
 * So a window whose geometry cannot be read back is not moved at all: the flash
 * of a composer coming forward is worth less than a window stuck at [1, 1].
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

  // Read the real geometry BEFORE moving: once the window is off-screen the
  // window server answers with what it clamped to, not what the user chose.
  var was = null;
  try { was = { size: win.size(), position: win.position() }; } catch (e) { was = null; }
  var unhide = function () {
    if (!was) return;
    // Position first, so the window grows back from the right top-left corner.
    try { win.position = was.position; } catch (e) {}
    try { win.size = was.size; } catch (e) {}
  };

  // Out of sight before Mail comes forward, so the user sees as little as
  // possible -- and only when the geometry came back, because hiding a window
  // we have no way to put back is how it stays hidden.
  if (was) {
    try { win.size = [1, 1]; } catch (e) {}
    try { win.position = [-100000, -100000]; } catch (e) {}
  }

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

  // Before the caller sends, saves, or leaves this window on screen, and on the
  // failure path too: a strip that threw must not cost the user their composer.
  unhide();

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
