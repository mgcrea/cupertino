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
 * `reply` and `forward` return a reference to the outgoing message *before*
 * Mail has finished building the composer window, and anything assigned in that
 * gap is discarded without raising — which produced a draft with correct
 * recipients, correct threading and an empty body, reported as a success. So we
 * wait for the composer to become real, then verify the body by reading it back
 * out of Mail, and fail loudly if it did not take. A caller told "your draft is
 * ready" about an empty draft is worse off than one told nothing happened.
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

  var draft;
  if (p.mode === "forward") {
    draft = M.forward(original, { openingWindow: !p.sendNow });
  } else {
    draft = M.reply(original, { openingWindow: !p.sendNow, replyToAll: p.replyToAll ? true : false });
  }

  // The quoted original showing up in \`content\` is the one signal from Mail
  // itself that the composer exists and will keep what we hand it. Poll for it
  // rather than sleeping a fixed amount: a cold Mail takes seconds, a warm one
  // is ready almost at once, and a fixed sleep has to be wrong for one of them.
  var quoted = "";
  var waitedMs = 0;
  while (waitedMs < 6000) {
    quoted = String(prop(function () { return draft.content(); }, ""));
    if (quoted) break;
    pause(0.2);
    waitedMs += 200;
  }
  var composerReady = quoted.length > 0;

  // Recipients go on after the wait for the same reason the body does.
  if (p.mode === "forward") {
    var addrs = p.to || [];
    for (var i = 0; i < addrs.length; i++) {
      draft.toRecipients.push(M.ToRecipient({ address: addrs[i] }));
    }
  }

  var bodyVerified = null;
  var contentLength = quoted.length;
  if (p.body) {
    var body = String(p.body);
    bodyVerified = false;
    // Every attempt rebuilds from the quote captured once, above. Reusing the
    // read-back instead would stack a second copy of the body on any retry
    // where the write landed but the verification did not see it.
    for (var attempt = 0; attempt < 3 && !bodyVerified; attempt++) {
      try { draft.content = body + "\\n\\n" + quoted; } catch (e) {}
      pause(attempt === 0 ? 0.4 : 1);
      var after = String(prop(function () { return draft.content(); }, ""));
      contentLength = after.length;
      bodyVerified = containsText(after, body);
    }
    if (!bodyVerified) {
      var why = composerReady
        ? "Mail accepted the assignment without error but did not keep it."
        : "The composer never became readable within 6s, so Mail was probably still building it.";
      return err(
        "DRAFT_BODY_NOT_SET",
        "Mail opened the " + p.mode + " window but the body did not take. " + why +
        " Reading the composed message back gave " + contentLength + " characters, none of them " +
        "the text we sent. The window is open and MUST be treated as EMPTY: do not tell the user " +
        "their " + p.mode + " is ready. Close it in Mail before retrying, or the retry will leave " +
        "two drafts behind."
      );
    }
  }

  if (p.sendNow) {
    draft.send();
    return ok({ sent: true, mode: p.mode, bodyVerified: bodyVerified,
                subject: prop(function () { return draft.subject(); }, null) });
  }
  return ok({ sent: false, draft: true, mode: p.mode, bodyVerified: bodyVerified,
              contentLength: contentLength,
              subject: prop(function () { return draft.subject(); }, null),
              note: "Draft window is open in Mail for review; its body was read back and matches." });
`,
  { allowLaunch: true },
);
