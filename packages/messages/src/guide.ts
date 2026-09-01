/**
 * The Messages operating manual, served as `cupertino://messages/guide` and
 * embedded ahead of every Messages prompt. Static by design — see the note in
 * the Mail guide.
 */
export const MESSAGES_GUIDE = `# Apple Messages — how to drive this server

## Refs are opaque

Chats come back as \`mc1:<guid>\`, messages as \`m1:<guid>\`. Pass them back
verbatim; never construct one.

## Full Disk Access is mandatory here, unlike every other surface

There is no Apple Events read lane to fall back on. Measured: Messages answers
"Application isn't running" even while it is running, because it is a windowless
background process that declines to wake for a script. Without the grant this
server can do **nothing** on the read side — that is a permission problem, not
an empty message history.

## Which tool, under which constraint

- **\`apple_messages_list_chats\`** first, when you need to know which
  conversation you are looking at.
- **\`apple_messages_list_messages\`** reads one conversation in order.
- **\`apple_messages_search_messages\`** searches across them.
- **\`apple_messages_get_message\`** returns one message with its tapbacks and
  attachments.

## Handles are not names

A chat identifies people by phone number or email address. Names come from
Contacts, which has its own separate permission, so \`unknown\` is a normal
outcome — about one in six of even the busiest correspondents has no card. When
diagnostics reports \`contacts.available: false\`, **nobody looked at all** and
every handle is raw. Do not present a raw handle as though the person is
unidentified when the truth is that lookup was never possible.

## Two things that look like missing messages and are not

**Recent messages are stored as blobs.** Messages stopped writing the plain
\`text\` column between late February and late March 2026; everything since lives
only as an archived blob, which this server decodes. \`textSource\` on each result
says which lane answered. A reader without the decoder would report that the
conversation stopped in February — if you ever see history that appears to end
there, that is this, not silence.

**Tapbacks are rows in the message table.** They are filtered out of
conversations and reported on the message they target. A "liked" is not a reply
and should not be summarised as one.

## Sending

\`apple_messages_send_message\` exists only when writes are enabled, and it is the
**only** thing this server can change — the dictionary has no edit, delete,
mark-as-read or reaction command.

Sending is real and immediate. There is no draft state, no undo, and no
confirmation step after the call. Confirm the recipient handle with the user
before sending, exactly as it will be used.

**One call sends one thing.** Messages' send takes a file or a string, never
both, so a photo with a caption is two calls — send the attachment, then send
the text. \`attachmentId\` forwards a file already in this Mac's Messages store,
taking the same id \`apple_messages_save_attachment\` takes; it cannot reach a
file outside Messages' own storage. Sending an arbitrary local path is a
separate, off-by-default capability and usually absent — if there is no
\`filePath\` parameter, that is the answer, not something to work around.

Messages hands back no identifier for what it sent, so the sent row is found by
re-reading the store. \`reconciliation: "pending"\` means it has not appeared yet.
That is **not a failure and must not be retried** — retrying sends the message
twice.
`;
