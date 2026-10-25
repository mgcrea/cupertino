import { squash, type MailAxLane } from "./ax.js";

/**
 * Rewrite a draft by editing its open composer, instead of rebuilding it.
 *
 * Mail's scripting interface offers no way to edit a saved draft, so one whose
 * window is closed is rebuilt (`rebuild.ts`): a new draft is made and the old
 * one deleted. A composer's body can however be rewritten in place: the save
 * lands on the same draft, and threading, attachments and the quoted original
 * are all still there afterwards because nothing was ever remade.
 *
 * The editing itself now happens in the app, in one verified native step
 * (`mail_composer_edit`): it selects, replaces, reads the result back and saves
 * only what it could verify. What is left here is the half only this side can do,
 * which is knowing WHICH composer is this draft:
 *
 *   * The window is matched to the draft by CONTENT, not only by subject. Two
 *     replies in one thread carry the same title.
 *   * The first 120 characters of the stored text go along as `expectHead`, so
 *     the app checks the same thing again against the window it actually edits.
 *   * Every refusal the app makes is returned exactly as it answered.
 */

/**
 * How much of the draft's stored text has to match the window's.
 *
 * The question is only ever "is this window this draft", and the opening of a
 * body answers it. What goes wrong is a leftover composer from another thread,
 * and it disagrees immediately.
 */
const IDENTITY_CHARS = 120;

/** What a text reading puts where a file is. */
const FILE_CHAR = "￼";

/** What the Apple Events half has to say about the draft before this can start. */
export type DraftFacts = {
  subject: string;
  isReply: boolean;
  attachments: number;
  recipientCount: number;
  /** The opening of what the draft actually holds, for matching a window to it. */
  contentHead: string;
  draftsMailbox: string;
  /**
   * Row ids already in Drafts under the subject a rebuild will save under (the
   * new one when it changes), the draft's own included, so that none of them
   * can be taken for the rebuilt draft. See `COMMIT_REPLACEMENT`.
   */
  siblings?: number[];
};

export type ReviseOptions = {
  /** The new body. Omitted, the sender's text is left exactly as it is. */
  body?: string | undefined;
  /** Absolute paths, already resolved and gated by the client. */
  attachments?: string[] | undefined;
  /** Edits applied to the composer's own text, in place of a whole `body`. */
  edits?: { find: string; replace: string }[] | undefined;
  /** Edit this composer handle, skipping the match by content. */
  composer?: string | undefined;
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
  // A file is an element with no value in the window, and plain text renders
  // one as an object replacement character (unmeasured for a stored draft), so
  // neither side's reading of one is compared with the other's.
  const a = squash(stored.replaceAll(FILE_CHAR, ""));
  const b = squash(shown.replaceAll(FILE_CHAR, ""));
  // Both empty is a match: a reply whose body was never written has nothing to
  // compare, and pasting into it destroys nothing either way.
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const chars = Math.min(a.length, b.length, IDENTITY_CHARS);
  return a.slice(0, chars) === b.slice(0, chars);
};

/**
 * Edit a draft in its open composer, or add files to it, or both.
 *
 * Null — and only null — means there is no composer for this draft, which is the
 * caller's signal to fall back to rebuilding it. Every other outcome, including
 * every refusal the app makes, is a result the caller returns as it stands.
 */
export const reviseDraftInPlace = async (
  lane: MailAxLane,
  facts: DraftFacts,
  opts: ReviseOptions,
): Promise<Record<string, unknown> | null> => {
  const reach = await lane.reach();
  // Not a refusal here: the rebuild that follows asks the same question and
  // refuses with the grant to fix.
  if (!reach.ok) return null;

  let handle = opts.composer;
  if (handle === undefined) {
    const sameSubject = (await lane.composers()).filter((c) => c.subject === facts.subject);
    // Null only when nothing is open under this subject at all.
    if (sameSubject.length === 0) return null;
    const matches = sameSubject.filter((c) => sameDraft(facts.contentHead, c.text));
    if (matches.length === 0) {
      return refuse(
        "identity",
        facts,
        `A composer titled "${facts.subject}" is open, but what it holds is not what this draft ` +
          `holds — most likely a different message under the same subject, such as another reply ` +
          `in the thread. Rewriting it would destroy text belonging to something else, so nothing ` +
          `was touched.`,
        "Check which windows are open in Mail, or edit the draft there directly.",
        {
          composerText: (sameSubject[0] as { text: string }).text.slice(0, 200),
          draftText: facts.contentHead.slice(0, 200),
        },
      );
    }
    if (matches.length > 1) {
      return refuse(
        "identity",
        facts,
        `Several windows hold this draft's text: ${matches.length} composers titled ` +
          `"${facts.subject}" open with what the draft holds, and nothing here can tell which of ` +
          `them is it. Rewriting the wrong one would destroy what is in it, so nothing was touched.`,
        "Close or finish all but one of those windows in Mail, then try again.",
      );
    }
    handle = (matches[0] as { composer: string }).composer;
  }

  const files = opts.attachments ?? [];
  const head = facts.contentHead.slice(0, IDENTITY_CHARS);
  const answer = await lane.editComposer({
    composer: handle,
    ...(opts.edits !== undefined ? { edits: opts.edits } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(files.length > 0 ? { attachments: files } : {}),
    ...(head.length > 0 ? { expectHead: head } : {}),
  });
  if (answer.replaced !== true) return answer;

  return {
    subject: facts.subject,
    // The assigning route (`UPDATE_DRAFT`) reports a count, this one names the
    // files; both are here so a caller reads one field whichever route ran.
    attachmentsAdded: Array.isArray(answer.filesAdded) ? answer.filesAdded.length : 0,
    ...(opts.body !== undefined ? { bodyLength: opts.body.length } : {}),
    threadingKept: facts.isReply,
    attachmentsKept: facts.attachments,
    recipientCount: facts.recipientCount,
    draftsMailbox: facts.draftsMailbox,
    ...answer,
  };
};
