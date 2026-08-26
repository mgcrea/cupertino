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
/**
 * The two grants a composer needs, probed separately.
 *
 * `composerWindow` reaches Mail's compose window through System Events, and
 * that single call sits behind TWO different permissions: Automation from the
 * responsible process to **System Events** (a distinct TCC row from Automation
 * to Mail, which every other write tool uses), and **Accessibility** for the
 * responsible process, which is what allows reading UI elements once System
 * Events will talk at all.
 *
 * They have to be reported separately because the failure cannot tell them
 * apart. `proc.windows()` is wrapped in `prop()`, which swallows the exception
 * and yields `[]`, so a denied Automation and a denied Accessibility both
 * arrive as "no window matched" — indistinguishable from Mail genuinely not
 * having opened one. The old message named Accessibility outright and was read
 * as authoritative; it was a guess with the other two possibilities hidden.
 *
 * The identity being probed is **Cupertino.app**, not the terminal and not
 * node: `scripts/spike-app-tcc` measured that the app is its own responsible
 * process and everything beneath it inherits that. This runs under the same
 * identity as the composer code, so it answers for the process that will
 * actually be refused.
 */
export const COMPOSER_ACCESS = `
ObjC.import("ApplicationServices");
function run() {
  // Accessibility: reading UI elements out of another process.
  var accessibility = $.AXIsProcessTrusted() ? "granted" : "denied";

  // Automation -> System Events: being allowed to address it at all. Distinct
  // from Automation -> Mail, and prompted for separately.
  var systemEvents = "unknown";
  var detail = null;
  try {
    var SE = Application("System Events");
    SE.processes.name();
    systemEvents = "granted";
  } catch (e) {
    var msg = String(e && e.message ? e.message : e);
    detail = msg;
    // Same vocabulary as Permissions.AutomationStatus in the app: -1743 is
    // errAEEventNotPermitted (refused), -1744 is errAEEventWouldRequireUserConsent
    // (never asked). They need different advice — one is a toggle to flip, the
    // other is a prompt nobody has seen yet — so they are not collapsed.
    if (msg.indexOf("-1743") !== -1) systemEvents = "denied";
    else if (msg.indexOf("-1744") !== -1) systemEvents = "notDetermined";
    else systemEvents = "error";
  }

  return JSON.stringify({
    ok: true,
    data: { accessibility: accessibility, systemEvents: systemEvents, detail: detail },
  });
}
`;

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
 * Create a mailbox, on an account or in "On My Mac".
 *
 * ## Idempotent by inspection, not by catching a failure
 *
 * Mail does not refuse a second mailbox with a name one already has — depending
 * on the account it will either no-op or make a duplicate, and a duplicate is
 * not something a caller can undo from here. So this looks first and reports
 * `created: false` for a name that is already taken, which also makes the tool
 * safe to call before a move without a separate existence check.
 *
 * ## Why the result is re-read
 *
 * On an IMAP account the SERVER decides whether the name is acceptable and what
 * it ends up called — a leading dot, a reserved prefix, a namespace the account
 * cannot write to. `push` reports none of that, so the mailbox is looked up
 * again afterwards and its absence is an error rather than a silent success.
 */
export const CREATE_MAILBOX = script(`
  var acct = null;
  if (p.accountUuid) {
    acct = findAccount(M, p.accountUuid);
    if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  }

  // Local mailboxes hang off the application, account mailboxes off the account.
  var find = function (name) {
    if (acct) return resolveMailbox(acct, name);
    var tops = M.mailboxes();
    var lower = String(name).toLowerCase();
    for (var i = 0; i < tops.length; i++) {
      var box = tops[i];
      if (String(prop(function () { return box.name(); }, "")).toLowerCase() === lower) return box;
    }
    return null;
  };

  var describe = function (box, created, note) {
    var out = {
      created: created,
      name: prop(function () { return box.name(); }, p.name),
      account: acct ? prop(function () { return acct.name(); }, null) : null,
      accountUuid: acct ? prop(function () { return acct.id(); }, null) : null
    };
    if (note) out.note = note;
    return out;
  };

  var existing = find(p.name);
  if (existing) {
    return ok(describe(existing, false, "A mailbox with that name already exists; nothing was created."));
  }

  var mb = M.Mailbox({ name: p.name });
  if (acct) acct.mailboxes.push(mb); else M.mailboxes.push(mb);

  var made = find(p.name);
  if (!made) {
    return err(
      "MAILBOX_NOT_CREATED",
      "Mail accepted the request but no mailbox named " + p.name + " exists afterwards. On an " +
        "IMAP account the server can reject a name without reporting an error to AppleScript."
    );
  }
  return ok(describe(made, true, null));
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
 * Replace the body of a saved draft, by recreating it.
 *
 * ## Why recreating, when "edit the draft" is the obvious thing
 *
 * Because Mail's dictionary does not offer it, and that is measured rather than
 * assumed — see `docs/mail-compose.md`. A saved draft is a `message`, whose
 * `content` is `access="r"`. There is no `open` command and no `edit` command in
 * the entire suite, so nothing turns a saved draft back into the `outgoing
 * message` whose content IS writable. The only class that ever held a reference
 * from one to the other is `OLD message editor`, marked `hidden` and
 * "DEPRECATED - DO NOT USE".
 *
 * So the body is replaced the only way the interface allows: compose a new
 * message carrying the old one's recipients and the new text, and remove the
 * old one.
 *
 * ## The order is the safety property
 *
 * The replacement is created AND CONFIRMED PRESENT before the original is
 * deleted, never the other way round. A delete-then-create that fails halfway
 * has destroyed something the user wrote and cannot get back — this server has
 * no undo and Mail's Trash may not be in play, since `moveDeletedMessagesToTrash`
 * is per-account. If the confirmation does not come back, the original is left
 * exactly where it was and the caller is told there are now two.
 *
 * ## What it refuses
 *
 * Recreating cannot carry everything across, and the two things it drops are
 * both invisible in the result:
 *
 *   * **Threading.** `In-Reply-To` and `References` are set by Mail's own
 *     `reply` command, which needs the original message. A recreated reply
 *     draft looks perfect and starts a new thread.
 *   * **Attachments.** They can be read but not re-attached; the dictionary has
 *     no verb for adding one to an outgoing message.
 *
 * Both are refused rather than silently dropped. A draft that is correct in
 * every visible respect except the part nobody checks is the exact failure the
 * compose path already learned once.
 */
export const UPDATE_DRAFT = script(
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

  /*
   * Find the account's Drafts mailbox.
   *
   * MEASURED, macOS 26.6: account.draftsMailbox is in the dictionary with
   * access="r" and raises "Can't get object." on EVERY account — iCloud, two
   * IMAP, one Exchange. The application-level draftsMailbox does resolve, but
   * it is the unified "All Drafts" smart mailbox and is not what a message
   * reports as its own container.
   *
   * So the name is DISCOVERED rather than guessed: every message in All Drafts
   * reports its real per-account mailbox, which also makes this correct on a
   * localised Mail where a hardcoded "Drafts" would not be. The documented
   * property is still tried first, so this repairs itself if Apple fixes it.
   */
  var drafts = prop(function () { return acct.draftsMailbox(); }, null);
  var acctName = String(prop(function () { return acct.name(); }, ""));
  if (!drafts) {
    var all = prop(function () { return M.draftsMailbox(); }, null);
    var pool = all ? prop(function () { return all.messages(); }, []) : [];
    for (var d = 0; d < pool.length && d < 200 && !drafts; d++) {
      var box = prop(function () { return pool[d].mailbox(); }, null);
      if (!box) continue;
      var owner = prop(function () { return box.account().name(); }, null);
      if (owner === null || String(owner) !== acctName) continue;
      drafts = box;
    }
  }
  if (!drafts) {
    return err(
      "DRAFTS_MAILBOX_UNKNOWN",
      "The Drafts mailbox for " + acctName + " could not be identified: Mail refuses the " +
      "account's draftsMailbox property, and no message in All Drafts belongs to this account. " +
      "Nothing was changed. If the account genuinely holds no drafts, then neither does the " +
      "message you named."
    );
  }
  var draftsName = String(prop(function () { return drafts.name(); }, ""));

  // Only a draft may be rewritten. Editing a SENT or RECEIVED message by
  // deleting it and writing a lookalike is not editing, it is forgery, and the
  // ref for one looks exactly like the ref for the other.
  var here = String(prop(function () { return mb.name(); }, p.mailbox));
  if (here.toLowerCase() !== draftsName.toLowerCase()) {
    return err(
      "NOT_A_DRAFT",
      "That message is in " + here + ", not in " + draftsName + ". Only an unsent draft can be " +
      "rewritten: doing this to a sent or received message would delete the real one and leave " +
      "a lookalike in its place."
    );
  }

  var attachments = prop(function () { return original.mailAttachments().length; }, 0);
  var headers = String(prop(function () { return original.allHeaders(); }, ""));
  var isReply = /^(in-reply-to|references):/im.test(headers);

  var readAddresses = function (list) {
    var out = [];
    var items = prop(function () { return list(); }, []);
    for (var i = 0; i < items.length; i++) {
      var box = items[i];
      var addr = prop(function () { return box.address(); }, null);
      if (addr) out.push(String(addr));
    }
    return out;
  };
  var to = readAddresses(function () { return original.toRecipients(); });
  var cc = readAddresses(function () { return original.ccRecipients(); });
  var bcc = readAddresses(function () { return original.bccRecipients(); });
  var oldSubject = String(prop(function () { return original.subject(); }, ""));
  var sender = String(prop(function () { return original.sender(); }, ""));

  // Everything the caller needs to decide what to do instead, reported on the
  // refusals as well as on success.
  var facts = {
    subject: oldSubject,
    isReply: isReply,
    attachments: attachments,
    recipientCount: to.length + cc.length + bcc.length
  };

  if (isReply) {
    return ok({
      replaced: false, degraded: true, capability: "threading", draft: facts,
      reason:
        "This draft is a reply or a forward: its headers carry In-Reply-To or References, and " +
        "those are written by Mail's own reply command, which needs the original message. " +
        "Recreating it would produce a draft that looks right and starts a NEW thread.",
      hint:
        "Edit the body in Mail directly, or delete this draft and start again with " +
        "apple_mail_reply_to_message, which threads correctly."
    });
  }
  if (attachments > 0) {
    return ok({
      replaced: false, degraded: true, capability: "attachments", draft: facts,
      reason:
        "This draft carries " + attachments + " attachment(s). Mail's scripting interface can " +
        "read an attachment but has no verb for adding one to an outgoing message, so " +
        "recreating the draft would silently drop them.",
      hint: "Edit the body in Mail directly, which keeps the attachments."
    });
  }

  var subject = p.subject === null || p.subject === undefined ? oldSubject : String(p.subject);
  if (!subject) {
    return ok({
      replaced: false, degraded: true, capability: "confirmation", draft: facts,
      reason:
        "This draft has no subject, and the subject is the only handle this server has for " +
        "finding the replacement again after Mail saves it. Without that confirmation the " +
        "original cannot be deleted safely, so nothing was changed.",
      hint: 'Pass the subject argument to give it one, or edit the draft in Mail.'
    });
  }

  var replacement = M.OutgoingMessage({ subject: subject, content: p.body || "", visible: true });
  M.outgoingMessages.push(replacement);
  if (sender) { try { replacement.sender = sender; } catch (e) {} }

  var lists = [["to", to], ["cc", cc], ["bcc", bcc]];
  for (var l = 0; l < lists.length; l++) {
    var kind = lists[l][0];
    var addrs = lists[l][1];
    for (var i = 0; i < addrs.length; i++) {
      if (kind === "to") replacement.toRecipients.push(M.ToRecipient({ address: addrs[i] }));
      else if (kind === "cc") replacement.ccRecipients.push(M.CcRecipient({ address: addrs[i] }));
      else replacement.bccRecipients.push(M.BccRecipient({ address: addrs[i] }));
    }
  }

  pause(1.2);
  var unquoted = false;
  try { unquoted = stripCitation(subject); } catch (e) { unquoted = false; }

  var saved = true;
  try { replacement.save(); } catch (e) { saved = false; }

  // Ask the Drafts mailbox, not the object we just made: "save() did not throw"
  // is precisely the kind of evidence the compose path already learned not to
  // trust. Anything but a new row here means we must not delete the old one.
  var newId = null;
  for (var attempt = 0; attempt < 10 && newId === null; attempt++) {
    pause(0.4);
    var matches = prop(function () { return drafts.messages.whose({ subject: subject })(); }, []);
    for (var k = 0; k < matches.length; k++) {
      var mid = prop(function () { return matches[k].id(); }, null);
      if (mid === null || mid === p.id) continue;
      if (newId === null || mid > newId) newId = mid;
    }
  }

  if (newId === null) {
    return ok({
      replaced: false, degraded: true, capability: "confirmation", draft: facts, saved: saved,
      reason:
        "The replacement was composed but never appeared in " + draftsName + " within four " +
        "seconds, so it could not be confirmed. THE ORIGINAL DRAFT WAS NOT DELETED — there are " +
        "now two, and the new one may still be an unsaved window on screen.",
      hint:
        "Look at Mail: save or discard the open composer, then decide which draft to keep. " +
        "Nothing here will delete either of them."
    });
  }

  var movesToTrash = prop(function () { return acct.moveDeletedMessagesToTrash(); }, null);
  var removed = true;
  var removeError = null;
  /*
   * Re-resolve before deleting, never reuse the original reference.
   *
   * MEASURED: on a syncing account the row id of a just-saved draft is
   * REWRITTEN within seconds — a probe watched a confirmed draft move from
   * 199625 to 199626 while the script was still running, and the reference held
   * across that gap failed with "Can't get object." The reference fetched at the
   * top of this script has been through several seconds of polling and a server
   * round trip by the time we get here, so it is refetched by id.
   */
  try {
    M.delete(mb.messages.byId(p.id));
  } catch (e) {
    removed = false;
    removeError = String(e && e.message ? e.message : e);
  }

  // Read the id back once more: the same sync rewrite that invalidates the
  // original can renumber the replacement between confirmation and return.
  pause(0.4);
  var settledId = newId;
  var finals = prop(function () { return drafts.messages.whose({ subject: subject })(); }, []);
  for (var f = 0; f < finals.length; f++) {
    var fid = prop(function () { return finals[f].id(); }, null);
    if (fid !== null && fid !== p.id && (settledId === newId || fid > settledId)) settledId = fid;
  }

  return ok({
    replaced: true,
    newId: settledId,
    confirmedId: newId,
    draftsMailbox: draftsName,
    subject: subject,
    recipientCount: facts.recipientCount,
    bodyLength: String(p.body || "").length,
    unquoted: unquoted,
    originalDeleted: removed,
    originalMovedToTrash: removed ? movesToTrash : null,
    removeError: removeError
  });
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
      "was readable within 8s. Nothing was written. If a compose window IS on screen, this is a " +
      "permission: reaching it needs BOTH Accessibility and Automation to System Events (a " +
      "different grant from Automation to Mail, which is why every other tool still works), and " +
      "the two fail identically here. Run apple_mail_diagnostics — it reports them separately and " +
      "will say which. Both belong to /Applications/Cupertino.app, NOT to your terminal or to " +
      "node: the app is the process macOS holds responsible and every server inherits its " +
      "identity. If it is already listed, toggle it off and on — the grant goes stale when the " +
      "bundle is reinstalled."
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
