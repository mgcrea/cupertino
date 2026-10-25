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
- **Anything that is a NUMBER** — how many, how many did I send, who do I write
  to most, which month was busiest — is \`apple_messages_count_messages\`, with
  \`groupBy\` for a breakdown by day, month, chat, handle or direction. It
  counts every match rather than a page, so never tally a listing by hand: past
  the first \`limit\` that answer is simply wrong. Group by **handle** rather
  than chat when the question is about a PERSON — one person can hold several
  conversations, and \`list_chats\` counts each separately.
- It counts metadata only, and there is no text filter on it. "How many times
  did we say X" is not a question this surface can answer by counting: see the
  blob below.

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

## Watches

\`apple_messages_watch\` and \`apple_messages_unwatch\` exist only when the watch
gate (\`APPLE_MESSAGES_ALLOW_WATCHES\`) is on. If you cannot see them, watches
are off.

- **A filter is required.** Give \`from\` or \`domains\` (email handles only; a
  phone number never matches a domain). There is no watch on all messages.
- **Spell phone numbers in international form**: \`+33612345678\`, with no trunk
  \`0\` and no \`(0)\`. Spaces and punctuation are ignored, but a local spelling
  such as \`06 12 34 56 78\` never matches. An entry the store does not hold is
  kept without spaces or punctuation, lowercased, and listed in \`unresolved\`.
  That is NOT proof the person has not written: it fires only if the store later
  holds exactly that spelling. When the store holds near misses they come back
  as \`suggestions\` (\`typed\`, \`candidates\`); retry with the right spelling.
- **The host subscribes, not you.** \`apple_messages_watch\` returns a handle and a
  \`uri\`. Subscribing to that uri is something the host does; there is no tool
  for it, so do not promise the user a push. A host that never subscribes still
  has a working watch: read the uri whenever you want to know what came in.
- **\`after\` is yours to keep.** A read returns what arrived since the watch
  began, or since the \`after\` you pass, oldest first. The \`cursor\` it returns
  is the last row scanned; pass it back as \`after\` next time. The server does
  not remember what you have seen. When \`more\` is true, read again from
  \`cursor\`.
- **Reads carry no text.** Each message is \`id\`, \`handle\`, \`chat\` and \`date\`.
  Use \`apple_messages_get_message\` with that \`id\` for the text.
- **Your own messages, tapbacks and group events never fire a watch.** A group
  event is a rename, or someone joining or leaving.
- **Limits.** At most 10 watches per connection and 50 entries across \`from\`
  and \`domains\` in one watch. A read returns at most 50 matches and scans at
  most 1,000 rows; \`more\` says when either stopped it.
- **Messages need not be running.** The store is written by the system, not by
  the app, so a watch works with Messages closed.
- Watches end with the connection: after a reconnect, call
  \`apple_messages_watch\` again. Reading a watch that does not exist is a
  not-found error, which is also what a reconnect looks like. A uri with a query
  other than \`after\` is refused as a bad query.

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
