import { interferenceNote } from "@mgcrea/mcp-apple-core";

import { squash, type ComposerBody, type ComposerRef, type MailAxLane } from "./ax.js";
import { borrowClipboard, systemClipboard, type Clipboard } from "./compose.js";

/**
 * Rewrite a draft by editing its open composer, instead of recreating it.
 *
 * ## Why this exists
 *
 * `UPDATE_DRAFT` replaces a draft by composing a new one and deleting the old,
 * because Mail's scripting interface offers no way to edit a saved draft —
 * `docs/mail-compose.md` carries the dictionary evidence. Recreation cannot
 * carry threading or attachments across, so it REFUSES a reply draft rather
 * than silently starting a new thread.
 *
 * Which refuses the most common request there is. "Draft a reply, now change
 * this line" ended at a tool that would not do it and a person deleting the
 * draft by hand.
 *
 * Nothing about that limit was ever about editing. It is about RECREATION: a
 * composer's body can be rewritten in place, the save lands on the same draft,
 * and threading, attachments and the quoted original are all still there
 * afterwards because nothing was ever remade. What was missing was a way in —
 * and in the case that matters there already is one, because the composer the
 * reply was written in is still on screen. Nothing here ever closes one.
 *
 * ## The safety property
 *
 * `UPDATE_DRAFT`'s is an order: confirm the replacement before deleting the
 * original. This path deletes nothing, so its hazard is a different one —
 * replacing text that is not the text we meant to replace — and its guard is
 * that **every step that could destroy something is verified before it is
 * taken**, never after:
 *
 *   * The window is matched to the draft by CONTENT, not only by subject. Two
 *     replies in one thread carry the same title.
 *   * The selection is read back by copying it, and must equal the composer's
 *     own text exactly. Selecting and copying change nothing, so a selection
 *     that cannot be made to match is abandoned with the draft untouched.
 *   * The quoted original is located by `AXBlockQuoteLevel` and never selected.
 *     A body whose quote boundary cannot be established is refused.
 *   * The paste is read back before the save, and a body that does not match is
 *     NOT saved — leaving the draft as it was and the window open to look at.
 *
 * MEASURED, macOS 27.0 (build 26A428), on a reply composer quoting a newsletter
 * of 322 elements: the selection copied back as exactly the two lines above the
 * quote, the paste replaced them with three, the attribution line and the whole
 * quoted body survived, and command-S left ONE draft whose `In-Reply-To` and
 * `References` were unchanged.
 */

/**
 * How much of the draft's stored text has to match the window's.
 *
 * The question is only ever "is this window this draft", and the opening of a
 * body answers it — two drafts that agree for 120 characters and diverge later
 * are not something a subject match plus this can tell apart, but they are also
 * not what goes wrong. What goes wrong is a leftover composer from another
 * thread, and it disagrees immediately.
 */
const IDENTITY_CHARS = 120;

/**
 * How far the selection may be walked past the block count.
 *
 * `blocks` counts paragraphs and the selection moves by rendered lines, so a
 * body that wraps needs extra presses — one per wrapped line. The bound is
 * generous because overshooting is not the risk (the copy-back catches it); the
 * risk is looping on a composer that stopped responding.
 */
const MAX_EXTRA_LINES = 200;

/** How long to wait for a pasted body to reach the accessibility tree. */
const RENDER_TIMEOUT_MS = 4_000;
const RENDER_POLL_MS = 150;

/**
 * How long to wait for a copy to reach the pasteboard.
 *
 * **MEASURED, and it cost a live run.** `apple_desktop_key` answers when the
 * keystroke is POSTED. Reading the pasteboard on the next line raced Mail's
 * handling of command-C and read back the sentinel, so a selection that was in
 * fact made and correct came back as "the selection could not be read" and the
 * rewrite refused. The hand probe that established this whole sequence had a
 * 300 ms wait between the two and never saw it.
 *
 * The same shape as the focus poll and the render poll: readable is not ready,
 * so it is polled rather than waited for, and a copy that arrives immediately
 * costs one read.
 */
const COPY_TIMEOUT_MS = 1_500;
const COPY_POLL_MS = 50;

/** What the Apple Events half has to say about the draft before this can start. */
export type DraftFacts = {
  subject: string;
  isReply: boolean;
  attachments: number;
  recipientCount: number;
  /** The opening of what the draft actually holds, for matching a window to it. */
  contentHead: string;
  draftsMailbox: string;
};

export type ReviseOptions = {
  body: string;
  clipboard?: Clipboard | undefined;
  focusTimeoutMs?: number | undefined;
  renderTimeoutMs?: number | undefined;
};

/** A refusal, shaped like `UPDATE_DRAFT`'s so a caller reads one thing. */
const refuse = (
  capability: string,
  facts: DraftFacts,
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  replaced: false,
  degraded: true,
  method: "inPlace",
  capability,
  draft: {
    subject: facts.subject,
    isReply: facts.isReply,
    attachments: facts.attachments,
    recipientCount: facts.recipientCount,
  },
  reason,
  hint,
  ...extra,
});

/**
 * Is this window showing this draft?
 *
 * Compared on the opening of both, squashed, because the two readings come from
 * different places — one is Mail's plain-text rendering of the stored message,
 * the other is what an accessibility client sees a WebKit view display — and
 * they agree on the words while disagreeing about every line break.
 */
const sameDraft = (stored: string, shown: string): boolean => {
  const a = squash(stored);
  const b = squash(shown);
  // Both empty is a match: a reply whose body was never written has nothing to
  // compare, and pasting into it destroys nothing either way.
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const chars = Math.min(a.length, b.length, IDENTITY_CHARS);
  return a.slice(0, chars) === b.slice(0, chars);
};

/**
 * Select exactly the composer's own text, and prove it.
 *
 * The caret goes to the top of the document, the selection is extended down one
 * rendered line at a time and out to each line's end, and after every extension
 * it is COPIED and compared. Only an exact match ends the loop.
 *
 * Copying is how the selection is read at all: `AXSelectedText` and
 * `AXSelectedTextRange` both read null on Mail's composer web area, and
 * `AXSelectedTextMarkerRange` comes back as an opaque `<__NSCFType>` — measured
 * on macOS 27.0. The pasteboard is the only place the selection is legible.
 *
 * A sentinel goes on the clipboard before each copy, because **command-C over
 * an empty selection leaves the pasteboard alone**: without it, a copy that
 * never happened reads back as whatever the previous one put there, and the
 * comparison would be against our own stale answer.
 */
const selectOwnText = async (
  lane: MailAxLane,
  clipboard: Clipboard,
  ref: ComposerRef,
  shown: ComposerBody,
  focusTimeoutMs: number | undefined,
): Promise<"selected" | "unfocused" | "blind" | "overshot"> => {
  const strokes = [{ key: "up", modifiers: ["command"] }];
  for (let line = 1; line < shown.blocks; line += 1)
    strokes.push({ key: "down", modifiers: ["shift"] });
  strokes.push({ key: "right", modifiers: ["shift", "command"] });
  if (!(await lane.keys(ref, strokes, focusTimeoutMs))) return "unfocused";

  const wanted = squash(shown.text);
  for (let extra = 0; extra <= MAX_EXTRA_LINES; extra += 1) {
    const sentinel = `cupertino-selection-${Date.now()}-${extra}`;
    await clipboard.write(sentinel);
    if (!(await lane.keys(ref, [{ key: "c", modifiers: ["command"] }], focusTimeoutMs)))
      return "unfocused";
    const copied = await awaitCopy(clipboard, sentinel);
    if (copied === null) return "blind";

    const got = squash(copied);
    if (got === wanted) return "selected";
    // Short of it: the tail of a wrapped paragraph is still unselected. Anything
    // else has reached past the sender's own words, which is where the quoted
    // original starts, so it stops here with nothing changed.
    if (!wanted.startsWith(got)) return "overshot";
    if (
      !(await lane.keys(
        ref,
        [
          { key: "down", modifiers: ["shift"] },
          { key: "right", modifiers: ["shift", "command"] },
        ],
        focusTimeoutMs,
      ))
    )
      return "unfocused";
  }
  return "overshot";
};

/**
 * Wait for the pasteboard to hold something other than the sentinel.
 *
 * Null means the copy never arrived — which is what an EMPTY selection looks
 * like, since command-C over one leaves the pasteboard alone, and is the answer
 * that stops the rewrite. Anything else is the selection, whatever it says.
 */
const awaitCopy = async (clipboard: Clipboard, sentinel: string): Promise<string | null> => {
  const deadline = Date.now() + COPY_TIMEOUT_MS;
  for (;;) {
    const copied = await clipboard.read();
    if (copied !== null && copied !== sentinel) return copied;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, COPY_POLL_MS));
  }
};

/** Wait for the composer's own text to read back as what was just pasted. */
const awaitOwnText = async (
  lane: MailAxLane,
  ref: ComposerRef,
  expected: string,
  timeoutMs: number,
): Promise<ComposerBody | null> => {
  const wanted = squash(expected);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await lane.composerBody(ref.body);
    if (shown && squash(shown.text) === wanted) return shown;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS));
  }
};

/**
 * Replace a draft's body in its open composer.
 *
 * Null — and only null — means there is no composer to edit, which is the
 * caller's signal to fall back to recreating the draft. Every other outcome,
 * including every refusal, is a result the caller returns as it stands.
 */
export const reviseDraftInPlace = async (
  lane: MailAxLane,
  facts: DraftFacts,
  opts: ReviseOptions,
): Promise<Record<string, unknown> | null> => {
  const clipboard = opts.clipboard ?? systemClipboard;
  const renderTimeoutMs = opts.renderTimeoutMs ?? RENDER_TIMEOUT_MS;
  const watch = lane.watch();

  const reach = await lane.reach();
  // Not a refusal: without the accessibility lane this path does not exist, and
  // recreation may still be able to do the job.
  if (!reach.ok) return null;

  const composers = await lane.findComposers(facts.subject);
  if (composers.length === 0) return null;
  if (composers.length > 1) {
    return refuse(
      "composer",
      facts,
      `${composers.length} composer windows in Mail are titled "${facts.subject}", and nothing ` +
        `here can tell which of them holds this draft — window handles are minted per call. ` +
        `Replacing the body of the wrong one would destroy what is in it, so nothing was touched.`,
      "Close or finish all but one of those windows in Mail, then try again.",
    );
  }

  const ref = composers[0] as ComposerRef;
  const shown = await lane.composerBody(ref.body);
  if (!shown) {
    return refuse(
      "composer",
      facts,
      `The composer for "${facts.subject}" is open but where its quoted original begins could ` +
        `not be established, so there is no way to tell the draft's own text from the message it ` +
        `quotes. Nothing was changed.`,
      "Edit the body in Mail directly.",
    );
  }

  if (!sameDraft(facts.contentHead, shown.text)) {
    return refuse(
      "identity",
      facts,
      `A composer titled "${facts.subject}" is open, but what it holds is not what this draft ` +
        `holds — most likely a different message under the same subject, such as another reply ` +
        `in the thread. Rewriting it would destroy text belonging to something else, so nothing ` +
        `was touched.`,
      "Check which windows are open in Mail, or edit the draft there directly.",
      { composerText: shown.text.slice(0, 200), draftText: facts.contentHead.slice(0, 200) },
    );
  }

  const outcome = await borrowClipboard(clipboard, async () => {
    // Nothing to replace: the reply was addressed and left empty. Put the caret
    // at the top and paste, which adds text rather than replacing any.
    const selection =
      shown.blocks === 0
        ? await lane
            .keys(ref, [{ key: "up", modifiers: ["command"] }], opts.focusTimeoutMs)
            .then((ok) => (ok ? ("selected" as const) : ("unfocused" as const)))
        : await selectOwnText(lane, clipboard, ref, shown, opts.focusTimeoutMs);

    if (selection !== "selected") return { selection, shown: null };

    await clipboard.write(opts.body);
    if (!(await lane.keys(ref, [{ key: "v", modifiers: ["command"] }], opts.focusTimeoutMs)))
      return { selection: "unfocused" as const, shown: null };
    return { selection, shown: await awaitOwnText(lane, ref, opts.body, renderTimeoutMs) };
  });

  if (outcome.selection === "unfocused") {
    return refuse(
      "composer",
      facts,
      `The composer for "${facts.subject}" would not take the keyboard, so nothing was typed ` +
        `into it and the draft is unchanged. Someone is probably using the Mac: a keystroke is ` +
        `refused rather than posted into whichever window they moved to.` +
        interferenceNote(await watch.check()),
      "Try again once the Mac is free, or edit the draft in Mail.",
    );
  }
  if (outcome.selection === "blind") {
    return refuse(
      "selection",
      facts,
      `The draft's own text could not be selected in its composer: copying the selection back ` +
        `returned nothing, so there is no way to know what a paste would replace. Nothing was ` +
        `changed — selecting and copying do not alter a draft.`,
      "Edit the body in Mail directly.",
    );
  }
  if (outcome.selection === "overshot") {
    return refuse(
      "selection",
      facts,
      `The draft's own text could not be selected exactly: the selection read back does not ` +
        `match what the composer shows above its quoted original, so a paste could not be ` +
        `guaranteed to leave the quote alone. Nothing was changed — selecting and copying do ` +
        `not alter a draft.`,
      "Edit the body in Mail directly, or delete this draft and write it again.",
    );
  }

  if (!outcome.shown) {
    return refuse(
      "confirmation",
      facts,
      `The new body was pasted into the composer for "${facts.subject}" but did not read back ` +
        `as what was sent within ${renderTimeoutMs / 1000}s, so IT WAS NOT SAVED. The draft ` +
        `still holds its old text; the composer window on screen holds something this could not ` +
        `verify.` +
        interferenceNote(await watch.check()),
      "Look at the composer in Mail and either fix it there or close it without saving.",
    );
  }

  /*
   * The quote was there before and is not there now.
   *
   * Nothing should be able to reach this: the selection was copied back and
   * matched the sender's own text exactly, so it cannot have contained the
   * quote. Which is the reason to check anyway — this is the one damage this
   * whole path exists to prevent, the check costs a field that has already been
   * read, and an unsaved composer is recoverable where a saved draft is not.
   */
  if (shown.quoted && !outcome.shown.quoted) {
    return refuse(
      "confirmation",
      facts,
      `The new body went into the composer for "${facts.subject}", but the quoted original that ` +
        `was below it is GONE from the window — so the replacement reached further than the ` +
        `draft's own text. IT WAS NOT SAVED: the draft on disk still holds its old text, quote ` +
        `and all.`,
      "Close the composer in Mail WITHOUT saving, or undo inside it with command-Z. The draft " +
        "itself is untouched.",
    );
  }

  const saved = await lane.finish(false, ref);
  const disturbed = interferenceNote(await watch.check());

  // Named one at a time, because "nothing was lost" is a claim and these are the
  // things recreation would have lost. Only what is really there is listed.
  const survivors = [
    ...(facts.isReply ? ["its threading"] : []),
    ...(outcome.shown.quoted ? ["the original it quotes"] : []),
    ...(facts.attachments > 0 ? [`its ${facts.attachments} attachment(s)`] : []),
  ];
  const kept =
    survivors.length === 0
      ? "it is"
      : `${survivors.slice(0, -1).join(", ")}${survivors.length > 1 ? " and " : ""}${survivors.at(-1)} ${
          survivors.length > 1 ? "are" : "is"
        }`;

  return {
    replaced: true,
    method: "inPlace",
    subject: facts.subject,
    bodyLength: opts.body.length,
    // The two things recreation could not have kept, kept — because nothing was
    // recreated.
    threadingKept: facts.isReply,
    // Read from the window AFTER the paste, not before it. The before-reading
    // would only say a quote was there to lose, which is not the claim being
    // made: this says one is there now, over text that has just been replaced.
    quoteKept: outcome.shown.quoted,
    attachmentsKept: facts.attachments,
    recipientCount: facts.recipientCount,
    draftsMailbox: facts.draftsMailbox,
    saved: saved === "pressed",
    note:
      saved === "pressed"
        ? `The draft was edited in its own composer window — nothing was recreated, so ${kept} ` +
          `untouched, and no second draft was made. The window is still open in Mail for ` +
          `review. Mail may renumber a saved draft's row within seconds, so re-find it by ` +
          `subject rather than reusing the ref across turns.` +
          disturbed
        : saved === "refused"
          ? `The new body is in the composer and verified, but Mail would not come forward, so ` +
            `command-S was not pressed and the draft on disk still holds the OLD text. The ` +
            `window is open with the new text in it. Press save in Mail, or try again once the ` +
            `Mac is free.` +
            disturbed
          : `The new body was pasted and verified, and then the composer window went — nothing ` +
            `here closes one, so someone using the Mac closed or sent it. Look in Mail before ` +
            `doing anything else.` +
            disturbed,
  };
};
