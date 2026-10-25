# Native Mail composer: design

Date: 2026-10-25. Status: direction approved by Olivier, and his two calls from the builder
check are in (rebuild text, files on a full-body edit). This document awaits his read.

## Why

A customer bought Cupertino on 2026-10-24 and asked for the 30-day refund the next day: _"des
difficultés persistantes pour créer et modifier des brouillons dans Apple Mail"_. The refund went
out, and the reply promised to prioritise drafts. Olivier's own verdict: _"draft editing is indeed
a pain"_, and on the how: _"don't want to be tied to the nodejs runtime if it leads to subpar UX"_,
with native Swift explicitly on the table.

The cause of that customer's failure is unknown. They were not asked. This design fixes what the
code and [docs/mail-compose.md](../../mail-compose.md) show to be painful, not one reported bug.

## What hurts today

1. **A closed composer is a dead end.** `apple_mail_update_draft` edits in place only while the
   draft's compose window is open ([revise.ts](../../../packages/mail/src/client/revise.ts)).
   Otherwise it recreates the draft, which refuses a reply, a forward and anything with an
   attachment. That covers every draft written in an earlier session, by hand, on another device,
   or before Mail restarted, and most drafts are replies.
2. **The in-place edit is slow and brittle.** Node drives it as dozens of round trips over the AX
   channel. It walks the caret down a line at a time, copies after each step to see what is
   selected (via `pbcopy`/`pbpaste` and a sentinel), and polls render read-backs up to 12 s. Any
   moment the person touches the Mac becomes a "would not take the keyboard" refusal.
3. **Refs expire within seconds.** Sync renumbers the saved draft, so an agent re-finds it by
   subject.
4. **Two composers with one subject are refused outright.** Two replies in one thread do that.
5. **Body edits are whole-body replacements.** The agent must resend everything, which overwrites
   anything the person typed by hand since it last read the draft.
6. **The subject cannot be changed in place**, and changing it forces recreation, which refuses a
   reply.
7. **Without the Accessibility grant** a reply draft cannot be edited at all, and new messages fail
   with an error that does not lead anywhere.

## What the spike measured

[`scripts/spike-mail-composer.swift`](../../../scripts/spike-mail-composer.swift), run 2026-10-25
on macOS 27.0 against a reply composer addressed to Olivier himself. Its header carries the raw
readings. What they decide:

| Question                                                  | Answer                                                                                                                                                                                                                                                                                                           | Consequence                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Can the sender's own text be selected exactly, natively?  | **Yes.** `AXTextMarkerRangeForUIElement` per own block, joined with the public `AXTextMarkerRangeCopyStartMarker`/`CopyEndMarker`/`AXTextMarkerRangeCreate`. `AXStringForTextMarkerRange` reads it, and `AXSelectedTextMarkerRange` is settable, honoured with Mail in the background, and reads back identical. | The keyboard walk and the copy-to-verify loop go. Selection is verified by reading it.                               |
| Does a paste land?                                        | **Only with Mail active.** Posted to Mail's pid in the background it was ignored. Activated, on the HID tap: 65 ms and 67 ms, exactly over the selection, quote intact.                                                                                                                                          | One short activation per edit stays. Everything before it (finding, verifying, selecting) happens in the background. |
| Does the subject field take an AXValue write?             | **No.** Accepted and displayed, but the title did not change and the saved draft kept the old subject.                                                                                                                                                                                                           | Subject changes need another route (see below).                                                                      |
| Is a draft's Message-ID stable across saves?              | **No.** It changed on each save, and so did the row id.                                                                                                                                                                                                                                                          | Neither can address a draft.                                                                                         |
| Does `message://<Message-ID>` reopen a draft for editing? | **No.** It opens the read-only viewer, like `M.open`.                                                                                                                                                                                                                                                            | Closed drafts are rebuilt, not reopened.                                                                             |
| Does a saved reply draft know what it replies to?         | **Yes.** `In-Reply-To` and `References` carry the original's Message-ID.                                                                                                                                                                                                                                         | A rebuild can call Mail's own `reply` on the original and keep threading.                                            |

## Goals

- Editing a draft the agent just wrote takes one call, keeps the person's interruption to a short
  activation, and never refuses because a window shares a subject.
- A reply draft can be edited after its window was closed, with its threading intact.
- An agent can change a line without resending the body, and without overwriting what the person
  typed by hand.
- A missing Accessibility grant is named once, clearly, with the place to fix it.

## Non-goals

- Porting the rest of the Mail server (search, read, index, emlx) to Swift. It works, and the
  npm packages run standalone.
- Recipient edits in place on an open composer. They stay with the rebuild route below until a
  token-field write is measured.
- Reopening a saved draft in a composer. Measured dead twice (`M.open`, `message://`), and the
  remaining route moves the person's message list.

## Anti-goals: failures even if it "works"

- Reporting a draft edited, saved or rebuilt when that was not read back from Mail.
- Touching the quoted original, or a composer that is not the draft being edited.
- Sending anything. Every path ends at a saved draft unless the existing `sendNow` gates say
  otherwise.
- Leaving the clipboard changed, or Mail frontmost when the person was elsewhere.
- Moving the person's viewer or message list.

## Design

### A. Native composer verbs, in the app

A Swift module in the app (working name `MailComposer.swift`) serves a few coarse verbs to the
Mail server over the existing internal AX channel: the lent Desktop connection in
[ServerHost.swift](../../../apps/apple/Cupertino/ServerHost.swift) `serveInProcess(lentTo:)`,
scoped to `com.apple.mail`. They are **not** registered on the public Desktop surface. The
existing `DrivingSession` admission (the warning when someone is using the Mac) applies
unchanged.

- **List composers.** Every compose window: subject, recipient names, own text, quote present,
  files in own text, and a **composer handle**. The app keeps a registry from handle to
  `AXUIElement`, so the handle is valid for as long as the window exists and survives saves and
  renumbering. It is never valid for a different window, and a dead one is reported as such. This
  replaces subject matching. Two composers with one subject are just two handles.
- **Edit a composer**, atomically, in one call:
  1. Resolve the handle. Read the own blocks (quote level 0) and the quote.
  2. If the caller sent `edits`, apply them to the own text as read now (see C). Otherwise take
     `body`.
  3. Build the marker range over the own blocks. Read it back and require it to equal the own
     text, then set it as the selection. All of this happens in the background. An empty own text
     is a collapsed range at the start.
  4. Activate Mail, write the new text to the pasteboard, post command-V on the HID tap, and poll
     until the own text reads back as expected and the quote is still present.
  5. Paste any files after the text and above the quote, verified the way
     `compose.ts` `pasteFiles` verifies them today.
  6. Save with command-S, then give the front back to the app that had it.
  7. Restore every pasteboard item and type, not only text.

  **Olivier's call: a full `body` over own text that holds files or inline images is refused**,
  naming them. Nothing changes, and the agent can use `edits`, which leave them alone. Files are
  counted from the window, not from the saved copy. That also fixes today's `attachmentsKept`,
  which reports a count it never read back.

  Any failed check stops before the save, as revise.ts does today. The verbs return the same
  refusal shape (`replaced`, `capability`, `reason`, `hint`) so Node passes them through.

- **Compose.** New messages, replies and forwards keep using Apple Events to open the composer
  (that is how threading and recipients arrive), then fill it with the edit verb above in place of
  today's paste-and-read-back sequence.

Node keeps the tool schemas, the send gates and the System Events fallback for a server run
without Cupertino. [revise.ts](../../../packages/mail/src/client/revise.ts) and the composer half
of [ax.ts](../../../packages/mail/src/client/ax.ts) shrink to calls to these verbs.

### B. A closed reply draft is rebuilt faithfully

When a saved draft has no open composer, and it is a reply (has `In-Reply-To`):

1. Find the original by that Message-ID. Refuse if it is not in the mailbox.
2. Call Mail's `reply` on it, opening a window, with the recipient set restored to exactly the
   old draft's To/Cc/Bcc through the outgoing message's recipients, and its subject. Apple Events
   write subject and recipients on an outgoing message correctly; only the body is the problem.
3. Fill the body with the native edit verb. The text comes from the old draft's saved HTML: the
   part before Mail's `<div class="AppleOriginalContents">` (seen in the spike's saved source),
   pasted as HTML so bold, links and the signature survive. `edits` are applied to it first, and a
   full `body` replaces it. **Olivier's call: if HTML paste cannot be made to work, a draft with
   formatting is refused** with a reason, and only plain-text drafts rebuild. Nothing is silently
   flattened. Extract the old draft's attachments from its emlx
   (`mime.ts`) to a private temp directory and paste them back in. Remove the directory after the
   save.
4. **Compare the regenerated quote with the old draft's quote.** If they differ (the person edited
   inside the quoted original), refuse. A rebuild must not silently undo that.
5. Confirm the new draft in Drafts (by `In-Reply-To` and content), then delete the old one. If it
   cannot be confirmed, keep both and say so. The order is the safety property that
   `UPDATE_DRAFT` already has.

A subject change on any draft goes this way too, since the field ignores writes. On an open
composer that means saving, closing it through its close button (measured: no sheet once saved)
and rebuilding.

A closed **forward** draft is out of scope until it is measured whether Mail writes a link to the
forwarded message. Until then it keeps today's refusal.

**One rebuild path for every closed draft (agent's call).** A non-reply draft goes through the
same steps with `make new outgoing message` in place of `reply`. Attachments are extracted from the
emlx either way, so today's attachment refusal and the separate `STAGE_REPLACEMENT` /
`COMMIT_REPLACEMENT` path both go.

**When a saved draft counts as closed (agent's call).** Nothing stable links a window to a saved
draft (Message-ID and row change on every save), so route B is refused whenever any open composer
shows the same subject. A rebuild that deletes a draft whose window is still open would let that
window save a second live copy later. The refusal names the window to close.

### C. Tool surface

- `apple_mail_update_draft` takes `edits: [{ find, replace }]` as an alternative to `body`
  (agent's calls below):
  - **Each edit replaces only its match**, not the whole own text, so formatting, links, the
    signature and files elsewhere in the person's text survive. The match is located in the text
    the window shows (`AXStringForTextMarkerRange`) and turned into a sub-block marker range with
    `AXTextMarkerForIndex`, which Mail offers. That conversion is unmeasured and is the **first
    thing the builder measures**. If it does not hold, `edits` ships as a whole-own-text repaste
    and is refused on own text holding formatting or files.
  - **Matching ignores whitespace differences** (runs of spaces and line breaks compare equal),
    because an agent reading the draft through `get_message` sees different line breaks from the
    window. Each `find` must match exactly once, or the call refuses and changes nothing.
- It takes a `composer` handle from `apple_mail_list_open_drafts`, and with neither handle nor
  ref it targets the single open composer (refusing when there are several). `ref` still works
  for saved drafts and is how route B is reached.
- A missing Accessibility grant gets one error naming the System Settings pane, and the app shows
  it as a card through [Permissions.swift](../../../apps/apple/Cupertino/Permissions.swift).
- Tool descriptions lose the paragraphs that only exist to explain today's refusals.

## Verification

- `scripts/verify-mail-ax.mjs --compose` grows cases for: an edit with `edits`, two composers with
  one subject, a closed reply draft rebuilt with threading checked in the saved source, and a
  rebuild refused because the quote was edited.
- The spike stays in `scripts/` as the record and the first thing to rerun on a new macOS.
- The pure parts (applying `edits`, choosing the target, the quote comparison) get unit checks.

## Still to measure (builder)

- **First:** a sub-block selection from `AXTextMarkerForIndex`, which decides how `edits` work (C).
- Whether HTML pasted from a saved draft lands with its formatting and without Mail's quote
  wrapper, which decides route B for formatted drafts.
- Whether `X-Universally-Unique-Identifier` stays the same across saves. If it does, it addresses a
  saved draft stably and `ref` can be resolved through it.
- What a saved forward draft carries that links it to the forwarded message.
- Marker selection when the own text holds an inline image or attachment.
- Whether a selection set in the background survives activation on every run, or needs setting
  again after it. It survived in the spike.

## Left to the builder

Verb names and JSON shapes, file split on the Swift side, poll timings and timeouts, and how the
handle registry evicts closed windows.
