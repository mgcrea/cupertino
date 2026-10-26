import {
  openAxChannel,
  watchInterference,
  type AxChannel,
  type InterferenceWatch,
} from "@mgcrea/mcp-apple-core";

import { MAIL_SURFACE } from "./errors.js";

/**
 * Mail's composer, driven through Cupertino's native Accessibility driver.
 *
 * ## What this replaces, and why it is worth replacing
 *
 * `jxa/core.ts` reaches the same composer through System Events. That path
 * works, and it costs two things this one does not:
 *
 *   * **A second TCC grant.** UI scripting through System Events needs
 *     Automation-to-System-Events *on top of* Accessibility — two grants, in two
 *     System Settings panes, to reach one window. `composerGrantMessage` is ten
 *     lines long because of it.
 *   * **47.4 ms per attribute read**, against 0.202 ms called natively. Which is
 *     why `findBodyArea` is bounded at depth 6 and `composerBodyText` carries a
 *     character budget: both are cost control, not correctness.
 *
 * ## What it deliberately does NOT change
 *
 * **The body is still pasted.** Assigning `content` is dropped by Mail, and so
 * is setting AXValue on the web area, "which reports itself settable first and
 * then does nothing" — measured in `jxa/write.ts`, and independently in
 * `docs/desktop.md`, which found the same trap on the first text field of all
 * seven apps it probed. A native driver does not make an app honour a write it
 * ignores. What changed is who pastes: the app's `mail_composer_edit` verb does,
 * bringing Mail forward for a moment, borrowing the clipboard and restoring it,
 * and reading the result back before it answers. This file only asks.
 *
 * **Nothing reports a draft ready on the strength of a write being accepted.**
 * That is the failure this whole path is shaped around: a draft correct in every
 * visible respect except the words, reported as a success.
 *
 * ## The fallback is not optional
 *
 * `openAxChannel` returns null when this server was not started by Cupertino —
 * the npm packages are published artifacts and are run by hand. Every function
 * here is reached only after `available()`, and `client/mail.ts` keeps the
 * System Events path for when it is false.
 */

const MAIL_BUNDLE = "com.apple.mail";

/** Mail's composer body is a WebKit view, not a text field. */
const BODY_ROLE = "AXWebArea";

/**
 * How deep to look for the body.
 *
 * `findBodyArea` uses 6 and says the bound is there to survive the cost. Cost is
 * no longer the reason, so this is only a guard against walking a composer that
 * holds a deeply nested quoted message — the web area itself sits near the top.
 */
const BODY_DEPTH = 8;

type Element = {
  handle: string;
  role: string;
  subrole?: string | null;
  id?: string | null;
  name?: string | null;
  value?: string | null;
  depth: number;
};

type Tree = {
  elements?: Element[];
  matched?: number;
  returned?: number;
  truncated?: string;
};
type Windows = {
  windows?: { handle: string; index: number; title?: string | null; main?: boolean }[];
};

export type ComposerRef = { window: string; body: string; index: number };

/** One open composer, as the app's `mail_composers` verb reports it. */
export type NativeComposer = {
  /**
   * The handle, `mc-<n>`. It names this composer, tab or window, for as long
   * as it lives, and its number is never reused. One thing moves it: Mail
   * re-mints every tab button when a tab opens or closes, and a tab's handle
   * is then re-bound to the live tab of its window carrying its title, when
   * that title was unique both before and after. That tab may be another
   * draft, which `rebound` says.
   */
  composer: string;
  /**
   * True while the handle was re-bound to a tab that may be another draft
   * (the person closed the first and opened, or retitled, another under its
   * title). An edit by the handle alone is refused; one by ref, which sends
   * the draft's text as `expectHead`, goes through when the text matches. It
   * clears once a listing reads the tab's own text as what the handle was
   * last listed with. Absent from an app that predates it.
   */
  rebound?: boolean;
  /** A tab's subject is its title. */
  subject: string;
  /**
   * Null (or absent) for a window of its own. With "Prefer tabs: Always" Mail
   * opens every composer as a tab of one window, and Accessibility shows only
   * the selected tab's content: `"selected"` reads as a window does,
   * `"background"` carries its subject and nothing else, because reading the
   * rest would mean switching tabs and a listing never does.
   */
  tab?: "selected" | "background" | null;
  /** To and Cc names together. Null for a background tab. */
  recipients: string[] | null;
  /** The window Mail considers main: the one in front, when Mail is. */
  main?: boolean;
  /** The account picker's value, `Name – address`; null when there is none. */
  from?: string | null;
  to?: string[] | null;
  cc?: string[] | null;
  /** Null when the Bcc field is not shown, which is not the same as empty. */
  bcc?: string[] | null;
  /** The opening of the quoted original; null when none, or none was asked for. */
  quote?: string | null;
  quoteTruncated?: boolean;
  /** The sender's own text, blocks joined by newlines. Null for a background tab. */
  text: string | null;
  /** Null when a quote level was unreadable, and for a background tab. */
  quoted: boolean | null;
  /** Named files in the own text. Empty for a background tab, which is not read. */
  files: string[];
};

export type EditComposerArgs = {
  composer: string;
  body?: string;
  html?: string;
  edits?: { find: string; replace: string }[];
  attachments?: string[];
  save?: boolean;
  expectHead?: string;
};

export type ReachReport = {
  ok: boolean;
  /** `accessibility` when Mail's windows cannot be read; null when they can. */
  reason: "accessibility" | null;
  windows: string[] | null;
};

export class MailAxLane {
  readonly #channel: AxChannel;

  private constructor(channel: AxChannel) {
    this.#channel = channel;
  }

  /** Null when this server is not hosted by Cupertino — see the note above. */
  static open(env: NodeJS.ProcessEnv = process.env): MailAxLane | null {
    const channel = openAxChannel(MAIL_SURFACE, env);
    return channel ? new MailAxLane(channel) : null;
  }

  close(): void {
    this.#channel.close();
  }

  /** Start watching for someone using the Mac during a sequence. */
  watch(): InterferenceWatch {
    return watchInterference(this.#channel);
  }

  #call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.#channel.call({ tool: `apple_desktop_${tool}`, args });
  }

  /** Every open composer, with its handle and own text. */
  async composers(quoteChars?: number): Promise<NativeComposer[]> {
    const result = (await this.#call(
      "mail_composers",
      quoteChars === undefined ? {} : { quoteChars },
    )) as { composers?: NativeComposer[] };
    return result.composers ?? [];
  }

  /**
   * Edit a composer in one verified native step. The verb's JSON comes back
   * verbatim: a refusal is an answer, not an error. A failure of the call itself
   * (bad arguments, Accessibility not trusted) throws, as every `#call` does.
   */
  async editComposer(args: EditComposerArgs): Promise<Record<string, unknown>> {
    return (await this.#call("mail_composer_edit", { ...args })) as Record<string, unknown>;
  }

  /**
   * Can this process read Mail's windows, right now?
   *
   * Asked BEFORE a composer is opened, keeping the ordering `jxa/write.ts`
   * established: the old shape opened a window, failed the read, and left an
   * empty reply on screen with an error telling the user to close it by hand.
   *
   * Ground truth is the functional read, never a trusted flag. One bundle
   * identifier can hold several Accessibility entries — one per path and
   * signature it has been granted at — so the flag can answer for a different
   * row from the one the request resolves against. A window list that comes back
   * named is proof regardless of what the flag says.
   *
   * Mail with no windows is legitimate — everything closed to the menu bar — so
   * an empty list is not evidence of anything and must not refuse a reply that
   * would have worked.
   */
  async reach(): Promise<ReachReport> {
    try {
      const result = (await this.#call("list_windows", {
        bundleId: MAIL_BUNDLE,
        includeTitles: true,
      })) as Windows;
      const titles = (result.windows ?? []).map((w) => w.title ?? null);
      return { ok: true, reason: null, windows: titles.filter((t): t is string => t !== null) };
    } catch {
      return { ok: false, reason: "accessibility", windows: null };
    }
  }

  /**
   * The sentence to say when the app is there but Mail's windows cannot be read.
   *
   * Said once, in one wording, by every draft entry point (compose, edit,
   * rebuild, list open drafts), so whoever meets it from any of them is led to
   * the same switch. `mode` is accepted so callers can keep naming what they
   * were doing, and is deliberately not part of the text.
   *
   * One grant rather than two, and none of the "quit Cupertino and open it
   * again" ritual the System Events path needs: that exists because a node
   * child started before the grant does not inherit it, and this driver runs in
   * the app itself. A server Cupertino did not start has no lane to be refused
   * on, and says so in its own words.
   */
  static grantMessage(_mode?: string): string {
    return (
      "Cupertino needs Accessibility to write Mail drafts. Turn it on for Cupertino in " +
      "System Settings › Privacy & Security › Accessibility (if it is already listed, toggle " +
      "it off and on: the grant goes stale when the app is reinstalled), then run " +
      "apple_mail_diagnostics."
    );
  }

  /** What a WRITE refusal adds to `grantMessage`; a read has no use for it. */
  static readonly nothingWritten = "Nothing was written.";

  /**
   * Poll for the composer window, and for its body.
   *
   * Polled rather than waited for, which `docs/desktop.md` records as the trap
   * that cost it the most: a window's chrome appearing is not its content being
   * ready, so no fixed settle time is correct. Cheap here — a bounded walk is
   * milliseconds.
   *
   * The subject is the identity, and requiring a body area with it rejects the
   * main window and the drafts list. It is an identity only because `compose.ts`
   * refuses when a composer under the same subject was already open before the
   * call: a leftover from an earlier attempt matches here just as well, and is
   * readable first. Counting windows does not work: Mail closes
   * and reuses windows around a compose, so the count comes back unchanged with
   * a new composer on screen.
   */
  async findComposer(subject: string, timeoutMs: number): Promise<ComposerRef | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listed = (await this.#call("list_windows", {
        bundleId: MAIL_BUNDLE,
        includeTitles: true,
      })) as Windows;
      for (const win of listed.windows ?? []) {
        if ((win.title ?? "") !== subject) continue;
        const body = await this.#bodyOf(win.index);
        if (body) return { window: win.handle, body, index: win.index };
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async #bodyOf(windowIndex: number): Promise<string | null> {
    const tree = (await this.#call("ui_tree", {
      bundleId: MAIL_BUNDLE,
      window: windowIndex,
      detail: "all",
      maxDepth: BODY_DEPTH,
    })) as Tree;
    return (tree.elements ?? []).find((el) => el.role === BODY_ROLE)?.handle ?? null;
  }

  /** Bring Mail to the front. A synthetic keystroke lands in whatever is frontmost. */
  async activate(): Promise<void> {
    await this.#call("activate", { bundleId: MAIL_BUNDLE });
  }

  /**
   * Send the composer, or save it as a draft.
   *
   * A keyboard shortcut rather than the Send button, and that is a correctness
   * choice rather than a shortcut in the other sense: the button's name is
   * localised — a French Mail says "Envoyer" — while command-shift-D is the same
   * on every Mac. Addressing it by name would have worked on the machine it was
   * written on and nowhere else.
   *
   * This is the step that replaces `draft.send()`, and the reason it had to. A
   * JXA object reference cannot outlive the `osascript` process that made it,
   * and this flow now spans two processes: Apple Events opens the composer, and
   * everything after is native. Re-finding the draft to send it was the
   * alternative and is worse — drafts are discovered by subject, so two with the
   * same one are indistinguishable, on the single path whose named failure is
   * sending the wrong thing.
   *
   * **The window is raised again first, and the answer says whether that took.**
   * The focus is only known to be in the composer at the moment of the paste;
   * between the read that verifies the body and this keystroke the person at the
   * keyboard can move the foreground, and command-shift-D would then be posted
   * into whatever they moved to. Re-raising costs two round trips and closes
   * that window.
   *
   * The keystroke also names the composer's window, which closes the gap that
   * remains between the re-raise and the key: the desktop server brings Mail
   * forward again and refuses rather than posting into something else.
   *
   * Only `"pressed"` means anything was pressed. The other two answers are both
   * refusals, and they are kept apart because they mean opposite things to the
   * person reading the result:
   *
   *   * `"gone"`: the composer could not be raised. Its handle died with the
   *     window, so somebody sent or closed it.
   *   * `"refused"`: raised, but the keystroke was refused because Mail would
   *     not come forward. The composer is still on screen, unsent.
   *
   * Posting a send into an unknown foreground is the one outcome worth refusing
   * outright, which is why neither of them throws.
   *
   * `ready`, when given, is asked once Mail is in front, right before the key,
   * and the key is pressed only on a yes: `"unready"` means nothing was
   * pressed. A window holding several drafts as tabs sends or saves the one it
   * SHOWS, so the caller checks that is still its draft. A check that throws
   * is a no.
   */
  async finish(
    sendNow: boolean,
    ref: ComposerRef,
    ready?: () => Promise<boolean>,
  ): Promise<"pressed" | "gone" | "refused" | "unready"> {
    try {
      await this.#call("raise_window", { handle: ref.window });
      await this.activate();
    } catch {
      return "gone";
    }
    if (ready && !(await ready().catch(() => false))) return "unready";
    try {
      await this.#call(
        "key",
        sendNow
          ? { key: "d", modifiers: ["command", "shift"], handle: ref.window }
          : { key: "s", modifiers: ["command"], handle: ref.window },
      );
    } catch {
      return "refused";
    }
    return "pressed";
  }

  /**
   * Has the composer for this subject gone?
   *
   * How a send is confirmed. Mail closes the window when it accepts one, so the
   * window still being there means it did not go — which is checked rather than
   * assumed, because nothing in this path may report success on the strength of
   * a keystroke having been delivered.
   *
   * A tab Mail is not showing is no window's title, so the composers listed as
   * tabs are asked too: a draft in a background tab is still there. When they
   * cannot be listed, the window titles decide alone, as they always did.
   */
  async composerGone(subject: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listed = (await this.#call("list_windows", {
        bundleId: MAIL_BUNDLE,
        includeTitles: true,
      })) as Windows;
      const tabs = await this.composers().catch(() => [] as NativeComposer[]);
      if (
        !(listed.windows ?? []).some((w) => (w.title ?? "") === subject) &&
        !tabs.some((c) => c.tab != null && c.subject === subject)
      )
        return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * Does the pasted text appear at the top of what the composer now holds?
 *
 * Whitespace-squashed on both sides: the accessible text of a WebKit view breaks
 * lines where the rendering does, not where the source did.
 */
export const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export const containsText = (haystack: string, needle: string): boolean => {
  const n = squash(needle);
  if (!n) return true;
  return squash(haystack).includes(n);
};
