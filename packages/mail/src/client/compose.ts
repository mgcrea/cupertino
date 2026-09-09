import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { interferenceNote, type OsascriptRunner } from "@mgcrea/mcp-apple-core";

import { containsText, MailAxLane, type ComposerRef } from "./ax.js";
import { SENT_SINCE } from "./jxa/read.js";
import { OPEN_COMPOSER } from "./jxa/write.js";

const run = promisify(execFile);

/**
 * Reply or forward, with the body driven natively.
 *
 * ## Why this is two halves rather than one script
 *
 * A JXA object reference cannot outlive the `osascript` process that made it,
 * and `packages/core/src/osascript.ts` spawns one per call by design. The
 * original flow held `draft` from `M.reply(...)` through to `draft.send()`, with
 * every Accessibility step in between — so moving those steps out of the script
 * necessarily ends the reference before the send.
 *
 * The arrangement that needs no reference: `OPEN_COMPOSER` opens and addresses
 * the composer and returns the SUBJECT, which is an identity the native half can
 * find a window by; everything after is Accessibility, including the send, which
 * becomes command-shift-D rather than `draft.send()`.
 *
 * The alternative — re-finding the draft in a third Apple Events call — was
 * rejected: drafts are discovered by subject, so two with the same one are
 * indistinguishable, and this is the single path whose named failure is sending
 * the wrong thing.
 *
 * ## What is given up, and it is stated rather than hidden
 *
 * The System Events path discards the composer when a paste provably did not
 * land, so a retry is safe. This one cannot: closing an unsaved composer raises
 * a save sheet whose buttons are LOCALISED, and pressing a button by a name that
 * is only right in English is worse than not pressing one. So a failed compose
 * here always leaves the window on screen and says so. Strictly safer — nothing
 * a person wrote is ever destroyed — and strictly less tidy.
 */

/** How long to wait for the composer, matching the System Events path's 8s. */
const COMPOSER_TIMEOUT_MS = 8_000;

/** How long to wait for the window to close before calling a send unconfirmed. */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Confirm the opening of the body rather than all of it.
 *
 * A paste either arrives whole or does not arrive, which is what was measured,
 * so the top of it is the tell.
 */
const VERIFY_CHARS = 400;

/**
 * How far back to accept a message in Sent as this call's.
 *
 * Generous on purpose. `dateSent` and the moment the row appears are not the
 * same instant — a real send measured 16s between them — and the cost of the two
 * errors is lopsided: a window slightly too wide names a message that was
 * already there, which a reader can see and dismiss; one too narrow reports a
 * reply that DID go as missing, and invites sending it again.
 */
const SENT_SLACK_MS = 120_000;

export type ComposeResult = {
  ok: boolean;
  subject: string;
  bodyVerified: boolean | null;
  verifiedChars: number;
  /** Null when it cannot be told — the composer went while nobody was looking. */
  sent: boolean | null;
  note: string;
};

/**
 * Did anything at all reach the composer?
 *
 * Three answers rather than two, and the third is the bug this path was rebuilt
 * around. "unknown" is a body that cannot be READ — which is what a composer
 * that has closed looks like from here, because its element handle dies with it.
 * Folding that into "different from before" reported a reply sent by hand as a
 * body that never went in.
 */
type Landed = "yes" | "no" | "unknown";

const compare = (before: number | null, after: number | null): Landed => {
  if (before === null || after === null) return "unknown";
  return after === before ? "no" : "yes";
};

/**
 * The pasteboard, as a seam.
 *
 * Injectable because the real one is shared machine state: a test that called
 * `pbcopy` would clobber whatever the person running it had copied, which is
 * not a thing a test suite may do.
 */
export type Clipboard = { read(): Promise<string | null>; write(text: string): Promise<void> };

export const systemClipboard: Clipboard = {
  async read() {
    try {
      return (await run("/usr/bin/pbpaste", [])).stdout;
    } catch {
      return null;
    }
  },
  async write(text) {
    const child = execFile("/usr/bin/pbcopy", []);
    child.stdin?.end(text);
    await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
  },
};

/**
 * Borrow the clipboard, and put it back.
 *
 * The same cost the System Events path documents and for the same reason: this
 * is a paste, so the pasteboard is the mechanism. A clipboard holding an image
 * or a file promise still comes back as text, because there is no way to carry
 * an arbitrary item across without knowing its type.
 */
const withClipboard = async <T>(
  clipboard: Clipboard,
  text: string,
  body: () => Promise<T>,
): Promise<T> => {
  const saved = await clipboard.read();
  await clipboard.write(text);
  try {
    return await body();
  } finally {
    if (saved !== null) {
      try {
        await clipboard.write(saved);
      } catch {
        // The clipboard is a courtesy; failing to restore it must not turn a
        // sent reply into a reported failure.
      }
    }
  }
};

const paste = async (
  lane: MailAxLane,
  clipboard: Clipboard,
  ref: ComposerRef,
  text: string,
  focusTimeoutMs: number | undefined,
): Promise<{ verified: boolean; landed: Landed }> => {
  const expected = text.length > VERIFY_CHARS ? text.slice(0, VERIFY_CHARS) : text;
  const sizeBefore = await lane.bodySize(ref.body);

  return withClipboard(clipboard, text, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const focused = await lane.paste(ref, focusTimeoutMs);
      if (focused) {
        const after = await lane.bodyText(ref.body);
        if (after !== null && containsText(after, expected))
          return { verified: true, landed: "yes" as const };
      }
      // Something went in that cannot be matched, or the body can no longer be
      // read at all. Pasting again would put the reply in the draft twice, and
      // nothing here can undo that — so an UNKNOWN reading stops the retry just
      // as firmly as a changed one.
      if (compare(sizeBefore, await lane.bodySize(ref.body)) !== "no") break;
    }
    return { verified: false, landed: compare(sizeBefore, await lane.bodySize(ref.body)) };
  });
};

/**
 * What became of a composer that is no longer on screen.
 *
 * Nothing in this file closes a composer, so one that has gone was taken by the
 * person at the keyboard — and sent and discarded look identical from the
 * Accessibility side. This is the only place that can tell them apart, and it
 * asks Mail rather than guessing.
 *
 * Costs one Apple Event, on a failure path. Deliberately NOT the envelope index:
 * the index is rebuilt on a schedule and was 47 minutes stale when this bug was
 * found, so it cannot see a message sent seconds ago.
 */
const sentVerdict = async (
  runner: OsascriptRunner,
  accountUuid: string,
  subject: string,
  since: number,
): Promise<{ sent: boolean | null; sentence: string }> => {
  let found: {
    checked?: boolean;
    found?: boolean;
    mailbox?: string;
    scanned?: number;
    newest?: string | null;
    messages?: { dateSent?: string | null; dateReceived?: string | null }[];
  };
  try {
    found = (await runner.run(SENT_SINCE, {
      accountUuid,
      subject,
      sinceMs: since - SENT_SLACK_MS,
    })) as typeof found;
  } catch {
    return {
      sent: null,
      sentence:
        "Whether it was sent could NOT be checked from here — Mail would not answer for its " +
        "Sent mailbox. Look there for this subject before retrying: a retry after a send that " +
        "did go sends it twice.",
    };
  }

  if (found.checked !== true) {
    return {
      sent: null,
      sentence:
        "Whether it was sent could NOT be checked from here — no Sent mailbox could be resolved. " +
        "Look for this subject in Sent before retrying: a retry after a send that did go sends " +
        "it twice.",
    };
  }

  if (found.found === true) {
    const when = found.messages?.[0]?.dateSent ?? found.messages?.[0]?.dateReceived ?? "just now";
    return {
      sent: true,
      sentence:
        `It WAS SENT: a message with this subject is in ${found.mailbox ?? "Sent"}, dated ` +
        `${when}. Do NOT send it again. Its body was never read back from the window, so what ` +
        `went out is not verified from here — open it in ${found.mailbox ?? "Sent"} to see what ` +
        `it actually says.`,
    };
  }

  // Nothing matched, which is only evidence if the listing was showing recent
  // mail at all. See SENT_SINCE on why `found: false` is weak on its own.
  const newest = found.newest ? Date.parse(found.newest) : Number.NaN;
  if (!Number.isNaN(newest) && newest < since - SENT_SLACK_MS) {
    return {
      sent: null,
      sentence:
        `Whether it was sent could NOT be told: the ${found.scanned ?? 0} messages read back ` +
        `from ${found.mailbox ?? "Sent"} are all older than this call (newest ${found.newest}), ` +
        `so that listing never showed recent mail. Check Sent yourself before retrying.`,
    };
  }
  return {
    sent: false,
    sentence:
      `It does NOT appear to have been sent: no message with this subject is among the ` +
      `${found.scanned ?? 0} most recent in ${found.mailbox ?? "Sent"}. So it was most likely ` +
      `closed or discarded rather than sent. Confirm in Sent before retrying.`,
  };
};

export const replyOrForwardNatively = async (
  lane: MailAxLane,
  runner: OsascriptRunner,
  params: {
    accountUuid: string;
    mailbox: string;
    id: number;
    mode: "reply" | "forward";
    body: string | null;
    to: string[];
    replyToAll: boolean;
    sendNow: boolean;
  },
  opts: {
    clipboard?: Clipboard;
    /** Overridable so a test can pin the unconfirmed-send path without waiting for it. */
    composerTimeoutMs?: number;
    sendTimeoutMs?: number;
    /** Same, for the focus poll — see FOCUS_TIMEOUT_MS in `ax.ts`. */
    focusTimeoutMs?: number;
  } = {},
): Promise<ComposeResult> => {
  const clipboard = opts.clipboard ?? systemClipboard;
  const composerTimeoutMs = opts.composerTimeoutMs ?? COMPOSER_TIMEOUT_MS;
  const sendTimeoutMs = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  // Asked BEFORE anything is opened, keeping the ordering the System Events path
  // established: the failure this tool was best known for left an empty reply
  // window on screen on every attempt, and nothing about the check needs the
  // window to exist.
  // Watched from before anything is opened, so a disturbed run says so instead
  // of blaming Mail. Every refusal below appends the finding when there is one.
  const watch = lane.watch();
  // The floor for the Sent check below, taken before the composer exists so it
  // cannot exclude the very message this call is about.
  const startedAt = Date.now();

  const reach = await lane.reach();
  if (!reach.ok) throw new Error(MailAxLane.grantMessage(params.mode));

  const opened = (await runner.run(OPEN_COMPOSER, params)) as { subject: string };
  const subject = opened.subject;

  const ref = await lane.findComposer(subject, composerTimeoutMs);
  if (!ref) {
    return {
      ok: false,
      subject,
      bodyVerified: null,
      verifiedChars: 0,
      sent: false,
      note:
        `Mail was asked to open a ${params.mode} window for "${subject}" and no such window was ` +
        `readable within ${composerTimeoutMs / 1000}s, although Mail's other windows read ` +
        `fine — so this is not a permission. Nothing was written. The window may still be on ` +
        `screen: look for an empty ${params.mode} in Mail before retrying, because a retry ` +
        `would leave a second one behind. Windows visible at the time: ` +
        `${JSON.stringify(reach.windows)}.` +
        interferenceNote(await watch.check()),
    };
  }

  /**
   * The composer is no longer on screen, and nothing here closed it.
   *
   * Which makes this someone else's doing, and the two things they can have done
   * — sent it, discarded it — leave exactly the same empty screen. Saying "the
   * body did not go in" here is what shipped, and it was wrong in every part: it
   * named the body as the failure when the body was fine, and forbade the retry
   * on double-paste grounds when the real hazard was sending the mail twice.
   */
  const vanished = async (
    // What was known about the body before the window went. Null from the paste,
    // which is the case that could not read it; true when the vanishing arrived
    // later, after a body had been read back and matched — and that is worth
    // keeping, because it says the message that may have gone out was the right
    // one.
    knownBody: { verified: boolean; chars: number } | null = null,
  ): Promise<ComposeResult> => {
    const verdict = await sentVerdict(runner, params.accountUuid, subject, startedAt);
    return {
      ok: false,
      subject,
      // Unknown, NOT false. Nothing here established that the body was wrong.
      bodyVerified: knownBody?.verified ?? null,
      verifiedChars: knownBody?.chars ?? 0,
      sent: verdict.sent,
      note:
        `The ${params.mode} window for "${subject}" is GONE. Nothing here closed it — this path ` +
        `never discards a composer — so someone using the Mac sent it or closed it while this ` +
        `was running. ${verdict.sentence}` +
        interferenceNote(await watch.check()),
    };
  };

  let bodyVerified: boolean | null = null;
  let verifiedChars = 0;
  if (params.body) {
    const result = await paste(lane, clipboard, ref, params.body, opts.focusTimeoutMs);
    bodyVerified = result.verified;
    verifiedChars = result.verified ? Math.min(params.body.length, VERIFY_CHARS) : 0;
    if (!result.verified) {
      // Asked before anything is claimed about the body: a composer that has
      // gone reads exactly like one whose body is unreadable, and only this
      // tells them apart.
      if (await lane.composerGone(subject, 0)) return vanished();
      return {
        ok: false,
        subject,
        bodyVerified: false,
        verifiedChars: 0,
        sent: false,
        note:
          `The ${params.mode} window for "${subject}" was opened and correctly addressed, but ` +
          `the body did not go in: reading the composer back does not show the text that was ` +
          `sent. It MUST NOT be described to the user as ready. ` +
          (result.landed === "no"
            ? "Nothing landed in it. It was left open rather than discarded, because closing an " +
              "unsaved composer raises a save sheet whose buttons are localised. Close it in " +
              "Mail, then retry."
            : result.landed === "yes"
              ? "SOMETHING DID land in it that could not be read back — look at it in Mail " +
                "before retrying, because a retry would paste the reply in twice."
              : "The window is still there but its body could not be READ, so whether anything " +
                "landed is unknown — look at it in Mail before retrying, because a retry would " +
                "paste the reply in twice.") +
          interferenceNote(await watch.check()),
      };
    }
  }

  // False means the composer could not be raised — it has gone — and no
  // keystroke was posted. The body was verified a moment ago, so this is the
  // same vanishing arriving one step later.
  if (!(await lane.finish(params.sendNow, ref)))
    return vanished(bodyVerified === true ? { verified: true, chars: verifiedChars } : null);
  // A send closes the window. Checked rather than assumed: nothing here may
  // report success on the strength of a keystroke having been delivered.
  const sent = params.sendNow ? await lane.composerGone(subject, sendTimeoutMs) : false;

  return {
    ok: params.sendNow ? sent : true,
    subject,
    bodyVerified,
    verifiedChars,
    sent,
    note: params.sendNow
      ? sent
        ? "Sent."
        : `The ${params.mode} was composed and verified, but its window is still open ${
            sendTimeoutMs / 1000
          }s after the send, so it may not have gone. Check Mail before retrying.`
      : "Draft window is open in Mail for review.",
  };
};
