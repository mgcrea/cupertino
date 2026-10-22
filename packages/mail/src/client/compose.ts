import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import { interferenceNote, type OsascriptRunner } from "@mgcrea/mcp-apple-core";

import {
  containsText,
  isFileNamed,
  MailAxLane,
  squash,
  type ComposerBody,
  type ComposerRef,
} from "./ax.js";
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
 * How long to keep re-reading the body for text that was just pasted.
 *
 * **A paste is not on screen when the keystroke returns.** `apple_desktop_key`
 * answers once the event is POSTED; WebKit then has to take it, edit the
 * document and republish an accessibility tree. Reading once, immediately, races
 * that — and loses on exactly the mail where it hurts, because the re-layout is
 * paid for the whole document and a reply carries the original inside it.
 *
 * MEASURED, macOS 27.0 (build 26A428): a two-line reply pasted into a composer
 * quoting a 322-element newsletter came back `bodyVerified: false` with "SOMETHING
 * DID land in it that could not be read back" — and the tree, read again a
 * moment later, held both lines exactly as sent. A correct reply reported as a
 * failure, which then tells its reader not to retry.
 *
 * So the read is polled, like the focus above it and for the same reason
 * `docs/desktop.md` gives: readable is not ready, and no fixed settle time is
 * right. Costs nothing on the common path — the first read still usually
 * answers — and the bound only has to be longer than a slow re-layout.
 */
const RENDER_TIMEOUT_MS = 3_000;

/** Between read-backs. Each is a round trip over a subtree, so not a spin. */
const RENDER_POLL_MS = 150;

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
export type Clipboard = {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Put these files on the pasteboard, the way Finder's Copy does. */
  writeFiles(paths: string[]): Promise<void>;
};

/**
 * File URLs onto the pasteboard, as `public.file-url` and `NSFilenamesPboardType`.
 *
 * `pbcopy` only carries text, so this goes through the ObjC bridge. The paths
 * arrive as arguments and are never spliced into the source, so a filename
 * holding a quote is a filename and not code. Throws when the pasteboard
 * refuses, rather than leaving whatever was there to be pasted in their place.
 *
 * The array is built as an NSMutableArray on purpose. MEASURED, macOS 27.0:
 * `$(jsArray)` of two NSURLs wrote ONE pasteboard item and `writeObjects`
 * still answered true, so the second file would have gone missing without a
 * word. Hence the count check as well.
 */
const WRITE_FILES = `
function run(argv) {
  ObjC.import("AppKit");
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  var urls = $.NSMutableArray.array;
  argv.forEach(function (path) { urls.addObject($.NSURL.fileURLWithPath(path)); });
  if (!pb.writeObjects(urls)) throw new Error("the pasteboard refused the files");
  // Bridged, not a JS number: compared as one, it never equals argv.length.
  var held = Number(pb.pasteboardItems.count);
  if (held !== argv.length) {
    throw new Error("the pasteboard holds " + held + " of " + argv.length + " files");
  }
  return "ok";
}`;

/**
 * `pbcopy` and `pbpaste` speak the locale's encoding, NOT UTF-8.
 *
 * With no `LANG` or `LC_CTYPE` in the environment they fall back to MacRoman,
 * and this server is spawned by the app with a minimal environment that has
 * neither. Every byte outside ASCII is then wrong in both directions:
 *
 *     echo 'em dash — here' | pbcopy   (no locale)  ->  pasted as 'em dash ‚Äî here'
 *     echo 'em dash — here' | pbcopy   (LC_CTYPE)   ->  pasted as 'em dash — here'
 *
 * MEASURED, macOS 27.0, and found in a live composer: a body pasted through this
 * path arrived with `—` turned into `‚Äî` — the UTF-8 bytes of the dash read back
 * as MacRoman. It is not a display artefact; that is what went into the draft,
 * and it would have gone into the mail. For anyone writing French or German it
 * mangles every accent, and the reader's own quotation marks with them.
 *
 * The read matters just as much, and is worse in kind. This clipboard is
 * BORROWED — read, overwritten, and put back — so a `pbpaste` that mis-decodes
 * hands back a corrupted copy of whatever the person had copied. Replying to a
 * mail should not quietly rewrite their clipboard.
 *
 * `LC_CTYPE=UTF-8` is the narrowest fix: it names the character encoding and
 * nothing else, so no message, date or sort order changes with it.
 */
export const clipboardEnv: NodeJS.ProcessEnv = { ...process.env, LC_CTYPE: "UTF-8" };

export const systemClipboard: Clipboard = {
  async read() {
    try {
      return (await run("/usr/bin/pbpaste", [], { env: clipboardEnv })).stdout;
    } catch {
      return null;
    }
  },
  async write(text) {
    const child = execFile("/usr/bin/pbcopy", [], { env: clipboardEnv });
    child.stdin?.end(text);
    await new Promise((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });
  },
  async writeFiles(paths) {
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", WRITE_FILES, ...paths]);
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
export const borrowClipboard = async <T>(
  clipboard: Clipboard,
  body: () => Promise<T>,
): Promise<T> => {
  const saved = await clipboard.read();
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

const withClipboard = <T>(clipboard: Clipboard, text: string, body: () => Promise<T>): Promise<T> =>
  borrowClipboard(clipboard, async () => {
    await clipboard.write(text);
    return body();
  });

/**
 * Wait for text to appear in the body, rather than reading for it once.
 *
 * Returns as soon as it matches, so the poll costs nothing when the tree is
 * already current. See `RENDER_TIMEOUT_MS` for the measurement that put it here.
 */
const awaitBody = async (
  lane: MailAxLane,
  body: string,
  expected: string,
  timeoutMs = RENDER_TIMEOUT_MS,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const after = await lane.bodyText(body);
    if (after !== null && containsText(after, expected)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS));
  }
};

const paste = async (
  lane: MailAxLane,
  clipboard: Clipboard,
  ref: ComposerRef,
  text: string,
  focusTimeoutMs: number | undefined,
  renderTimeoutMs: number | undefined,
): Promise<{ verified: boolean; landed: Landed }> => {
  const expected = text.length > VERIFY_CHARS ? text.slice(0, VERIFY_CHARS) : text;
  const sizeBefore = await lane.bodySize(ref.body);

  return withClipboard(clipboard, text, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const focused = await lane.paste(ref, focusTimeoutMs);
      if (focused && (await awaitBody(lane, ref.body, expected, renderTimeoutMs)))
        return { verified: true, landed: "yes" as const };
      // Something went in that cannot be matched, or the body can no longer be
      // read at all. Pasting again would put the reply in the draft twice, and
      // nothing here can undo that — so an UNKNOWN reading stops the retry just
      // as firmly as a changed one.
      if (compare(sizeBefore, await lane.bodySize(ref.body)) !== "no") break;
    }
    return { verified: false, landed: compare(sizeBefore, await lane.bodySize(ref.body)) };
  });
};

/** How many of these element names read as the file called `name`. */
const countFiles = (files: string[], name: string): number =>
  files.filter((file) => isFileNamed(file, name)).length;

/**
 * Wait for the files just pasted to read back in the sender's own text.
 *
 * Each requested name has to appear once more than it did before the paste, so
 * a draft already carrying a file of the same name is not taken as proof. The
 * sender's text must also read exactly as it did: a paste that replaced a
 * selection instead of landing at a caret would show the files and lose words.
 */
const awaitFiles = async (
  lane: MailAxLane,
  ref: ComposerRef,
  before: ComposerBody,
  names: string[],
  timeoutMs: number,
): Promise<ComposerBody | null> => {
  const wanted = squash(before.text);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await lane.composerBody(ref.body);
    if (
      shown &&
      squash(shown.text) === wanted &&
      names.every(
        (name) =>
          countFiles(shown.files, name) >=
          countFiles(before.files, name) + names.filter((n) => n === name).length,
      )
    )
      return shown;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, RENDER_POLL_MS));
  }
};

/**
 * Paste files at the composer's caret, and prove they arrived.
 *
 * File URLs on the pasteboard, then command-V, which is what pasting a file
 * copied in Finder does — MEASURED, macOS 27.0, and the only way to attach one
 * that leaves `content` alone (see OPEN_COMPOSER). The caller owns the caret
 * and the clipboard borrow; `before` is the composer as read just before.
 */
export const pasteFiles = async (
  lane: MailAxLane,
  clipboard: Clipboard,
  ref: ComposerRef,
  before: ComposerBody,
  paths: string[],
  focusTimeoutMs: number | undefined,
  timeoutMs: number,
): Promise<{ kind: "done"; shown: ComposerBody } | { kind: "unfocused" | "unconfirmed" }> => {
  await clipboard.writeFiles(paths);
  if (!(await lane.keys(ref, [{ key: "v", modifiers: ["command"] }], focusTimeoutMs)))
    return { kind: "unfocused" };
  const shown = await awaitFiles(
    lane,
    ref,
    before,
    paths.map((path) => basename(path)),
    timeoutMs,
  );
  return shown ? { kind: "done", shown } : { kind: "unconfirmed" };
};

/** How long files get to show up in a composer, which may be reading them in. */
const FILES_TIMEOUT_MS = 12_000;

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

/**
 * Compose natively: open and address over Apple Events, then paste the body
 * and any files into the window and read both back before saving or sending.
 *
 * Nothing here assigns `content`, which is what keeps a NEW message from going
 * out as one long quotation — see OPEN_COMPOSER.
 */
export const composeNatively = async (
  lane: MailAxLane,
  runner: OsascriptRunner,
  params: ComposeParams,
  opts: {
    /**
     * The composer was already opened by the caller, with the window titles
     * read just before it was — how a draft being recreated hands over the
     * replacement `STAGE_REPLACEMENT` made.
     */
    opened?: { subject: string; windowsBefore: string[] };
    clipboard?: Clipboard;
    /** Overridable so a test can pin the unconfirmed-send path without waiting for it. */
    composerTimeoutMs?: number;
    sendTimeoutMs?: number;
    /** Same, for the focus poll — see FOCUS_TIMEOUT_MS in `ax.ts`. */
    focusTimeoutMs?: number;
    /** Same, for the read-back poll — see RENDER_TIMEOUT_MS above. */
    renderTimeoutMs?: number;
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

  const reach = opts.opened ? { ok: true, windows: opts.opened.windowsBefore } : await lane.reach();
  if (!reach.ok) throw new Error(MailAxLane.grantMessage(params.mode));

  // A new message's subject is known before anything opens, so a clash is
  // refused while there is still nothing on screen to clean up.
  if (
    !opts.opened &&
    params.mode === "new" &&
    (reach.windows ?? []).includes(params.subject ?? "")
  ) {
    return {
      ok: false,
      subject: params.subject ?? "",
      bodyVerified: null,
      verifiedChars: 0,
      sent: false,
      note:
        `A window titled "${params.subject}" is already open in Mail, and the new message would ` +
        `carry the same title, so this path could not tell the two apart. Nothing was opened. ` +
        `Finish or close that window, or use another subject, then retry.`,
    };
  }

  // Files are pasted below, never handed to Mail's scripting object.
  const { attachments: files = [], ...toOpen } = params;
  const subject = opts.opened
    ? opts.opened.subject
    : ((await runner.run(OPEN_COMPOSER, toOpen)) as { subject: string }).subject;

  /**
   * A composer under this subject was open BEFORE this call opened one.
   *
   * The subject is the only identity the native half has, and it stops being
   * one the moment a composer from an earlier call survives — which is routine,
   * because nothing here ever closes one. The incident, 2026-09-10: Mail keeps
   * composers as tabs, the leftover was readable before the new one was, and
   * the title matched it first. ⌘V went to the composer Mail had in front, the
   * read-back went to the leftover, and a reply that was fine came back as
   * "SOMETHING DID land in it that could not be read back". With `sendNow` the
   * send shortcut would have named the leftover too: the wrong message sent,
   * which is the one failure this path is built to refuse.
   *
   * Refused rather than disambiguated. Handles are minted per call, so there is
   * nothing to tell the two apart by, and a guess here is a guess about which
   * message to send. The pre-flight list is the one moment the new composer
   * provably was not on screen.
   */
  if ((reach.windows ?? []).includes(subject)) {
    return {
      ok: false,
      subject,
      bodyVerified: null,
      verifiedChars: 0,
      sent: false,
      note:
        `A ${params.mode} window titled "${subject}" was already open in Mail before this call, ` +
        `most likely left by an earlier attempt, and this call has now opened another. With two ` +
        `under one title this path cannot tell which one it opened, so nothing was pasted, ` +
        `pressed or sent. The one just opened has no text above the quoted message. Close it, ` +
        `finish or discard the older one, then retry.` +
        interferenceNote(await watch.check()),
    };
  }

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
    const result = await paste(
      lane,
      clipboard,
      ref,
      params.body,
      opts.focusTimeoutMs,
      opts.renderTimeoutMs,
    );
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

  if (files.length > 0) {
    // The caret is at the end of the body just pasted, or at the top of a
    // composer that was given none — above a quoted original either way.
    const before = await lane.composerBody(ref.body);
    const pasted = before
      ? await borrowClipboard(clipboard, () =>
          pasteFiles(
            lane,
            clipboard,
            ref,
            before,
            files,
            opts.focusTimeoutMs,
            opts.renderTimeoutMs ?? FILES_TIMEOUT_MS,
          ),
        )
      : null;
    if (pasted?.kind !== "done") {
      if (await lane.composerGone(subject, 0))
        return vanished(bodyVerified === true ? { verified: true, chars: verifiedChars } : null);
      return {
        ok: false,
        degraded: true,
        subject,
        bodyVerified,
        verifiedChars,
        sent: false,
        note:
          `The ${params.mode} window for "${subject}" was composed` +
          (bodyVerified ? " and its body verified" : "") +
          `, but ` +
          (pasted === null
            ? `where its own text ends could not be read, so the files were not pasted. `
            : pasted.kind === "unfocused"
              ? `it would not take the keyboard for the files, so they were not pasted. `
              : `the files did not read back in it, with the text around them unchanged. `) +
          `It was NOT ${params.sendNow ? "sent" : "saved"}, and its window is still open in ` +
          `Mail: attach the files there, or close it without saving and retry.` +
          interferenceNote(await watch.check()),
      };
    }
  }

  // Nothing was pressed unless `finish` says so, and its two refusals must not
  // be reported alike. A composer that could not be raised has gone, the same
  // vanishing as above arriving one step later. A refused keystroke left the
  // composer where it was: the key names it, and the desktop server will not
  // post into somebody else's window when Mail does not come forward.
  const finished = await lane.finish(params.sendNow, ref);
  if (finished === "gone")
    return vanished(bodyVerified === true ? { verified: true, chars: verifiedChars } : null);
  if (finished === "refused") {
    return {
      ok: false,
      subject,
      bodyVerified,
      verifiedChars,
      sent: false,
      note:
        `The ${params.mode} for "${subject}" was composed, but Mail could not be brought to the ` +
        `front, so nothing was pressed and it was not ${params.sendNow ? "sent" : "saved"}. ` +
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
    // Read back out of the window, by name, before anything was pressed.
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
