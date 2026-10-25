# Composing, and how a draft is edited

Regenerate the dictionary evidence with `sdef /System/Applications/Mail.app` on each new macOS
release. Read on macOS 26.6, and checked against a live Mail with four accounts — see
[Measured against a live Mail](#measured-against-a-live-mail), where two of the three findings
contradict the dictionary. One claim in an earlier version of this file was itself wrong --
see [Attachments can be added](#attachments-can-be-added-and-the-dictionary-always-said-so).

**Implemented, in two lanes.** `apple_mail_update_draft` first tries to edit the draft **in its own
composer window** (`packages/mail/src/client/revise.ts`), which keeps threading, attachments and the
quoted original because nothing is recreated. Only when no composer is open does it fall back to
recreating the draft (`packages/mail/src/client/jxa/write.ts`), which is where the familiar refusals
live. The heading below — "why a draft cannot be edited" — is still true of Apple Events and is no
longer true of the tool.

**Checked live** — `node scripts/verify-mail-ax.mjs --compose` forwards a real message to your own
address through the hosted mail server, asserts the body arrived in the composer, and then rewrites
that draft in place and asserts `method: "inPlace"`. It sends nothing. Nothing else in the suite can
tell you whether macOS still honours this lane.

## The question

"Change the wording in that draft" is the most obvious request an agent gets about mail, and the
one this server answered with nothing for the longest. The reason turned out not to be effort. It
is that Mail's scripting interface does not offer it, and the evidence for that is worth writing
down once because it is expensive to re-derive and every attempt looks plausible until it fails
silently.

## Four facts from Mail's own dictionary

| Read from `sdef`                                                                                                                                | Consequence                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.content` is `access="r"`                                                                                                               | A saved draft **is** a `message`. Its body cannot be assigned to.                                                                                                                                                                                                                                                                |
| No `open` command, no `edit` command anywhere in the suite                                                                                      | Nothing reopens a saved draft as something writable. The full command list is `delete`, `duplicate`, `move`, `bounce`, `check for new mail`, `extract name from`, `extract address from`, `forward`, `GetURL`, `import Mail mailbox`, `mailto`, `perform mail action with messages`, `redirect`, `reply`, `send`, `synchronize`. |
| `outgoing message` — the class whose `content` IS writable — is produced only by `make new outgoing message`, `reply`, `forward` and `redirect` | None of the four takes an existing draft as input.                                                                                                                                                                                                                                                                               |
| The only class ever linking the two is `OLD message editor`                                                                                     | `hidden="yes"`, `description="DEPRECATED - DO NOT USE"`.                                                                                                                                                                                                                                                                         |

A fifth is worth naming on its own, because it is the first thing anyone reaches for and it fails
in the quietest possible way:

```xml
<property name="html content" code="htda" type="text" access="w" hidden="yes"
          description="Does nothing at all (deprecated)"/>
```

**Apple documents it as a no-op.** It is write-only, so nothing can be read back to notice, and it
accepts every assignment. `vcard path` on the same class carries the identical description.

So there is no edit path **through the scripting interface**. There is only recreation.

> **Amended 2026-09-06.** That sentence was written about Apple Events and is still true of them.
> It is not true of the app: a composer's body CAN be edited in place through the Accessibility
> lane, and the measurement is in
> [Editing in place](#editing-in-place-works-and-is-now-the-first-choice) below. What is
> missing is not the edit — it is a route from a saved draft back to a composer.
>
> **Amended 2026-09-18.** And that last sentence is now only true of a draft whose composer has
> been CLOSED. For one whose window is still open — which is every draft this server has just
> written — there is no route to find, because the composer never went away. `update_draft` edits
> it there and recreates nothing. See
> [Editing the composer that is already open](#editing-the-composer-that-is-already-open).

## Two kinds of "draft", and only one of them is this

The word covers two different objects, and the tools do different things to them:

- **An open composer** — what `send_message`, `reply_to_message` and `forward_message` leave on
  screen with `visible: true`. It is a live `outgoing message`, and the body reaches it by paste
  (see below), not by assignment.
- **A saved draft** — a `message` sitting in `account.draftsMailbox` (`access="r"`, top level).
  This is what `update_draft` takes, addressed by an ordinary message ref.

`update_draft` refuses anything whose mailbox is not the account's Drafts mailbox. The refusal is
not tidiness: the ref for a sent message is shaped exactly like the ref for a draft, and
"editing" a sent message by deleting it and writing a lookalike in its place is not editing.

## Reading the drafts that are open

"Review my draft" names no message, and the draft meant is the one on screen.
`apple_mail_list_open_drafts` reads every compose window
([`MailAxLane.composers`](../packages/mail/src/client/ax.ts), which asks the app's `apple_desktop_mail_composers` verb since 2026-10-26). Measured 2026-10-06 on macOS
27.0, against a reply composer the user had opened by hand:

| Tried                                   | Answer                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Mail.outgoingMessages()` over JXA      | **`[]`**, with the composer on screen. The class lists only composers a script made, so Apple Events cannot answer this at all.                                                                         |
| The window's depth-1 fields             | Found by identifier — `Mail.toField`, `Mail.ccField`, `Mail.subjectField`, `popup_from` — which do not change with the language, unlike the labels. The subject field, not the title, marks a composer. |
| A recipient field's `AXValue`           | `"￼"`, one per recipient. Each token is a child with subrole `AXTextAttachment` whose value is the **display name**. AXDescription, AXHelp, AXTitle, AXValueDescription and AXIdentifier are null.      |
| The body, split by `AXBlockQuoteLevel`  | The same exact split the in-place edit uses: 0 on the user's lines, 1 from `On <date>, <who> wrote:` down.                                                                                              |
| The index, Drafts mailbox, same subject | One row, autosaved at the moment the composer was last saved. This is where the addresses are.                                                                                                          |

So each draft comes back with the names the window shows, and with `savedDrafts`: the
autosaved copies under the same subject, newest first. Those carry the addresses through
`get_message` and are what `update_draft` takes. They are matched by subject alone and offered as
candidates, not asserted. `update_draft` compares content before it edits, so a wrong candidate is
refused rather than overwritten. A body whose quote boundary cannot be read comes back whole with
`quoted: null`, so the quoted thread is never presented as the user's own text.

## Why the body still cannot go through the scripting interface

Settled earlier and recorded here for completeness, because it is the same failure mode.

`reply` and `forward` hand back an `outgoing message` whose `content` reads as `""` and swallows
every write — **measured on macOS 26, with and without `opening window`, immediately and six
seconds later**, and the same for setting `AXValue` on the composer's web area, which reports
itself settable and then does nothing. Recipients, subject and threading DO come through, which is
what made the original failure so bad: a draft correct in every visible respect except the words,
reported as a success.

So a body is pasted into the composer window and read back out of it. Nothing reports a draft as
ready on the strength of an assignment having been accepted, because that is exactly what lied.

Mail also wraps any body set by AppleScript in `<blockquote type="cite">` — FB11734014, filed 2023,
still open — so the composer's Format ▸ Quote Level ▸ Decrease is driven to undo it. That menu only
validates for the frontmost application, so Mail has to come forward for a moment; the composer is
shrunk and pushed off-screen for the duration and then put back exactly where it was found, because
Mail persists the compose window's frame and a window left at 1×1 is inherited by the next composer
opened by hand. A window whose geometry cannot be read back is not moved at all.

> **Amended 2026-10-22: that undo is now the fallback, and it had been failing silently for two
> months.** See [A new message went out as one long quote](#a-new-message-went-out-as-one-long-quote).

## What recreation cannot carry across

Two things, and both are invisible in the result, which is why both are refused rather than
dropped:

| Lost            | Why                                                                                                                                                                                                                                                                 | What `update_draft` does                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Threading**   | `In-Reply-To` and `References` are written by Mail's own `reply` command, which needs the original message. A recreated reply draft looks perfect and starts a new thread.                                                                                          | Reads `all headers`; refuses if either header is present, pointing at `reply_to_message` instead. |
| **Attachments** | Not a dictionary limit — see [Attachments can be added](#attachments-can-be-added-and-the-dictionary-always-said-so). The bytes live in the original's sidecar tree, not as a file on disk, so re-attaching means extracting them first. Possible; not implemented. | Counts `mailAttachments`; refuses if any.                                                         |

A third case is a limitation rather than a loss: a draft with **no subject** is refused unless the
caller supplies one, because the subject is the only handle for finding the replacement again
after Mail saves it, and without that confirmation the original cannot be deleted safely.

## Attachments can be added, and the dictionary always said so

This section corrects an earlier claim in this file. It said Mail "has no verb for adding an
attachment to an `outgoing message`". That is wrong, and the way it was wrong is worth keeping,
because it is a reading error anyone re-deriving this will repeat.

The command list in [Four facts](#four-facts-from-mails-own-dictionary) is the **Mail suite's**
commands. `make` is not in it because `make` belongs to the **Standard Suite**, which Mail pulls in
wholesale:

```xml
<xi:include href="file://localhost/System/Library/ScriptingDefinitions/CocoaStandard.sdef"
            xpointer="xpointer(/dictionary/suite/node()[not(self::command and
                      ((@name = 'delete') or (@name = 'duplicate') or (@name = 'move')))])"/>
```

Only `delete`, `duplicate` and `move` are overridden. `make` comes through untouched. And the Text
Suite supplies the class to make:

```xml
<class name="attachment" code="atts" inherits="rich text"
       description="Represents an inline text attachment. This class is used mainly for make commands.">
  <property name="file name" code="atfn" type="file" description="The file for the attachment"/>
</class>
```

`attachment` is an `<element>` of `rich text`, and `outgoing message`'s content is
`<contents name="content" code="ctnt" type="rich text"/>`. The Text Suite carries
`<access-group identifier="com.apple.mail.compose" access="rw"/>`. So the chain is licensed
end to end, and the class description names `make` as its purpose.

### Measured on macOS 26.6 (build 25G72)

Four accounts, a 180x180 PNG and a 1-page PDF staged in `/private/tmp`, three mails sent to the
author's own iCloud address and deleted afterwards.

| Probe                                                                        | Result                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| AppleScript `make new attachment ... at after the last paragraph`            | Works. `count of attachments of content` = 1.                                                     |
| JXA `m.content.attachments.push(M.Attachment({fileName: Path(f)}))`          | **Works.** No throw, count = 1. This is the form to ship.                                         |
| JXA `M.make({new:"attachment", ..., at: m.content.paragraphs.at(-1).after})` | Works. Equivalent, more verbose.                                                                  |
| JXA `... at: m.content.attachments.end` or `paragraphs.end`                  | Throws `Invalid key form.`                                                                        |
| Survives `send()`                                                            | **Yes.** Received mail carries `image/png` and `application/pdf` parts, base64, with `filename=`. |
| On the `reply` composer                                                      | **Yes**, and `In-Reply-To`/`References` survive with it.                                          |

Two caveats that matter more than the yes:

**The disposition is `inline`, not `attachment`.** The file is placed at a point in the body flow,
and Mail emits it the way it emits a file dragged into a compose window by hand:

```
multipart/alternative
├── text/plain                                    <- the plain alternative; names nothing
└── multipart/mixed          (multipart/related when there is one file on a reply)
    ├── text/html
    ├── image/png        Content-Disposition: inline; filename=probe.png
    ├── text/html
    ├── application/pdf  Content-Disposition: inline; filename=probe.pdf
    └── text/html
```

This is native Mail output, not a degraded form — but it is a body edit, so **order is caller-visible**
and the `text/plain` alternative mentions nothing. A PDF behaves exactly like a PNG here; there is
nothing image-specific about it.

**`content` still lies on a reply.** On the composer returned by `reply`, `content` read back as
length 1 — the attachment character alone, with none of the quoted original. So the count read back
from that path is not evidence of anything; the send is. Consistent with
[why the body cannot go through the scripting interface](#why-the-body-still-cannot-go-through-the-scripting-interface).

### What ships

`apple_mail_send_message`, `reply_to_message` and `forward_message` take `attachments`, a list of
absolute paths. It is a parameter rather than an `add_attachment` tool because the scripting object
is the only handle on a composer and it dies with the `osascript` that made it; a separate tool
would have to find the draft again after Mail saves and renumbers it, which is the hardest part of
`update_draft`. So files go on at compose time, in `SEND_MESSAGE` and `OPEN_COMPOSER` (and the
System Events fallback, `REPLY_OR_FORWARD`), through one prelude helper, `attachFiles`.

> **Amended 2026-10-22.** That hardest part had already been solved, by `update_draft` itself: its
> in-place lane finds a draft's open composer and proves it is the right one. So `update_draft` now
> takes `attachments` too — see [Adding files to an open draft](#adding-files-to-an-open-draft).
> Without it an agent asked to attach something to a reply fell back to driving File ▸ Attach
> Files… by hand.

| Bound                                 | Where                                       | Why                                                                                                                     |
| ------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Absolute, present, a file             | `#resolveAttachments` in `client/mail.ts`   | A directory or a dangling path fails with a sentence, before Mail is asked anything.                                    |
| On a draft: `ALLOW_WRITES`            | same                                        | The default leaves the composer on screen, so a person sees the file before it goes.                                    |
| With `sendNow`: `ALLOW_FILE_SEND` too | same                                        | Nobody looks. Mail's read tools carry strangers' text, and `confirm` is filled in by the model, as in docs/messages.md. |
| Only `Path(list[i])`                  | `attachFiles`, pinned by `test/jxa.test.ts` | No script names a file of its own.                                                                                      |

No directory confinement, for the reason docs/messages.md gives. A refused file stops the call
before anything is typed or sent and takes the composer back with `discardComposer`, so the
result is never a message that went out without the file it was asked to carry.

The count reported back is Mail's own on a new message. On a reply or forward it is the number
pushed, because `content` reads back as the attachment characters alone there (above).

## Adding files to an open draft

Measured 2026-10-22 against a live Mail on macOS 27.0, on a new message addressed to the author,
through the native Accessibility lane. `apple_mail_update_draft` with `attachments` (and, now
optionally, a `body`) does this in the draft's own composer.

**A file URL pasted into the body attaches the file**, the way a file copied in Finder does. The
pasteboard was written with `NSPasteboard.writeObjects` of `NSURL`s, which publishes
`public.file-url` and `NSFilenamesPboardType`, then command-V into the focused web area:

| Pasted               | Reads back in the sender's own block                                  |
| -------------------- | --------------------------------------------------------------------- |
| `attach-probe.png`   | `AXImage` named `attach-probe.png`, with an unnamed child `AXButton`  |
| `attach-probe.txt`   | `AXButton` named `attach-probe.txt, 23 bytes`                         |
| the text beside them | the `AXStaticText` unchanged: a file has no value                     |
| after command-S      | ONE draft; `mailAttachments` = `attach-probe.txt`, `attach-probe.png` |

So a file is identified by its name, and by its name followed by a comma: the size is localised and
the filename is not (`isFileNamed` in `client/ax.ts`). The text reading in `#split` is untouched by
a file, which is what lets the same read prove both that the files arrived and that the words
around them did not move.

### The sequence

    select the sender's own text, proven by copy-back      (as for a body rewrite)
    right arrow                                             collapse to its end, above the quote
    -- or, with a body: paste it; the caret ends after it
    file URLs onto the pasteboard, command-V
    read back  -> compare                                   each name once more than before,
                                                            and the text exactly as it was
    command-S

**The text check is the one that matters.** If the selection were not collapsed, the paste would
REPLACE the sender's words with the files, and the files would then read back perfectly. Comparing
the text before and after is what stops that from being saved. "Once more than before" stops a file
of the same name already in the draft from being taken as proof.

**No window, no files.** Recreating a draft writes a new body, so with files and no body there is
nothing to recreate it from, and the tool refuses rather than rebuilding the old text from its
plain rendering. With a body, on a draft that recreation accepts (not a reply, no files of its
own), `UPDATE_DRAFT` attaches them to the replacement through `attachFiles`, before the save, so a
refused file leaves the original untouched.

### Two traps on the way

**`$(jsArray)` drops files.** Bridging a JavaScript array of two `NSURL`s with `$()` wrote ONE
pasteboard item, and `writeObjects` still answered `true`. `systemClipboard.writeFiles` builds an
`NSMutableArray` and then checks `pasteboardItems.count` against the number of paths, and that
count is bridged: compared as it comes, `2 !== 2`, so it goes through `Number()` first.

**The first write was wiped before the paste, once.** On the probe's first attempt the pasteboard
read EMPTY at the moment of command-V, a few seconds after a write that had read back with six
types. Nothing in the app clears it (`clearContents` appears only behind two buttons in its own
windows), and a write left alone for a second survives its writer exiting. Unexplained. Nothing
here depends on it: the files are written immediately before the paste, and a paste that brings
nothing is caught by the read-back and not saved.

## A new message went out as one long quote

Reported 2026-10-22: a new message to a colleague looked normal in Mail, and his Outlook reply showed
the whole of it as a quotation. Its source, from Sent:

```
text/plain   > Hi Dave,
             >=20
             > Arkadi wants the same models running in both data centres, ...
text/html    <div class="Apple-Mail-URLShareUserContentTopClass"><br></div>
             <div class="Apple-Mail-URLShareWrapperClass" style="position: relative !important;">
             <blockquote type="cite" style="border-left-style: none; color: inherit;
                                            padding: inherit; margin: inherit;">
             Hi Dave,<br><br>Arkadi wants ...
             </blockquote></div>
```

That is FB11734014's wrapper, styled so that Mail draws no bar. Mail shows nothing wrong; every other
client honours the `cite` and the `> `. A scan of Sent since 2026-08-01 found **23** such messages,
every one a new message and none of about 140 replies.

### Why nobody saw it

`SEND_MESSAGE` assigned `content`, and the undo, `stripCitation`, drives Mail through **System
Events**. When the server is hosted by Cupertino that grant is not needed for anything else and was
not held — diagnostics read `automationSystemEvents: "error"`, `composerUiRead: "denied"` — so the
undo failed on every call. The failure was caught as "cosmetic" and reported as `unquoted: false`,
a flag nothing read, and with `sendNow` the message went out anyway. Replies were never affected
because the native lane pastes their body and never assigns it. `MailAxLane.selectAll` and
`maxQuoteLevel` had been written "for the quote strip" when that lane was built and were never
called: new messages were simply never moved over.

### What triggers the wrapper, measured

macOS 27.0, three drafts to the author's own address, sources read back from Drafts:

| Created with                                        | Wrapper in the saved source                                         |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `content: ""`, then the body pasted                 | yes, EMPTY, below the pasted text, which sits outside it at level 0 |
| no `content` at all, then the body pasted           | **none**: plain `<div>`s                                            |
| no `content`, then `content.attachments.push(file)` | yes, with the FILE inside it                                        |

So the trigger is any Apple Events write to `content`, an attachment included. That last row also
means the compose-time attachments shipped in 1.28.0 sat inside a hidden quote on every new message.

### What ships

**When the app hosts the server, nothing assigns `content` any more.** `send_message` goes through
the same native path as a reply (`composeNatively` in `client/compose.ts`): `OPEN_COMPOSER` in mode
`new` creates the message with a subject and recipients only, the body is pasted and read back, and
files are pasted after it the way `update_draft` pastes them. `OPEN_COMPOSER` no longer attaches for
a reply or forward either. `update_draft`'s recreate route is split the same way:
`STAGE_REPLACEMENT` opens the replacement with no body, the client fills and saves its window, and
`COMMIT_REPLACEMENT` confirms it in Drafts before deleting the original. Both halves share
`UPDATE_DRAFT`'s preflight and its confirm-then-delete tail, so the refusals and the order are the
same on both routes.

**When it does not — or for a new message with no subject, whose window has no stable title — the
old assigning path remains, and a failed undo is loud.** `SEND_MESSAGE` returns `quoted: true`,
`degraded: true` and a note saying recipients will see a quotation, and with `sendNow` it does NOT
send. `UPDATE_DRAFT` discards the replacement unsaved and keeps the original.

`node scripts/verify-mail-ax.mjs --compose` now composes a new message too, and fails if the saved
draft's source holds a `blockquote` at all.

## The order is the safety property

The replacement is created **and confirmed present in the Drafts mailbox** before the original is
deleted. Never the reverse.

A delete-then-create that fails halfway has destroyed something a person wrote. This server has no
undo, and Mail's Trash may not even be involved — `moveDeletedMessagesToTrash` is a per-account
setting, so whether a delete is recoverable is the account's decision and not ours. It is reported
back on success for exactly that reason.

Confirmation asks the Drafts mailbox for a row, not the object that was just composed. `save()`
returning without raising is precisely the class of evidence the compose path already learned not
to trust. If no row appears within ten polls the tool returns `replaced: false`, says plainly that
**the original was not deleted and there are now two**, and stops. `packages/mail/test/update-draft.test.ts`
runs the shipped script against a fake Mail that lies in that way; the assertion in every refusal
case is the same one — the original is still there.

## Measured against a live Mail

Run on macOS 26.6 against four accounts — iCloud, two IMAP (one Gmail), one Exchange — with a
single throwaway draft created and removed. Three findings, and two of them broke the first version
of this tool.

### `save()` works, and it is fast

`msg.save()` on an `outgoing message` returns without raising, and the row appears in the account's
Drafts mailbox **on the first poll** — under 400 ms, before any server round trip. The ten-poll
confirmation loop is therefore generous rather than necessary, which is the right way round: it
exists so a failure is safe, not because a failure is expected.

### `account.draftsMailbox` does not work — on any account

```
account.draftsMailbox   ->  "Can't get object."     (iCloud, IMAP, IMAP, Exchange)
application.draftsMailbox -> "All Drafts"           (resolves)
```

It is declared `access="r"` on both `account` and `application`, and only the application-level one
answers. That one is the **unified smart mailbox**, so it is not what a message reports as its own
container and cannot be compared against directly.

The name is discovered instead: every message in All Drafts reports its real per-account mailbox
through `mailbox()` and `mailbox().account()`, both of which work.

```
All Drafts (20 messages)
  Magenta :: Drafts   9      iCloud :: Drafts   1
  Rgis    :: Drafts   9      Google :: Drafts   1
```

All four spell it `Drafts` — including Gmail, with no `[Gmail]/` prefix, and Exchange, which
localises its siblings to `Sent Items` and `Deleted Items`. Hardcoding the string would have worked
here and would fail on a localised Mail, so discovery is used and the documented property is still
tried first, which repairs itself if Apple ever fixes it.

### A draft's row id is rewritten by sync, within seconds

The probe confirmed its new draft at row **199625** and found it at **199626** moments later. The
reference held across that gap died with `Can't get object.` — which is how the probe's own cleanup
failed and left a stray draft behind, needing a second pass that resolved by id afresh.

This is the same hazard `MOVE_MESSAGES` already documents for a moved message, arriving from a
different direction: nothing moved, the server just renumbered the row underneath a live reference.
So `update_draft` refetches the original by id immediately before deleting it rather than reusing
the reference from the top of the script, and reads the replacement's id back one final time. The
result carries both `confirmedId` and `newId` for that reason.

**A ref to a freshly saved draft on a syncing account is short-lived.** Re-find it by subject rather
than holding the ref across turns.

## Editing in place works, and is now the first choice

Measured 2026-09-06 against a live Mail on macOS 26.6, driving the composer through the native
Accessibility lane rather than Apple Events.

**Replacing a composer's body works, and it updates the SAME draft.** Focus the body's `AXWebArea`,
command-A, command-V, command-S:

    draft content before  ->  "ALPHA ORIGINAL TEXT"
    draft content after   ->  "BRAVO REPLACEMENT TEXT — line one\nBRAVO line two"
    drafts with that subject, after  ->  1

One draft, not two. Read back through Apple Events from `draftsMailbox`, so this is the store's
answer and not the window's. Command-S saves and leaves the window open, and the row id was rewritten
twice across the sequence — 201457 → 201458 → 201459 — which is the sync renumbering this file
already records, seen again.

So every refusal `update_draft` carries exists because of **recreation**, not because of editing. A
reply draft's `In-Reply-To` survives an in-place edit because nothing recreates the message;
attachments survive for the same reason; and the subject is not needed as a handle because the
replacement is never looked up.

**And none of that is reachable from a saved draft on its own, because Apple Events cannot open one
into a composer.**

| Route tried                              | Result                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `M.open(draft)`                          | Opens a **read-only viewer**, titled `"<subject> — All Drafts"`                 |
| that window's accessibility tree         | No `AXWebArea`. Content is an `AXScrollArea` marked `message content`           |
| that window's toolbar                    | Archive, Delete, Junk, Reply, Reply All, Forward, Summarize. No edit affordance |
| Mail's `Message` menu, with it frontmost | No edit item exists, and every item present is disabled                         |

This is the fifth dictionary fact, confirmed from the other side: `open` is not in the command list,
and the `open` that AppleScript's Standard Suite supplies anyway does not do what the name suggests.

What is left is the message list — select the draft in a viewer and open it the way a person does.
That was not built, and the reason is scope rather than difficulty: reaching the row means changing
which mailbox the user's window is showing. `make new message viewer` gives a private window to drive
instead, and it was tried; it left the user's own viewer switched to Drafts and a ghost window that
Apple Events reported and could not close.

That was where this stopped for twelve days. What it missed is in the next section: the composer
does not have to be REOPENED, because in the case that matters it was never closed.

**An aside worth keeping.** Through that experiment, Mail's Apple Events window list disagreed with
its accessibility tree — three windows named against one actually on screen:

    Mail's own `name of every window`  ->  All Inboxes, iCloud Mail Cleanup, Drafts — iCloud
    kAXWindowsAttribute                ->  All Inboxes  (one window, not minimized)

`MailAxLane.findComposer` identifies windows through the accessibility lane already, which this says
was the right choice for a reason nobody had measured: the Apple Events list is stale, and a composer
found in it may not exist.

## Editing the composer that is already open

Measured 2026-09-18 against a live Mail on **macOS 27.0 (build 26A428)**, driving the native
Accessibility lane. This is what `apple_mail_update_draft` now does first; recreation is the
fallback.

### The realisation

The blocker above was written as "a route from a saved draft to a composer", and every attempt at it
meant moving the user's message list. But the request this tool exists for is _"draft a reply — now
change this line"_, and at the moment it arrives **the composer is still on screen**. Nothing in
this server ever closes one: `reply_to_message` presses command-S, which saves the draft and leaves
the window open. There was no route to build.

So the refusals in `UPDATE_DRAFT` — threading, attachments — were never costs of _editing_. They are
costs of _recreating_, and a draft whose window is open does not have to be recreated.

### The quote is the hard part, and `AXBlockQuoteLevel` solves it

Command-A selects the whole document, quoted original included, so the obvious sequence replaces the
reply AND the message it is replying to. What separates them:

| Block in a reply composer                       | `AXBlockQuoteLevel` |
| ----------------------------------------------- | ------------------- |
| the sender's own paragraphs                     | `0`                 |
| `On 18 Sep 2026, at 19:36, … wrote:`            | `1`                 |
| every quoted paragraph, image and link below it | `1`                 |

Exact, with no heuristic. **A forward splits the same way** — measured separately, because a forward
reads as prose and nothing about `Begin forwarded message:` looks like a quotation, yet it and
everything under it read `1`. Had they read `0`, the whole forwarded message would have counted as
the sender's own text and been offered up for replacement.

### The selection cannot be read, so it is copied

The obvious way to verify a selection before pasting over it is to read it back. None of it works:

| Attribute on the composer's `AXWebArea` | Reads                                     |
| --------------------------------------- | ----------------------------------------- |
| `AXSelectedText`                        | `null`                                    |
| `AXSelectedTextRange`                   | `null`                                    |
| `AXSelectedTextMarkerRange`             | `<__NSCFType>` — opaque, not serialisable |

So the selection is read the only way it is legible: **command-C, and off the pasteboard.** Which
carries two traps, and the second one cost a live run.

**command-C over an EMPTY selection leaves the pasteboard alone**, so a copy that never happened
reads back as whatever the last one put there. A sentinel is written before each copy, and a
pasteboard still holding it means blind, not empty.

**And the copy is not on the pasteboard when the keystroke returns.** `apple_desktop_key` answers
once the event is POSTED — the same fact that broke the body read-back, one level over. Reading
`pbpaste` on the next line raced Mail's handling of command-C and got the sentinel, so the first
live run of this sequence refused a selection that was in fact made and correct:

    "The draft's own text could not be selected in its composer: copying the
     selection back returned nothing"  ->  replaced: false

The hand probe that established the sequence had a 300 ms wait between the two steps and never saw
it. The pasteboard is now polled, like everything else here.

### The sequence, and why it is safe

    command-up                     caret to the top of the document
    shift-down   x (blocks - 1)    extend down one rendered line at a time
    shift-command-right            out to the end of that line
    command-C  -> compare          must equal the composer's own text, exactly
    command-V                      replace it
    read back  -> compare          must equal what was pasted
    command-S                      save

Measured, on a reply quoting a 322-element newsletter:

    selection copied back  ->  "ALPHA line one\nALPHA line two"   (exactly, no trailing newline)
    after the paste        ->  three BRAVO lines, then the attribution line at level 1,
                               then the entire quoted newsletter, images intact
    drafts with that subject, after  ->  1
    In-Reply-To / References         ->  unchanged

One more check sits after the paste and before the save: the quote was read at level 1 before, so
it must still be there after. Nothing should be able to fail it — the selection was copied back and
matched the sender's own text exactly, so it cannot have contained the quote — but a saved draft
cannot be undone from here and an unsaved composer can, so the sequence stops short of command-S
rather than committing damage it can still see.

**Nothing destructive happens before it is verified, and that is what makes this allowed at all.**
Selecting and copying do not alter a draft, so a selection that cannot be made to match exactly
costs a refusal rather than a body. `blocks` counts paragraphs while the selection moves by rendered
lines, so a wrapped paragraph starts the loop SHORT — the copy-back notices and keeps extending;
anything that reaches past the sender's own words stops, having changed nothing.

The window is also matched to the draft by CONTENT, not only by subject: two replies in one thread
carry the same title, and rewriting the wrong one destroys what somebody wrote. Two composers under
one title are refused outright, for the same reason `compose.ts` refuses them — handles are minted
per call, so there is nothing to tell them apart by.

### What it still cannot do

Change the **subject**. The composer's subject field is not typed into by this path, so a rewrite
that changes the subject goes the recreate way — which then refuses a reply, correctly.

### Two bugs this found on the way

**The clipboard was not UTF-8.** `pbcopy` and `pbpaste` encode in the locale's character set, and
the app spawns this server with an environment naming none, so they fell back to MacRoman:

    pasted "...the draft — which is..."   read back as   "...the draft ‚Äî which is..."

Those are the UTF-8 bytes of the em dash read as MacRoman, and it is what went into the DRAFT, not
just into the read-back. It surfaced here because the rewrite compares what it pasted with what the
composer shows and the two could not match; it had been corrupting every reply and forward carrying
an accent all along. The read direction is worse in kind: this clipboard is borrowed and put back,
so replying to a mail handed the person back a mangled copy of whatever they had copied. Both verbs
now name `LC_CTYPE=UTF-8`.

**A quote-level read can time out, and busy is not no.** On a composer quoting a long thread, one
`AXBlockQuoteLevel` read answered `did not answer in time. The app may be busy; retry.` — WebKit
still digesting the paste that had just landed. That failed the whole body read, which failed the
verification, which refused a rewrite that had gone in perfectly. The app says to retry, so it
retries; a read that never answers still counts as unknown rather than as level zero.

### A third, in the listing this leans on

`reply_to_message` read the composer back ONCE, immediately after posting command-V.
`apple_desktop_key` returns when the event is posted; WebKit has still to take it, edit the document
and republish an accessibility tree. On a reply quoting that same newsletter the read lost the race
and the tool reported:

> SOMETHING DID land in it that could not be read back

for a body that was in fact perfect — and that message tells its reader not to retry. The read-back
is now polled. Same lesson as the focus poll above it, one level further down.

And finding the draft again to rewrite it turned up a fourth, in `LIST_RECENT`: `slice(from, to)`
on an Apple Events specifier is INCLUSIVE, so asking for the whole of a small mailbox ran one past
the end, raised `Invalid index.` and returned a null subject and an unusable `#null` ref for every
row. A Drafts mailbox almost always holds fewer messages than the limit, so an agent that had just
written a reply could not address it. `jxa/read.ts` carries the readings.

## The composer moved into the app

Added 2026-10-26. Everything above was measured when the Node server drove the composer one
keystroke at a time through `apple_desktop_*` calls. That is now the app's job, in one process, and
the sections above describe the behaviour it replaced. This is what a spike on **macOS 27.0**
measured to justify the move, what shipped, and the rule for the one case that still needs a rebuild.

### What the spike measured

[`scripts/spike-mail-composer.swift`](../scripts/spike-mail-composer.swift) carries the numbers in its
header. The ones that decided the design:

| Question                                      | Measured 2026-10-25                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the own text be selected without keys?    | **Yes.** In process, `AXTextMarkerRangeForUIElement` on each own block gives a range, `AXSelectedTextMarkerRange` is settable **with Mail in the background**, and `AXStringForTextMarkerRange` reads it back exactly. No copy, no per-line walk. |
| Can a span inside a block be selected?        | **Yes, for the case measured**: `AXTextMarkerForIndex` offsets are index-compatible with the own range's start, and `"ALPHA two"` read back as exactly itself. Mid-block spans and non-BMP text were not measured.                                |
| Does the paste need Mail active?              | **Yes.** command-V posted to Mail's pid in the background was ignored. With Mail active and the event on the HID tap it landed in about 70 ms, over exactly the selection, quote intact.                                                          |
| Does HTML survive a paste?                    | **Yes.** `<b>` and `<a href>` survive; Mail rewrites spaces to `&nbsp;`, adds a `font-size: medium` wrapper and the quote is not touched.                                                                                                         |
| Can the subject be retyped?                   | **No.** The subject field accepts an `AXValue` write and displays it, but the title and the saved draft keep the old subject.                                                                                                                     |
| Is a saved draft's Message-ID an address?     | **No.** It changes on every save, as does the row id. `In-Reply-To` and `References` survive, which is what a rebuild uses.                                                                                                                       |
| Can a closed draft be reopened as a composer? | **No.** `message://<Message-ID>` on a saved draft opens the read-only viewer, the same dead end as `M.open`.                                                                                                                                      |

`X-Universally-Unique-Identifier` held across two saves of one composer but is the same value on two
different composers replying to one message, so it is not used as an address either.

### The two verbs

Both are answered only on the channel the app lends to the Mail server (the peer check in
`ServerHost` refuses anything it did not spawn), so a terminal cannot borrow them.

- **`apple_desktop_mail_composers`** reads every compose window: a `composer` handle (`mc-<n>`),
  subject, From, To, Cc, Bcc, the own text apart from the quote (split by `AXBlockQuoteLevel`, as
  before), the opening of the quote (`quoteChars`) and the named files. Handles are minted per call.
  This is what `apple_mail_list_open_drafts` returns, so two windows under one subject can finally be
  told apart and addressed.
- **`apple_desktop_mail_composer_edit`** changes one window: a whole `body`, find/replace `edits`,
  files, or HTML (a rebuilt draft keeps its formatting).

### The edit sequence and its guards

    select the own text (or each `find`) with text markers, Mail still in the background
    read the selection back                  must equal what was asked for, exactly
    save the pasteboard (every item, every type) and the front app
    activate Mail, once
    command-V                                the replacement, as text or text plus HTML
    read back the own text and the quote     must be what was pasted, quote still level 1
    command-S                                the save
    restore the pasteboard and the front app

What it refuses, changing nothing: a `find` that matches zero or several places (compared ignoring
whitespace, against the own text only, never the quote), a window whose own text cannot be told
apart from its quote, and a selection that does not read back as asked. Nothing destructive happens
until the selection is verified, as before; what changed is that verifying it costs a read instead
of a copy and a poll, so the clipboard is borrowed once, for the paste, and Mail is brought forward
once instead of for the whole walk.

Two windows under one subject are no longer refused. `update_draft` takes a `composer` handle, or
`ref` (matched to its window by content), or neither: with exactly one compose window open it edits
that one, and with none or several it refuses and lists them.

### Route B: a closed draft is rebuilt as a reply

A draft whose window is closed has no composer and cannot get one back (see the table). So it is
rebuilt, in `rebuild.ts`:

1. Preflight, before any window opens: Accessibility, no window already open under the subject, not
   a forward (what was forwarded is not known from here), the original found in the index by the
   draft's `In-Reply-To`, every `find` matching exactly once, none crossing formatting, every file
   stored locally. A refusal here opens nothing.
2. The original is reopened as a reply, so Mail writes the threading headers and the quote itself.
3. The draft's own HTML (everything before Mail's `AppleOriginalContents` div) and its files are
   pasted by the app's verb, read back and saved.
4. **The regenerated quote must match the old one and the recipients must be the ones asked for,** or
   the window is left open, unsaved, for the person to close.
5. **Confirm, then delete.** The new draft is found in Drafts by what it holds: its `Date`, its
   `In-Reply-To` and the head of its text, and there must be **exactly one** candidate. Only then is
   the original deleted. Message-ID and row id are never used, because both change on every save.
   If Drafts cannot confirm, the original is kept and the reply says there are two.

The new draft gets a new ref. `method: "rebuild"` in the result says this route ran;
`threadingKept` and `inReplyTo` say what carried over.

### Checked live

`node scripts/verify-mail-ax.mjs --compose` adds the cases for all of this, each against drafts to the
user's own address. Its results are recorded below once run; until then they are unmeasured.

## Still open

- **Where an attachment lands in a native-lane reply, and whether the read-back still passes.** **STILL OPEN 2026-10-26.**
  `OPEN_COMPOSER` attaches after the last paragraph and before the body is pasted, so on a reply
  the file may sit under the quoted original rather than under the new text. Unmeasured, as is
  whether the attachment character disturbs `paste`'s read-back. The 26.6 probe above sent through
  the scripting object, not through this lane. One reply draft to your own address settles both.
- ~~**Whether an open composer can be re-found and rewritten.**~~ **ANSWERED 2026-09-06, for the
  half that matters.** An open composer's body can be rewritten — by select-all and paste through
  the Accessibility lane, not by assigning `content` — and the save lands on the same draft. See
  [Editing in place](#editing-in-place-works-and-is-now-the-first-choice). Assigning `content`
  to a composer retrieved from `M.outgoingMessages` is still unmeasured and now uninteresting: the
  paste path is proven, and the open question was never the rewrite.
- ~~**A route from a saved draft to a composer.**~~ **DISSOLVED 2026-09-18 for the case that
  matters, and STILL OPEN for the other one.** A draft whose composer is still open needs no route,
  and that is every draft this server has just written — see
  [Editing the composer that is already open](#editing-the-composer-that-is-already-open). A draft
  whose window has been CLOSED still has none: `M.open` gives a viewer, and driving the message list
  means moving the user's window. That case falls back to recreation and keeps its refusals.
  **ANSWERED 2026-10-26 for a reply:** there is still no route to the window, so a closed reply is
  rebuilt as a reply to its original, threading and files kept (see
  [Route B](#route-b-a-closed-draft-is-rebuilt-as-a-reply)). A forward cannot be, because what it
  forwarded is not known from here, and still refuses.
- **Whether the selection survives a body with inline images or attachments.** **PARTLY ANSWERED 2026-10-26:** the native edit selects by text marker on the own blocks and reads the range back, so a copy no longer has to match the tree. Not measured on a body holding an inline image or a file, and `verify-mail-ax --compose` edits a forward that holds two files, which is the first place it will show. Measured on text
  above a quote. A composer whose own text holds an attachment character or an inline image has
  blocks the copy-back may render differently from the accessibility tree, which would show up as a
  refusal rather than damage — but it has not been seen either way. It matters more now: a draft
  `update_draft` has added files to is exactly that, so a SECOND call on it (another body change,
  or more files) depends on the answer. `sameDraft` already ignores U+FFFC on both sides, in case
  Mail's plain text renders a file that way; that is a guess, unmeasured for a stored draft.
- **The native new-message path, live.** **STILL OPEN 2026-10-26 until the live run is recorded.** Every piece of it is measured — a message opened without
  `content`, a body pasted into it, files pasted after a body — but the shipped sequence has run only
  against stubs. `verify-mail-ax --compose` runs it, and reads the source.
- **Two files in one paste, and a paste above a quote.** **STILL OPEN 2026-10-26 until the live run is recorded.** The probe pasted one file at a time into a
  new message. `node scripts/verify-mail-ax.mjs --compose` now adds two (an image and a text file)
  to the forward it rewrites, which covers both.
- **Re-selecting is bounded at 200 extra lines.** **ANSWERED 2026-10-26, by removal:** the native edit selects by text marker and no longer walks lines, so there is no bound. One press per wrapped line, so a draft of a few
  hundred wrapped lines would reach the bound and refuse. Not seen; cheap to raise.
- **Bcc on a saved draft.** **STILL OPEN 2026-10-26.** `list_open_drafts` now reads the Bcc field of an open window (null when it is not shown), but a rebuilt draft takes its recipients from the saved message. Read from `bccRecipients` and preserved, but a draft stored on an IMAP
  server may not carry Bcc at all. Not measured, and it would be silently dropped if so.
- **How long the renumbering window lasts.** **STILL OPEN 2026-10-26.** The rebuild sidesteps it by never using an id to find its own result. One observation, on iCloud, of a single rewrite.
  Whether a draft settles after one sync or keeps moving is unknown, and it decides whether
  `newId` is worth returning at all.
- **The discovery scan is capped at 200 messages of All Drafts.** **STILL OPEN 2026-10-26.** An account whose drafts all sit
  past that point in the ordering would fall through to the refusal. Not seen, and cheap to raise
  if it ever is.
- **Whether the rebuild's confirmation rule holds across providers.** New 2026-10-26. A draft is
  found again by `Date`, `In-Reply-To` and the head of its text, with exactly one candidate. That is
  unmeasured on an account that rewrites `Date` on sync, where it would refuse and keep both drafts.
- **A mid-block selection with text after it, a span across two blocks, and non-BMP text.** New
  2026-10-26. The spike measured one ASCII span at the end of a block. An edit that is not that
  shape is read back before the paste, so a miss refuses, but the cases are not seen.
- **Pasting into the subject field.** New 2026-10-26. An `AXValue` write is ignored, so a subject
  change still rebuilds the draft. Whether a paste into the field would hold is untested.
