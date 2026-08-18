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
    visible: p.sendNow ? false : true
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

  if (p.sendNow) {
    msg.send();
    return ok({ sent: true, subjectLength: String(p.subject || "").length,
                recipientCount: (p.to || []).length + (p.cc || []).length + (p.bcc || []).length });
  }
  return ok({ sent: false, draft: true, subjectLength: String(p.subject || "").length,
              recipientCount: (p.to || []).length + (p.cc || []).length + (p.bcc || []).length,
              note: "Draft window is open in Mail for review." });
`,
  { allowLaunch: true },
);

/** Reply to, or forward, an existing message. */
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

  var draft;
  if (p.mode === "forward") {
    draft = M.forward(original, { openingWindow: !p.sendNow });
    var addrs = p.to || [];
    for (var i = 0; i < addrs.length; i++) {
      draft.toRecipients.push(M.ToRecipient({ address: addrs[i] }));
    }
  } else {
    draft = M.reply(original, { openingWindow: !p.sendNow, replyToAll: p.replyToAll ? true : false });
  }

  if (p.body) {
    // Prepend so the quoted original survives underneath.
    draft.content = p.body + "\\n\\n" + prop(function () { return draft.content(); }, "");
  }

  if (p.sendNow) {
    draft.send();
    return ok({ sent: true, mode: p.mode });
  }
  return ok({ sent: false, draft: true, mode: p.mode, note: "Draft window is open in Mail for review." });
`,
  { allowLaunch: true },
);
