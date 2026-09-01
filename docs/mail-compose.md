# Composing, and why a draft cannot be edited

Regenerate the dictionary evidence with `sdef /System/Applications/Mail.app` on each new macOS
release. Read on macOS 26.6, and checked against a live Mail with four accounts — see
[Measured against a live Mail](#measured-against-a-live-mail), where two of the three findings
contradict the dictionary. One claim in an earlier version of this file was itself wrong --
see [Attachments can be added](#attachments-can-be-added-and-the-dictionary-always-said-so).

**Implemented** — `apple_mail_update_draft` rewrites a standalone draft by recreating it, and
refuses the cases recreation cannot carry across. See `packages/mail/src/client/jxa/write.ts`.

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

So there is no edit path. There is only recreation.

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

## What recreation cannot carry across

Two things, and both are invisible in the result, which is why both are refused rather than
dropped:

| Lost            | Why                                                                                                                                                                        | What `update_draft` does                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Threading**   | `In-Reply-To` and `References` are written by Mail's own `reply` command, which needs the original message. A recreated reply draft looks perfect and starts a new thread. | Reads `all headers`; refuses if either header is present, pointing at `reply_to_message` instead. |
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

| Probe | Result |
| ----- | ------ |
| AppleScript `make new attachment ... at after the last paragraph` | Works. `count of attachments of content` = 1. |
| JXA `m.content.attachments.push(M.Attachment({fileName: Path(f)}))` | **Works.** No throw, count = 1. This is the form to ship. |
| JXA `M.make({new:"attachment", ..., at: m.content.paragraphs.at(-1).after})` | Works. Equivalent, more verbose. |
| JXA `... at: m.content.attachments.end` or `paragraphs.end` | Throws `Invalid key form.` |
| Survives `send()` | **Yes.** Received mail carries `image/png` and `application/pdf` parts, base64, with `filename=`. |
| On the `reply` composer | **Yes**, and `In-Reply-To`/`References` survive with it. |

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

## Still open

- **Whether an open composer can be re-found and rewritten.** `M.outgoingMessages` is an element of
  the application and `SEND_MESSAGE` pushes onto it, so enumerating live composers looks possible.
  Whether assigning `content` to one retrieved that way lands — as opposed to being swallowed the
  way a reply composer's is — is unmeasured. If it works it is a cheaper path than recreation for
  the composer case, and it would not help the saved-draft case at all.
- **Bcc on a saved draft.** Read from `bccRecipients` and preserved, but a draft stored on an IMAP
  server may not carry Bcc at all. Not measured, and it would be silently dropped if so.
- **How long the renumbering window lasts.** One observation, on iCloud, of a single rewrite.
  Whether a draft settles after one sync or keeps moving is unknown, and it decides whether
  `newId` is worth returning at all.
- **The discovery scan is capped at 200 messages of All Drafts.** An account whose drafts all sit
  past that point in the ordering would fall through to the refusal. Not seen, and cheap to raise
  if it ever is.
