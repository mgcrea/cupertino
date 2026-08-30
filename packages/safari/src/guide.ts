/**
 * The Safari operating manual, served as `cupertino://safari/guide` and
 * embedded ahead of every Safari prompt. Static by design — see the note in the
 * Mail guide.
 */
export const SAFARI_GUIDE = `# Safari — how to drive this server

## Read-only, and deliberately so

This server cannot open a URL, add to the Reading List, or change anything at
all. It also ships no \`do JavaScript\` verb, so **there is no way to read a
page's content** — not its HTML, not its text. That verb needs a Safari
developer-menu toggle which is not a TCC grant and whose state cannot be read,
so diagnostics could never say in advance whether it would work. Accessibility
is not a way around it: Safari exposes no AXWebArea for page content at all.
If asked for what a page says, fetch its URL yourself and say that is what you
did — a fetch is not the tab, and loses anything behind a login or rendered
client-side. If asked to open or change something, say
plainly that it cannot.

## Two lanes that are not fallbacks for each other

This is the thing to understand about this surface. The lanes see almost
disjoint things:

- **The file lane** (Full Disk Access) holds everything about the **past** —
  history, bookmarks, the Reading List — and nothing about the present.
- **Apple Events** (an Automation grant, Safari running) sees only **what is
  open right now**, which Safari never writes to disk.

An ungranted Safari server is not a slower one. It is a different and much
smaller one, so one lane failing while the other works is normal here.

## Which tool answers which question

- **"What was I reading about X"** → \`apple_safari_search_history\`.
- **"What do I have open"** → \`apple_safari_list_tabs\`. Only this answers it;
  history does not.
- **"What did I save for later"** → \`apple_safari_list_reading_list\`, which is
  not the same as bookmarks and not the same as an open tab.
- **\`apple_safari_list_bookmarks\`** for what was filed deliberately.
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
