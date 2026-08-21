import { script } from "./core.js";

/**
 * Mutating scripts.
 *
 * Two rules hold across every one of them:
 *
 * 1. **The post-state is re-read from Mail inside the same script.** Mail
 *    updates its Envelope Index eventually, not immediately, so verifying a
 *    write by re-querying the index can report the old value and send an agent
 *    into a mark-it-again loop. What Mail says right after the mutation is the
 *    only trustworthy answer.
 * 2. **Refs are grouped by mailbox by the caller**, so a batch of 50 messages
 *    in one mailbox costs one Apple Event, not 50.
 */

/** Set any combination of read / flagged / flagIndex / junk on a batch of ids. */
export const SET_FLAGS = script(`
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var mb = resolveMailbox(acct, p.mailbox);
  if (!mb) return err("MAILBOX_NOT_FOUND", "No mailbox " + p.mailbox + " in that account");
  var mailboxName = prop(function () { return mb.name(); }, p.mailbox);

  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    try {
      var m = mb.messages.byId(id);
      if (p.read !== undefined && p.read !== null) m.readStatus = p.read;
      if (p.flagged !== undefined && p.flagged !== null) m.flaggedStatus = p.flagged;
      if (p.flagIndex !== undefined && p.flagIndex !== null) m.flagIndex = p.flagIndex;
      if (p.junk !== undefined && p.junk !== null) m.junkMailStatus = p.junk;

      // Re-read from Mail rather than echoing back what we asked for.
      out.push({
        id: id,
        ok: true,
        read: prop(function () { return m.readStatus(); }, null),
        flagged: prop(function () { return m.flaggedStatus(); }, null),
        flagIndex: prop(function () { return m.flagIndex(); }, null),
        junk: prop(function () { return m.junkMailStatus(); }, null)
      });
    } catch (e) {
      out.push({ id: id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return ok({ mailbox: mailboxName, results: out });
`);

/**
 * Move messages to another mailbox.
 *
 * The moved message gets a NEW row id, so the refs the caller holds are dead
 * afterwards. We re-resolve each moved message in the destination and hand back
 * fresh ids; anything we cannot re-find is reported rather than silently dropped.
 */
export const MOVE_MESSAGES = script(`
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var src = resolveMailbox(acct, p.mailbox);
  if (!src) return err("MAILBOX_NOT_FOUND", "No source mailbox " + p.mailbox);

  var destAcct = p.destAccountUuid ? findAccount(M, p.destAccountUuid) : acct;
  if (!destAcct) return err("ACCOUNT_NOT_FOUND", "No destination account " + p.destAccountUuid);
  var dest = resolveMailbox(destAcct, p.destMailbox);
  if (!dest) return err("MAILBOX_NOT_FOUND", "No destination mailbox " + p.destMailbox);

  var destName = prop(function () { return dest.name(); }, p.destMailbox);
  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    try {
      var m = src.messages.byId(id);
      var messageId = prop(function () { return m.messageId(); }, null);
      M.move(m, { to: dest });

      // Find it again by Message-ID: the row id changed, and only the RFC id survives.
      var newId = null;
      if (messageId) {
        try {
          var matches = dest.messages.whose({ messageId: messageId })();
          if (matches.length > 0) newId = matches[0].id();
        } catch (e2) { newId = null; }
      }
      out.push({ id: id, ok: true, newId: newId, messageId: messageId });
    } catch (e) {
      out.push({ id: id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return ok({ destination: destName, destinationAccountUuid: prop(function () { return destAcct.id(); }, null), results: out });
`);

/**
 * Delete messages.
 *
 * Mail's `delete` honours the account's "move deleted messages to Trash"
 * setting, so whether this is recoverable is the account's decision and not
 * ours. We report that setting back so the answer is visible rather than assumed.
 */
export const DELETE_MESSAGES = script(`
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var mb = resolveMailbox(acct, p.mailbox);
  if (!mb) return err("MAILBOX_NOT_FOUND", "No mailbox " + p.mailbox + " in that account");

  var movesToTrash = prop(function () { return acct.moveDeletedMessagesToTrash(); }, null);

  var out = [];
  for (var i = 0; i < p.ids.length; i++) {
    var id = p.ids[i];
    try {
      var m = mb.messages.byId(id);
      var subjectLength = String(prop(function () { return m.subject(); }, "")).length;
      M.delete(m);
      out.push({ id: id, ok: true, subjectLength: subjectLength });
    } catch (e) {
      out.push({ id: id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return ok({ movedToTrash: movesToTrash, results: out });
`);

/** Trigger a sync. Allowed to launch Mail, because making Mail act is the whole point. */
export const CHECK_FOR_NEW_MAIL = script(
  `
  if (p.accountUuid) {
    var acct = findAccount(M, p.accountUuid);
    if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
    M.checkForNewMail({ for: acct });
    return ok({ checked: prop(function () { return acct.name(); }, p.accountUuid) });
  }
  M.checkForNewMail();
  return ok({ checked: "all accounts" });
`,
  { allowLaunch: true },
);

/**
 * Compose a new message.
 *
 * `sendNow` defaults to false at every layer above this, which leaves the
 * draft on screen for a human to read before it goes anywhere. Sending is the
 * only action in this server that is both irreversible and visible to other
 * people, so it gets two independent gates rather than one.
 */
export const SEND_MESSAGE = script(
  `
  var msg = M.OutgoingMessage({
    subject: p.subject || "",
    content: p.body || "",
    visible: true
  });
  M.outgoingMessages.push(msg);

  if (p.senderAddress) msg.sender = p.senderAddress;

  var lists = [["to", p.to], ["cc", p.cc], ["bcc", p.bcc]];
  for (var l = 0; l < lists.length; l++) {
    var kind = lists[l][0];
    var addrs = lists[l][1] || [];
    for (var i = 0; i < addrs.length; i++) {
      if (kind === "to") msg.toRecipients.push(M.ToRecipient({ address: addrs[i] }));
      else if (kind === "cc") msg.ccRecipients.push(M.CcRecipient({ address: addrs[i] }));
      else msg.bccRecipients.push(M.BccRecipient({ address: addrs[i] }));
    }
  }

  pause(1.2);
  var unquoted = false;
  try { unquoted = stripCitation(String(p.subject || "")); } catch (e) { unquoted = false; }

  if (p.sendNow) {
    msg.send();
    return ok({ sent: true, unquoted: unquoted, subjectLength: String(p.subject || "").length,
                recipientCount: (p.to || []).length + (p.cc || []).length + (p.bcc || []).length });
  }
  return ok({ sent: false, draft: true, unquoted: unquoted, subjectLength: String(p.subject || "").length,
              recipientCount: (p.to || []).length + (p.cc || []).length + (p.bcc || []).length,
              note: "Draft window is open in Mail for review." });
`,
  { allowLaunch: true },
);

/**
 * Reply to, or forward, an existing message.
 *
 * The body cannot go through the scripting interface. `reply` and `forward`
 * hand back an outgoing message whose `content` reads as "" and swallows every
 * write — not a race, and not fixed by waiting: measured on macOS 26 with and
 * without `opening window`, immediately and six seconds later, and the same for
 * setting AXValue on the composer's web area, which reports itself settable and
 * then does nothing. Recipients, subject and threading DO come through, which
 * is what made the old failure so bad: a draft correct in every visible respect
 * except the words, reported as a success.
 *
 * So the body is pasted into the composer window and then read back out of it.
 * Nothing here reports a draft as ready on the strength of an assignment having
 * been accepted, because that is exactly what lied.
 */
export const REPLY_OR_FORWARD = script(
  `
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var mb = resolveMailbox(acct, p.mailbox);
  if (!mb) return err("MAILBOX_NOT_FOUND", "No mailbox " + p.mailbox + " in that account");

  var original;
  try {
    original = mb.messages.byId(p.id);
    original.subject();
  } catch (e) {
    return err("MESSAGE_NOT_FOUND", "No message " + p.id + " in " + p.mailbox);
  }

  // The window is opened even when sending immediately: it is where the body
  // has to be typed, and sending from it sends what was verified rather than
  // whatever the disconnected scripting object thinks it holds.
  var draft;
  if (p.mode === "forward") {
    draft = M.forward(original, { openingWindow: true });
  } else {
    draft = M.reply(original, { openingWindow: true, replyToAll: p.replyToAll ? true : false });
  }

  var subject = String(prop(function () { return draft.subject(); }, ""));
  if (!subject) return err("COMPOSER_NOT_FOUND", "Mail did not return a composer for the " + p.mode + ".");

  var SE = Application("System Events");
  var proc = SE.processes.byName("Mail");
  var win = composerWindow(proc, subject, 8000);
  if (!win) {
    return err(
      "COMPOSER_NOT_FOUND",
      "Mail was asked to open a " + p.mode + " window for \\"" + subject + "\\" and no such window " +
      "appeared within 8s. If a compose window IS on screen, this Mac has not granted Accessibility " +
      "to whatever runs this server, which is what reading and filling a composer needs. Nothing " +
      "was written; check System Settings > Privacy & Security > Accessibility."
    );
  }

  // Recipients go through the scripting object, which does work for them, but
  // only once the composer exists.
  if (p.mode === "forward") {
    var addrs = p.to || [];
    for (var i = 0; i < addrs.length; i++) {
      draft.toRecipients.push(M.ToRecipient({ address: addrs[i] }));
    }
  }

  var bodyArea = findBodyArea(win, 0);
  if (!bodyArea) {
    return err(
      "COMPOSER_NOT_FOUND",
      "The " + p.mode + " window for \\"" + subject + "\\" is open, but its body cannot be reached " +
      "through the accessibility interface, which is the only way into it. Nothing was written."
    );
  }

  var previous = prop(function () {
    return SE.applicationProcesses.whose({ frontmost: true })[0].name();
  }, null);
  var restore = function () {
    if (previous && previous !== "Mail") {
      try { SE.processes.byName(previous).frontmost = true; } catch (e) {}
    }
  };

  var bodyVerified = null;
  var verifiedChars = 0;
  if (p.body) {
    var body = String(p.body);
    // Confirm the opening of the body rather than all of it. Reading the whole
    // of a long reply plus the quote it sits above costs seconds of Apple
    // Events, and buys nothing: a paste either arrives whole or does not arrive,
    // which is what was measured, so the top of it is the tell.
    var expected = body.length > 400 ? body.slice(0, 400) : body;
    var sizeBefore = composerBodySize(bodyArea);
    bodyVerified = false;

    try {
      proc.frontmost = true;
      pause(0.4);
      for (var attempt = 0; attempt < 2 && !bodyVerified; attempt++) {
        pasteIntoComposer(win, bodyArea, body);
        var after = composerBodyText(bodyArea, expected.length + 400);
        bodyVerified = after !== null && containsText(after, expected);
        if (bodyVerified) {
          verifiedChars = expected.length;
        } else if (composerBodySize(bodyArea) !== sizeBefore) {
          // Something went in that we cannot match. Pasting again would put the
          // reply in the draft twice, and nothing here can undo that.
          break;
        }
      }
    } catch (e) {
      bodyVerified = false;
    }

    if (!bodyVerified) {
      restore();
      return err(
        "DRAFT_BODY_NOT_SET",
        "The " + p.mode + " window for \\"" + subject + "\\" is open and correctly addressed, but the " +
        "body did not go in: reading the composer back does not show the text that was sent. The " +
        "draft is EMPTY or wrong and MUST NOT be described to the user as ready. Close it in Mail " +
        "before retrying, or the retry leaves a second draft behind."
      );
    }
  }

  if (p.sendNow) {
    // Sent from the window, so what goes out is what was just verified.
    var clicked = false;
    try {
      proc.frontmost = true;
      pause(0.4);
      try { win.actions.byName("AXRaise").perform(); } catch (e) {}
      pause(0.3);
      var send = proc.menuBars[0].menuBarItems.byName("Message").menus[0].menuItems.byName("Send");
      if (prop(function () { return send.enabled(); }, false)) {
        send.click();
        clicked = true;
      }
    } catch (e) {
      clicked = false;
    }
    // The window closing is the confirmation that it went. Wait for it rather
    // than sampling once: reporting a slow close as a failure would invite a
    // retry, and a retry after a send that DID go sends the mail twice.
    var stillOpen = true;
    var waited = 0;
    while (clicked && waited < 8000) {
      pause(0.5);
      waited += 500;
      if (composerWindow(proc, subject, 0) === null) { stillOpen = false; break; }
    }
    restore();
    if (!clicked) {
      return err(
        "SEND_FAILED",
        "The " + p.mode + " was composed and its body verified, but Message > Send would not " +
        "activate, so NOTHING WAS SENT. The draft is on screen with the right text in it and can " +
        "be sent by hand."
      );
    }
    if (stillOpen) {
      return err(
        "SEND_UNCONFIRMED",
        "The " + p.mode + " was composed, its body verified, and Send was clicked — but the window " +
        "was still open 8s later, so whether it went cannot be confirmed from here. DO NOT send it " +
        "again: check Sent in Mail first, because a retry would send it twice."
      );
    }
    return ok({ sent: true, mode: p.mode, bodyVerified: bodyVerified,
                verifiedChars: verifiedChars, subject: subject });
  }

  restore();
  return ok({
    sent: false,
    draft: true,
    mode: p.mode,
    subject: subject,
    bodyVerified: bodyVerified,
    verifiedChars: verifiedChars,
    note: bodyVerified
      ? "Draft window is open in Mail for review; its body was read back out of the window and matches."
      : "Draft window is open in Mail for review."
  });
`,
  { allowLaunch: true },
);
