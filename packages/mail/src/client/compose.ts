import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { interferenceNote, type OsascriptRunner } from "@mgcrea/mcp-apple-core";

import { containsText, MailAxLane, type ComposerRef } from "./ax.js";
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

export type ComposeResult = {
  ok: boolean;
  subject: string;
  bodyVerified: boolean | null;
  verifiedChars: number;
  sent: boolean;
  note: string;
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
): Promise<{ verified: boolean; landed: boolean }> => {
  const expected = text.length > VERIFY_CHARS ? text.slice(0, VERIFY_CHARS) : text;
  const sizeBefore = await lane.bodySize(ref.body);

  return withClipboard(clipboard, text, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const focused = await lane.paste(ref);
      if (focused) {
        const after = await lane.bodyText(ref.body);
        if (after !== null && containsText(after, expected))
          return { verified: true, landed: true };
      }
      // Something went in that cannot be matched. Pasting again would put the
      // reply in the draft twice, and nothing here can undo that.
      if ((await lane.bodySize(ref.body)) !== sizeBefore) break;
    }
    return { verified: false, landed: (await lane.bodySize(ref.body)) !== sizeBefore };
  });
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

  let bodyVerified: boolean | null = null;
  let verifiedChars = 0;
  if (params.body) {
    const result = await paste(lane, clipboard, ref, params.body);
    bodyVerified = result.verified;
    verifiedChars = result.verified ? Math.min(params.body.length, VERIFY_CHARS) : 0;
    if (!result.verified) {
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
          (result.landed
            ? "SOMETHING DID land in it that could not be read back — look at it in Mail before " +
              "retrying, because a retry would paste the reply in twice."
            : "Nothing landed in it. It was left open rather than discarded, because closing an " +
              "unsaved composer raises a save sheet whose buttons are localised. Close it in " +
              "Mail, then retry.") +
          interferenceNote(await watch.check()),
      };
    }
  }

  await lane.finish(params.sendNow);
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
