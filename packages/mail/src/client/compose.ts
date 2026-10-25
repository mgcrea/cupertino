import { interferenceNote, type OsascriptRunner } from "@mgcrea/mcp-apple-core";

import { MailAxLane, squash } from "./ax.js";
import { SENT_SINCE } from "./jxa/read.js";
import { OPEN_COMPOSER } from "./jxa/write.js";

/**
 * Reply, forward or new message, with the body filled natively.
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
 * the composer, and the composer it opened is the handle that APPEARS in the
 * app's `mail_composers` list afterwards (taken before, so a leftover under the
 * same subject is no longer a clash). The app's `mail_composer_edit` verb then
 * fills it and reads it back. The one step it cannot do is send, which stays
 * command-shift-D, and which is aimed by subject — so it is pressed only when
 * exactly one composer carries that subject.
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

/** Between reads of the composer list while waiting for a new one. */
const COMPOSER_POLL_MS = 100;

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
  /** Set when a native compose stopped short; see `ComposeResult.note`. */
  degraded?: boolean;
  ok: boolean;
  subject: string;
  bodyVerified: boolean | null;
  verifiedChars: number;
  /** Null when it cannot be told — the composer went while nobody was looking. */
  sent: boolean | null;
  note: string;
  /** Files put on the composer. The number pushed, not read back: see OPEN_COMPOSER. */
  attachments?: number;
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
  accountUuid: string | null,
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

/**
 * What a native compose is asked to do.
 *
 * A reply or forward names its original by `accountUuid`, `mailbox` and `id`.
 * A new message carries its own `subject`, sender and recipients instead, and
 * its `accountUuid` is the sending account when one was named — used only to
 * look in the right Sent mailbox if the window goes.
 */
export type ComposeParams = {
  mode: "new" | "reply" | "forward";
  accountUuid: string | null;
  mailbox?: string;
  id?: number;
  subject?: string;
  senderAddress?: string | null;
  body: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyToAll?: boolean;
  attachments?: string[];
  sendNow: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What `awaitNewComposer` found: the one composer that appeared, several that
 * could each be it (never picked between), or nothing in time (null).
 */
export type NewComposer = { handle: string } | { ambiguous: string[] };

/**
 * Wait for a composer that was not there before, and return its handle.
 *
 * `before` is the handles `composers()` listed BEFORE Mail was asked to open
 * anything. That is what makes a leftover under the same subject harmless: the
 * handle is stable for the window's life, so the one that APPEARS is the one
 * this call opened, whatever it is titled.
 *
 * A person can open a window by hand during the poll, and an empty composer
 * gives nothing to tell theirs from ours. So the candidates are every fresh
 * handle, narrowed to those titled `subject` when it is given (the subject
 * `OPEN_COMPOSER` returned). Exactly one candidate is returned as `{ handle }`;
 * more than one is `{ ambiguous }` and nothing is picked, because filling the
 * wrong one puts a message in somebody else's window. Zero keeps polling until
 * `timeoutMs`, then null. A fresh composer under another subject is not a
 * candidate when a subject is given.
 *
 * Polled rather than waited for: a window existing is not the app listing it.
 * A read that fails is retried until the deadline.
 */
export const awaitNewComposer = async (
  lane: MailAxLane,
  before: string[],
  timeoutMs: number,
  subject?: string,
): Promise<NewComposer | null> => {
  const known = new Set(before);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fresh = (await lane.composers()).filter((c) => !known.has(c.composer));
      const candidates = subject === undefined ? fresh : fresh.filter((c) => c.subject === subject);
      if (candidates.length === 1)
        return { handle: (candidates[0] as { composer: string }).composer };
      if (candidates.length > 1) return { ambiguous: candidates.map((c) => c.composer) };
    } catch {
      // Retried below; the deadline decides.
    }
    if (Date.now() >= deadline) return null;
    await sleep(COMPOSER_POLL_MS);
  }
};

/**
 * Compose natively: open and address over Apple Events, then fill the body and
 * any files through the app's `mail_composer_edit` verb, which reads both back.
 *
 * Nothing here assigns `content`, which is what keeps a NEW message from going
 * out as one long quotation — see OPEN_COMPOSER.
 */
export const composeNatively = async (
  lane: MailAxLane,
  runner: OsascriptRunner,
  params: ComposeParams,
  opts: {
    /** Overridable so a test can pin the unconfirmed-send path without waiting for it. */
    composerTimeoutMs?: number;
    sendTimeoutMs?: number;
  } = {},
): Promise<ComposeResult> => {
  const composerTimeoutMs = opts.composerTimeoutMs ?? COMPOSER_TIMEOUT_MS;
  const sendTimeoutMs = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  // Watched from before anything is opened, so a disturbed run says so instead
  // of blaming Mail. Every refusal below appends the finding when there is one.
  const watch = lane.watch();
  // The floor for the Sent check below, taken before the composer exists so it
  // cannot exclude the very message this call is about.
  const startedAt = Date.now();

  // Asked BEFORE anything is opened, keeping the ordering the System Events path
  // established: the failure this tool was best known for left an empty reply
  // window on screen on every attempt.
  const reach = await lane.reach();
  if (!reach.ok)
    throw new Error(`${MailAxLane.grantMessage(params.mode)} ${MailAxLane.nothingWritten}`);

  // Files go through the verb below, never to Mail's scripting object.
  const { attachments: files = [], ...toOpen } = params;

  // Taken before Mail is asked to open anything: the new composer is the
  // handle that is absent from this list afterwards.
  const before = (await lane.composers()).map((c) => c.composer);
  const subject = ((await runner.run(OPEN_COMPOSER, toOpen)) as { subject: string }).subject;
  const found = await awaitNewComposer(lane, before, composerTimeoutMs, subject);
  if (found && "ambiguous" in found) {
    return {
      ok: false,
      subject,
      bodyVerified: null,
      verifiedChars: 0,
      sent: false,
      note:
        `Mail was asked to open a ${params.mode} window for "${subject}", and ` +
        `${found.ambiguous.length} new composers titled that appeared (${found.ambiguous.join(", ")}), ` +
        `so this path cannot tell which one it opened. Nothing was filled, pressed or sent, and ` +
        `all of them are left open in Mail. Close the extra one, finish the other by hand, ` +
        `then retry.` +
        interferenceNote(await watch.check()),
    };
  }
  const handle = found?.handle ?? null;

  if (!handle) {
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
    // What was known about the body before the window went. Null when nothing
    // had been read back; true when the vanishing arrived after a body had been
    // read back and matched — worth keeping, because it says the message that
    // may have gone out was the right one.
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

  const body = params.body ?? "";
  const filling = body !== "" || files.length > 0;
  let bodyVerified: boolean | null = null;
  let verifiedChars = 0;

  if (filling) {
    let edit: Record<string, unknown>;
    try {
      edit = await lane.editComposer({
        composer: handle,
        ...(body !== "" ? { body } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        // The verb has no send. A send is pressed below, once it is known which
        // composer the shortcut would reach.
        save: !params.sendNow,
      });
    } catch (error) {
      if (await lane.composerGone(subject, 0)) return vanished();
      return {
        ok: false,
        degraded: true,
        subject,
        bodyVerified: null,
        verifiedChars: 0,
        sent: false,
        note:
          `The ${params.mode} window for "${subject}" was opened and addressed, but filling it ` +
          `failed: ${error instanceof Error ? error.message : String(error)} Its window is ` +
          `still open in Mail: finish it there, or close it without saving and retry.` +
          interferenceNote(await watch.check()),
      };
    }

    if (edit["replaced"] !== true) {
      // A composer that has gone refuses like one that cannot be filled; only
      // this tells them apart.
      if (await lane.composerGone(subject, 0)) return vanished();
      const reason = typeof edit["reason"] === "string" ? edit["reason"] : "The edit was refused.";
      const hint = typeof edit["hint"] === "string" ? ` ${edit["hint"]}` : "";
      return {
        ok: false,
        degraded: true,
        subject,
        bodyVerified: null,
        verifiedChars: 0,
        sent: false,
        note:
          `${reason}${hint} The ${params.mode} window for "${subject}" is still open in Mail.` +
          interferenceNote(await watch.check()),
      };
    }

    const text = typeof edit["text"] === "string" ? edit["text"] : "";
    if (body !== "") {
      bodyVerified = squash(text) === squash(body);
      verifiedChars = text.length;
      if (!bodyVerified) {
        return {
          ok: false,
          subject,
          bodyVerified: false,
          verifiedChars,
          sent: false,
          note:
            `The ${params.mode} window for "${subject}" was opened and correctly addressed, but ` +
            `reading the composer back does not show the text that was sent. It MUST NOT be ` +
            `described to the user as ready. It was left open rather than discarded, and may ` +
            `already be saved as it stands: look at it in Mail, then fix or close it.` +
            interferenceNote(await watch.check()),
        };
      }
    }
    if (!params.sendNow && edit["saved"] === false) {
      return {
        ok: false,
        degraded: true,
        subject,
        bodyVerified,
        verifiedChars,
        sent: false,
        ...(files.length > 0 ? { attachments: files.length } : {}),
        note:
          `The ${params.mode} window for "${subject}" was filled` +
          (bodyVerified ? " and its body verified" : "") +
          `, but it was NOT saved. Its window is still open in Mail: save it there.` +
          interferenceNote(await watch.check()),
      };
    }
  }

  const known = () => (bodyVerified === true ? { verified: true, chars: verifiedChars } : null);

  // Filled and saved by the verb: there is nothing left to press.
  if (filling && !params.sendNow) {
    return {
      ok: true,
      subject,
      bodyVerified,
      verifiedChars,
      sent: false,
      ...(files.length > 0 ? { attachments: files.length } : {}),
      note: "Draft window is open in Mail for review.",
    };
  }

  /*
   * What is left to press is aimed by SUBJECT: the send shortcut (the verb has
   * no send) and, for a forward with nothing to fill, command-S. With two
   * composers under one title it could reach either, and the wrong message
   * sent is the failure this path is built to refuse. So it is pressed only
   * when exactly one composer carries the subject, and the filled draft is left
   * open for review otherwise.
   */
  let sharing: string[] | null;
  try {
    sharing = (await lane.composers()).filter((c) => c.subject === subject).map((c) => c.composer);
  } catch {
    sharing = null;
  }
  if (sharing !== null && sharing.length === 0) return vanished(known());
  const action = params.sendNow ? "sent" : "saved";
  if (sharing === null || sharing.length !== 1 || sharing[0] !== handle) {
    return {
      ok: false,
      degraded: true,
      subject,
      bodyVerified,
      verifiedChars,
      sent: false,
      ...(files.length > 0 ? { attachments: files.length } : {}),
      note:
        `The ${params.mode} for "${subject}" was ${filling ? "filled" : "opened"}` +
        (bodyVerified ? " and its body verified" : "") +
        `, but it was NOT ${action}: ` +
        (sharing === null
          ? `Mail's composers could not be listed, so it is not known that the title picks out one.`
          : `${sharing.length} composers in Mail carry this title, and the shortcut is aimed by ` +
            `title, so it could reach the wrong one.`) +
        ` The draft is open in Mail for review: ${params.sendNow ? "send" : "save"} it from there.` +
        interferenceNote(await watch.check()),
    };
  }

  const ref = await lane.findComposer(subject, composerTimeoutMs);
  if (!ref) {
    if (await lane.composerGone(subject, 0)) return vanished(known());
    return {
      ok: false,
      degraded: true,
      subject,
      bodyVerified,
      verifiedChars,
      sent: false,
      note:
        `The ${params.mode} for "${subject}" was composed, but its window could not be read to ` +
        `press anything, so it was NOT ${action}. It is open in Mail for review.` +
        interferenceNote(await watch.check()),
    };
  }

  // Nothing was pressed unless `finish` says so, and its two refusals must not
  // be reported alike. A composer that could not be raised has gone, the same
  // vanishing as above arriving one step later. A refused keystroke left the
  // composer where it was: the key names it, and the desktop server will not
  // post into somebody else's window when Mail does not come forward.
  const finished = await lane.finish(params.sendNow, ref);
  if (finished === "gone") return vanished(known());
  if (finished === "refused") {
    return {
      ok: false,
      subject,
      bodyVerified,
      verifiedChars,
      sent: false,
      note:
        `The ${params.mode} for "${subject}" was composed, but Mail could not be brought to the ` +
        `front, so nothing was pressed and it was not ${action}. ` +
        `Its window is still open in Mail. Someone is probably using the Mac; retry once it ` +
        `is free, or finish it in Mail.` +
        interferenceNote(await watch.check()),
    };
  }
  // A send closes the window. Checked rather than assumed: nothing here may
  // report success on the strength of a keystroke having been delivered.
  const sent = params.sendNow ? await lane.composerGone(subject, sendTimeoutMs) : false;

  return {
    ok: params.sendNow ? sent : true,
    subject,
    bodyVerified,
    verifiedChars,
    sent,
    ...(files.length > 0 ? { attachments: files.length } : {}),
    note: params.sendNow
      ? sent
        ? "Sent."
        : `The ${params.mode} was composed and verified, but its window is still open ${
            sendTimeoutMs / 1000
          }s after the send, so it may not have gone. Check Mail before retrying.`
      : "Draft window is open in Mail for review.",
  };
};
