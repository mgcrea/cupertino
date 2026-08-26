/**
 * The Mail operating manual, served as `cupertino://mail/guide` and embedded
 * ahead of every Mail prompt.
 *
 * It is deliberately static. Everything else this server exposes depends on a
 * permission, a running Mail or a readable index, and can therefore fail at the
 * exact moment someone needs to understand what is happening. This cannot: it
 * is a string in the bundle, so a completely denied server still explains
 * itself. What it must never contain, in exchange, is anything only a probe
 * could know — no account names, no counts, no permission verdicts. Those live
 * in `cupertino://mail/diagnostics`, which is allowed to fail.
 */
export const MAIL_GUIDE = `# Apple Mail — how to drive this server

## Refs are opaque

Every message comes back with a \`ref\` like \`m1:<accountUuid>/<mailbox>#<id>\`.
Pass it back verbatim. Do not build one, parse one, or carry one across
surfaces — a Mail ref means nothing to Notes or Calendar.

## Which tool, under which constraint

- **Any filter at all** — sender, subject, date bound, unread, attachments —
  is \`apple_mail_search_messages\`. It reads Mail's own index, so it stays fast
  across a six-figure archive.
- **\`apple_mail_list_messages\`** is a capped listing of one mailbox in date
  order. It is the fallback when the index is unreadable, not the default.
- **Body text** is the \`body\` argument of the search tool, and it is the one
  expensive path here: macOS has no body index, so it opens the message files
  of whatever the other filters leave. Always combine it with a narrowing
  filter (mailbox, sender, \`dateFrom\`).
- **A conversation** is \`apple_mail_get_thread\`, not several \`get_message\`
  calls.
- **Counts** are \`apple_mail_count_messages\`. Do not count by paging a search.

## \`degraded: true\` is not an empty result

Two failures look identical from the outside and must never be reported the
same way:

- \`degraded: true\` with \`capability: "search-index"\` means the index could not
  be read — usually Full Disk Access. **Nothing was searched.**
- \`degraded: true\` with \`capability: "body-scan"\` means the other filters left
  more messages than the scan bound allows, so **nothing was scanned**. Narrow
  and retry; do not report it as "no matches".

Say "I could not check" for both. Reporting either as "I found nothing" is the
worst thing this server can be made to do, because it is indistinguishable from
a real answer and quietly wrong.

Mailbox \`unread\` from the AppleScript lane is Mail's cached badge value and can
disagree with the truth — 0 has been observed for a mailbox holding 1618 unread
messages. Prefer the index; results are labelled with their source.

## Writes

Mutating tools are registered only when writes are enabled. If you cannot see
\`apple_mail_send_message\`, writes are off — say so rather than describing a
draft you could not create.

When they are on, \`sendNow\` defaults to **false** on all three compose tools:
they open a draft in Mail for a human to review. That default is the safety
property, so do not set \`sendNow: true\` to be helpful.

One trap: \`apple_mail_reply_to_message\` and \`apple_mail_forward_message\` called
without a \`body\` leave an **empty** draft with the original quoted beneath.
That is a blank page, not a written reply. Fill the body, or tell the user
plainly that the draft is empty.
`;
