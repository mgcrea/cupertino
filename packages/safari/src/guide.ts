/**
 * The Safari operating manual, served as `cupertino://safari/guide` and
 * embedded ahead of every Safari prompt. Static by design — see the note in the
 * Mail guide.
 */
export const SAFARI_GUIDE = `# Safari — how to drive this server

## What this server can and cannot do

It reads history, bookmarks and the Reading List; it sees live tabs; and
through the bundled Safari extension it reads, clicks, types in and scrolls a
page. Behind the write gate it also opens a URL and saves one to the Reading
List. If the gate is off, say plainly that it cannot rather than trying.

Page content comes from the extension, for websites the user has allowed it
on. \`apple_safari_read_page\` asks the open tab for its content first and
says \`source: "live"\` when it answered; a hidden or closed tab gets the
snapshot the extension stored instead, with \`source: "capture"\` and a
\`liveRead\` line saying why — check \`ageSeconds\` before calling that the
current page. The acting tools (\`page_elements\`, \`click\`, \`fill\`,
\`scroll\`) always go to the live page, and cost about a second on a visible
tab and up to ten on a hidden one. To read a FORM — what a field holds,
whether a box is ticked — use \`page_elements\`: field values are not page
text.

There is still no \`do JavaScript\` verb, and Safari exposes no AXWebArea for
page content, so the extension is the only route — which is the point: Safari
scopes it per website, and the toggle would not have been scoped at all.

## Field values, and the one-time-code setting

\`apple_safari_page_elements\` reports what a text field currently holds, in
\`value\` — except where the field looks like it holds a secret. A password or
a card number comes back \`redacted: "credential"\` and NO setting returns it.
A one-time 2FA field comes back \`redacted: "code"\` unless the user has
switched on "Read one-time codes"; \`hasValue\` still says whether it is filled.

When that setting is on, \`apple_safari_find_codes\` also exists, for the more
common case: a code the page shows as TEXT, where there is no field to
enumerate at all. It scans the live DOM, so it sees a code that arrived after
the page loaded and that \`read_page\` therefore never captured. It cannot tell
an expired code from a live one — there is no timestamp on a paragraph — so
check \`confidence\` and prefer a code the user can confirm.

## Filling a code you just read

The whole sequence, and the order matters less than it looks:

1. \`apple_safari_page_elements\` on the page ASKING for the code, to get the id
   of the field.
2. \`apple_safari_find_codes\` on the page SHOWING it — or
   \`apple_messages_find_codes\` if it arrived by SMS.
3. \`apple_safari_fill\` the id from step 1 with the code from step 2.

Reading a code does NOT invalidate ids from step 1: ids die on navigation or on
a re-enumeration of THAT page, and neither scanning a different page nor
scanning the same one enumerates anything. Only \`page_elements\` hands out ids,
and only it clears the old ones. An id also belongs to the one tab that answered
— with two tabs on the same URL the other refuses it — and a reload kills it
just as a navigation does.

\`fill\` does not submit. Click the submit button separately.

**Two things that make this fail, both worth checking rather than assuming.**
A code may be expired — nothing here can tell, so if the user has been waiting,
ask them to trigger a new one. And a site that splits the code across six
single-character boxes cannot be filled by one \`fill\`; enumerate again
afterwards and look at \`hasValue\` before clicking submit.

## Debugging a page, and getting a file out of an API response

Only when the user has switched on "Read network traffic"
(\`APPLE_SAFARI_ALLOW_NETWORK\`); otherwise none of these tools exists, so say
so rather than looking for them. They show what a page FETCHED, which is the
question \`read_page\` cannot answer: why a button did nothing, which call came
back 403, what an app's JSON actually held.

1. \`apple_safari_network_record\` with \`action: "start"\` on the page. Nothing
   is recorded before this, so a request that already happened is gone. To see a
   page's FIRST requests pass \`reload: true\`, which needs the write gate on
   because it re-runs the page; otherwise start, then trigger the request.
2. \`apple_safari_network_list\`, filtered: \`failed: true\`, \`status: "400-599"\`,
   \`urlContains\`. It returns metadata only, with ids.
3. \`apple_safari_network_get\` on an id for headers and body. Inline reads are
   capped at 20,000 characters; \`nextOffset\` continues.

**To get a file out** (a signed PDF that the page holds as base64 inside a JSON
response, for example), do not read the body inline. In ONE call to
\`network_get\` pass \`jsonPath\` to the field, \`decode: "base64"\` and
\`saveAs: "name.pdf"\`. The bytes go to the user's download folder and never
into this conversation; the result gives the path, the size and a sniffed type.
\`saveAs\` needs the write gate and will not overwrite unless \`overwrite: true\`.
A \`type: null\` means the type was not recognised, not that the save failed.

**What it cannot see**, and a missing request may be one of these rather than a
bug: subframes (an embedded iframe's traffic), web and service workers,
\`<img>\`/\`<script>\` bodies, and WebSockets. Ids die when the page reloads or
navigates, so list again afterwards. A body whose \`bodyTruncated\` is true was
cut at the recording's size limit; record again with a larger \`maxBodyBytes\`.
On a page with a strict Content-Security-Policy there is a fallback that loads
the recorder by URL (\`hook.injection: "src"\` in the record answer). It has not
been verified in Safari: if \`hook.worlds\` does not come to include "main", it
did not get in, so say that rather than reporting an empty list as "no
traffic". When it does work it arrives late, so the very first requests can be
missing even after \`reload: true\`.

**Bodies are NOT redacted, and neither are URLs.** Only credential-looking
HEADERS are masked; a URL comes back in full, query string and any token in it
included. A body can hold a token or a person's data, so read one only when you
need it, and do not repeat what is in it back to the user beyond what the task
requires.

## Three lanes that are not fallbacks for each other

This is the thing to understand about this surface. The lanes see almost
disjoint things, and each needs a different permission:

- **The file lane** (Full Disk Access) holds everything about the **past** —
  history, bookmarks, the Reading List — and nothing about the present.
- **Apple Events** (an Automation grant, Safari running) sees only **what is
  open right now**: which tabs, and their URLs and titles. Never their content.
- **The extension** (enabled in Safari, allowed per website) is the only thing
  that sees **what a page says**.

An ungranted Safari server is not a slower one. It is a different and much
smaller one, so one lane failing while the others work is normal here — and
because each lane has its own permission, they fail independently. Check
\`apple_safari_diagnostics\` rather than guessing which one is missing.

## Which tool answers which question

- **"What was I reading about X"** → \`apple_safari_search_history\`.
- **"What do I have open"** → \`apple_safari_list_tabs\`. Only this answers it;
  history does not.
- **"What did I save for later"** → \`apple_safari_list_reading_list\`, which is
  not the same as bookmarks and not the same as an open tab.
- **\`apple_safari_list_bookmarks\`** for what was filed deliberately.
- **"What does this page say"** → \`apple_safari_read_page\`, with the URL from
  \`apple_safari_list_tabs\`. Not \`apple_safari_get_page\`, which despite the
  name returns a history row and no content at all.
- Refs look like \`s1:<url>\`; pass them back verbatim.

Choosing the wrong one produces a confident answer to a different question, and
that is the common failure on this surface.

## A null \`history\` on a tab means NOT FOUND

Measured across three real runs: 60.7%, 55.3% and **8.3%**. The rate is a
property of the tab set, not of the surface, so no central figure describes it.
Safari offers no shared identifier between the lanes; the URL is the only join
key and it is trivially lossy. A tab with no history match has **not**
necessarily never been visited, and must never be reported that way.

The dominant cause is single-page apps: a page reached by pushState commits no
history row, so the URL is genuinely absent however it is spelled. The second is
that the variant ladder only strips cruft OFF a tab's URL, so it cannot reach a
stored row carrying MORE query string than the tab shows.

Each match reports HOW it was made, and the rungs are not equally strong:

- \`exact\` — byte-identical. Usually the row is about this page, but not always:
  a reused address like \`localhost:4321\` matches exactly and can be a different
  site entirely. If the tab's own title disagrees, trust the tab.
- \`normalized\` — differed by a fragment, trailing slash, scheme, \`www.\` or a
  tracking parameter. Same page.
- \`query-stripped\` — matched only with the whole query gone. The row is about
  the PATH, so its visit count may cover other views of the same URL. Say so
  rather than attributing the count to this exact page.

History timestamps sit on an epoch detected from the store rather than an
assumed one, because an earlier probe misread that column by 31 years. When
detection fails, dates read null rather than being guessed — treat a null date
as unknown, not as old.
`;
