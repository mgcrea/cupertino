import { script } from "./core.js";

/** Accounts, their UUIDs, on-disk directories and mailbox names. ~0.6s for 4 accounts. */
export const LIST_ACCOUNTS = script(`
  var accts = M.accounts();
  var out = [];
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    out.push({
      id: prop(function () { return a.id(); }, null),
      name: prop(function () { return a.name(); }, null),
      enabled: prop(function () { return a.enabled(); }, null),
      accountType: prop(function () { return String(a.accountType()); }, null),
      emailAddresses: prop(function () { return a.emailAddresses(); }, []),
      fullName: prop(function () { return a.fullName(); }, null),
      // Path objects need String(); JSON.stringify renders them as {}.
      directory: prop(function () { return String(a.accountDirectory()); }, null),
      messageCaching: prop(function () { return String(a.messageCaching()); }, null),
      mailboxes: prop(function () { return a.mailboxes().map(function (m) { return m.name(); }); }, [])
    });
  }
  return ok(out);
`);

/**
 * Mailboxes with counts. Counts come from AppleScript rather than the index
 * because they are cheap here (76ms unread / 295ms total on a 29k mailbox) and
 * therefore never need to degrade when Full Disk Access is missing.
 */
export const LIST_MAILBOXES = script(`
  var accts = M.accounts();
  var out = [];
  for (var i = 0; i < accts.length; i++) {
    var a = accts[i];
    var uuid = prop(function () { return a.id(); }, null);
    if (p.accountUuids && p.accountUuids.length && p.accountUuids.indexOf(uuid) === -1) continue;
    var boxes = a.mailboxes();
    for (var j = 0; j < boxes.length; j++) {
      var b = boxes[j];
      var entry = {
        accountUuid: uuid,
        accountName: prop(function () { return a.name(); }, null),
        name: prop(function () { return b.name(); }, null)
      };
      if (p.withCounts) {
        entry.unread = prop(function () { return b.unreadCount(); }, null);
        entry.total = prop(function () { return b.messages.length; }, null);
      }
      out.push(entry);
    }
  }
  return ok(out);
`);

/** Total and unread for one mailbox. */
export const COUNT_MAILBOX = script(`
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var mb = resolveMailbox(acct, p.mailbox);
  if (!mb) return err("MAILBOX_NOT_FOUND", "No mailbox " + p.mailbox + " in that account");
  return ok({
    accountUuid: p.accountUuid,
    mailbox: prop(function () { return mb.name(); }, p.mailbox),
    total: prop(function () { return mb.messages.length; }, null),
    unread: prop(function () { return mb.unreadCount(); }, null)
  });
`);

/**
 * The degraded listing lane: newest N of one mailbox, used when the Envelope
 * Index is unavailable. Costs roughly 130ms + 42ms per message per property,
 * which is why the caller caps N hard (default 50) instead of paginating.
 */
export const LIST_RECENT = script(`
  var acct = findAccount(M, p.accountUuid);
  if (!acct) return err("ACCOUNT_NOT_FOUND", "No account with id " + p.accountUuid);
  var mb = resolveMailbox(acct, p.mailbox);
  if (!mb) return err("MAILBOX_NOT_FOUND", "No mailbox " + p.mailbox + " in that account");
  var mailboxName = prop(function () { return mb.name(); }, p.mailbox);

  var total = prop(function () { return mb.messages.length; }, 0);
  var n = Math.min(p.limit || 20, total);
  if (n <= 0) return ok({ mailbox: mailboxName, total: total, messages: [] });

  // Batch the property reads: one Apple Event per property beats one per message
  // by roughly 6x. slice() on the message collection keeps it to a range specifier.
  var slice = mb.messages.slice(0, n);
  var subjects = prop(function () { return slice.subject(); }, []);
  var senders = prop(function () { return slice.sender(); }, []);
  var dates = prop(function () { return slice.dateReceived(); }, []);
  var reads = prop(function () { return slice.readStatus(); }, []);
  var flags = prop(function () { return slice.flaggedStatus(); }, []);
  var ids = prop(function () { return slice.id(); }, []);

  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      id: ids[i] === undefined ? null : ids[i],
      accountUuid: p.accountUuid,
      mailbox: mailboxName,
      subject: subjects[i] === undefined ? null : subjects[i],
      sender: senders[i] === undefined ? null : senders[i],
      dateReceived: iso(dates[i]),
      read: reads[i] === undefined ? null : reads[i],
      flagged: flags[i] === undefined ? null : flags[i]
    });
  }
  return ok({ mailbox: mailboxName, total: total, messages: out });
`);

/** Resolve a batch of message ids inside one mailbox. ~0.1s even on a 29k mailbox. */
export const GET_MESSAGES = script(`
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
      var summary = messageSummary(m, p.accountUuid, mailboxName);
      if (p.withContent) {
        summary.content = prop(function () { return m.content(); }, null);
      }
      if (p.withSource) {
        summary.source = prop(function () { return m.source(); }, null);
      }
      if (p.withHeaders) {
        summary.allHeaders = prop(function () { return m.allHeaders(); }, null);
      }
      out.push(summary);
    } catch (e) {
      out.push({ id: id, found: false, error: String(e && e.message ? e.message : e) });
    }
  }
  return ok(out);
`);
