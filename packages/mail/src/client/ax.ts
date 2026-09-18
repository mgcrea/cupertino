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
 * ignores. The clipboard is still borrowed and still put back.
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

/**
 * How long to keep asking the composer's body to take the focus.
 *
 * **Readable is not ready, and the gap is not zero.** `findComposer` returns as
 * soon as the window and its web area can be READ; the body cannot take the
 * keyboard for about another 140 ms after that. Measured over three fresh
 * composers, driving the real driver:
 *
 *     web area readable at 395 ms   focus -> false at 421 ms, true at 560 ms
 *     web area readable at 637 ms   focus -> false at 671 ms, true at 812 ms
 *     web area readable at 640 ms   focus -> false at 665 ms, true at 805 ms
 *
 * The first attempt failed on every trial. Without a poll here that is a
 * coin-flip resting on how long the surrounding round trips happen to take —
 * `compose.ts` retries the whole paste once, for an unrelated reason, and that
 * retry was silently carrying this.
 *
 * Which is `docs/desktop.md`'s most expensive lesson arriving in a new place:
 * *the control must be polled for, not waited for*. It was written about a
 * window's chrome appearing before its content; this is the same shape one level
 * down, where the content is there and the focus is not.
 */
const FOCUS_TIMEOUT_MS = 2_000;

/** Between focus attempts. Each one is a round trip, so this is not a spin. */
const FOCUS_POLL_MS = 100;

/**
 * How many leading blocks to classify as quoted or not.
 *
 * `composerBody` only needs the FIRST quoted block — everything from it down is
 * the original — and on a reply that is the attribution line, two or three
 * blocks in. The bound is therefore generous rather than tight, and its job is
 * the failure case: a body whose boundary is not inside it is reported as
 * unknown rather than guessed at, because guessing "no quote" would offer the
 * whole quoted original up for replacement.
 */
const BLOCK_SCAN_MAX = 60;

/**
 * How many times to ask for a block's quote level before giving up on it.
 *
 * A busy WebKit view answers "did not answer in time … retry" rather than
 * refusing, and it says so straight after a paste — which is exactly when this
 * is read. See `#quoteLevel`.
 */
const QUOTE_READ_TRIES = 3;
const QUOTE_READ_PAUSE_MS = 120;

/** One keystroke, as `apple_desktop_key` takes it. */
type Keystroke = { key: string; modifiers?: string[] };

/**
 * How many keystrokes go in one `apple_desktop_run`.
 *
 * The verb caps a run at 25 steps. Staying under it here means a burst is
 * chunked rather than refused, which matters because the number of strokes is
 * the number of lines in somebody's draft.
 */
const KEY_BURST = 20;

type Element = {
  handle: string;
  role: string;
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
type Windows = { windows?: { handle: string; index: number; title?: string | null }[] };

export type ComposerRef = { window: string; body: string; index: number };

/**
 * A composer's own text, told apart from the original it quotes.
 *
 * MEASURED, macOS 27.0 (build 26A428), on a reply composer: `AXBlockQuoteLevel`
 * reads 0 on every block the sender wrote and 1 on every block from the
 * attribution line — `On <date>, <who> wrote:` — down, including the quoted
 * message's images and links. The split is exact, which is what makes replacing
 * a reply's text without touching its quote possible at all.
 *
 * **A FORWARD is quoted too**, and that was worth measuring rather than assuming:
 * a forward reads as prose with a `Begin forwarded message:` header and nothing
 * about it looks like a quotation, but that line and everything under it read
 * level 1 on the same build. Had they read 0 the whole forwarded message would
 * have counted as the sender's own text and been offered up for replacement.
 *
 * `blocks` counts the top-level elements above that boundary, NOT rendered
 * lines: a paragraph that wraps is one block and two lines. So it is a floor for
 * how many times the selection has to be extended, never a target — see
 * `selectOwnText` in `revise.ts`, which converges upwards from it and verifies
 * the answer before anything is replaced.
 */
export type ComposerBody = {
  /** What the sender wrote, blocks joined by newlines. "" when they wrote nothing. */
  text: string;
  /** Top-level elements above the quote. */
  blocks: number;
  /** Whether a quoted original follows. */
  quoted: boolean;
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
   * The sentence to say when the composer cannot be reached natively.
   *
   * One grant rather than two, and none of the "quit Cupertino and open it
   * again" ritual the System Events path needs — that exists because a node
   * child started before the grant does not inherit it, and this driver runs in
   * the app itself.
   */
  static grantMessage(mode: string): string {
    return (
      `Cupertino cannot read Mail's windows, which is the only route into a ${mode} composer, ` +
      `so it was not started and nothing was written. This needs Accessibility for ` +
      `Cupertino.app in System Settings > Privacy & Security > Accessibility. If the app is ` +
      `already listed, toggle it off and on — the grant goes stale when the bundle is ` +
      `reinstalled. Run apple_mail_diagnostics to check; it names the windows it can see.`
    );
  }

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

  /**
   * Every composer currently under this subject, in window order.
   *
   * `findComposer` takes the first match because it is looking for a window it
   * just opened. Rewriting one that was already there is the opposite problem:
   * the caller has to know whether the subject picks out ONE composer, because
   * two under one title cannot be told apart — handles are minted per call —
   * and replacing the body of the wrong one destroys what somebody wrote. So
   * this returns the list and lets `revise.ts` refuse on its length.
   *
   * Does not poll. Nothing here opened a window, so there is nothing to wait
   * for: the composer either is on screen or is not.
   */
  async findComposers(subject: string): Promise<ComposerRef[]> {
    const listed = (await this.#call("list_windows", {
      bundleId: MAIL_BUNDLE,
      includeTitles: true,
    })) as Windows;
    const found: ComposerRef[] = [];
    for (const win of listed.windows ?? []) {
      if ((win.title ?? "") !== subject) continue;
      const body = await this.#bodyOf(win.index);
      if (body) found.push({ window: win.handle, body, index: win.index });
    }
    return found;
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
   * The accessible text under the body, which is what a person would see.
   *
   * One call rather than a bounded walk. The System Events version reads a
   * parent at a time and stops at a character budget because every node costs an
   * Apple Event; here the whole subtree comes back in one answer with each
   * element's value already on it.
   *
   * Returns null when the body cannot be reached at all — a different answer
   * from "", and the two must stay apart: one means we are blind, the other
   * means the composer is empty.
   */
  async bodyText(body: string): Promise<string | null> {
    try {
      const tree = (await this.#call("expand", {
        handle: body,
        detail: "all",
        maxDepth: BODY_DEPTH,
      })) as Tree;
      return (tree.elements ?? [])
        .map((el) => el.value)
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .join("\n");
    } catch {
      return null;
    }
  }

  /**
   * How many elements the body holds.
   *
   * A fingerprint, not a reading. Taken before and after a paste it answers "did
   * anything at all land", which is what decides whether pasting again is safe:
   * a paste that landed and cannot be read must NOT be repeated, or the reply
   * ends up in the draft twice with no way to undo it from here.
   *
   * `matched` rather than the returned length, because the response is byte
   * capped and a long quoted message will truncate — a fingerprint taken from a
   * truncated list would compare two different bounds rather than two states.
   *
   * **Null when the body cannot be read at all, and that is the whole point.**
   * This returned -1 for a failed read, and the caller compared it as a count.
   * A composer that CLOSES takes its element handle with it — the driver answers
   * `staleHandle` — so a body that had gone in perfectly read back as -1 and
   * compared unequal to the size before, which is the signature of "something
   * landed that cannot be matched". A reply sent by hand mid-call was reported
   * as a body that never went in, with a warning against the retry that was in
   * fact the safe move. Blind and different are not the same answer, exactly as
   * `bodyText` above insists, and this is where that was forgotten.
   */
  async bodySize(body: string): Promise<number | null> {
    try {
      const tree = (await this.#call("expand", {
        handle: body,
        detail: "all",
        maxDepth: BODY_DEPTH,
      })) as Tree;
      return tree.matched ?? (tree.elements ?? []).length;
    } catch {
      return null;
    }
  }

  /**
   * Focus the body and paste, and say whether the focus took.
   *
   * Focus is not a raise: a raise orders a window forward inside Mail while the
   * keystroke goes wherever the focus actually is. Both are needed, and the
   * focus is read back because an element can report itself focusable and not
   * take it.
   *
   * **What "read back" has to mean here, learned the hard way.** Mail's composer
   * web area answers `AXFocused: false` while holding the keyboard — measured
   * over 1.2 s without ever flipping, with a command-V landing in it the whole
   * time. `apple_desktop_focus` used to return that flag, so this guard refused
   * to press command-V and every native reply came back "Nothing landed in it"
   * for a body that would have gone in. The driver now answers from the
   * APPLICATION's `AXFocusedUIElement`, which is what the window server routes
   * keystrokes by and so cannot disagree with where one will land.
   *
   * The guard itself stays. Posting command-V without knowing where the focus is
   * types into whatever happens to be in front, and that is the user's window.
   *
   * **A composer that has gone answers false rather than throwing.** Both handles
   * die with the window, so raising or focusing one afterwards is a `staleHandle`
   * — and letting that escape turns a describable failure into a bare channel
   * error with no note attached, on the one path whose whole job is to say what
   * happened. False is the honest answer: the focus was not taken, so nothing was
   * typed.
   */
  async paste(ref: ComposerRef, focusTimeoutMs = FOCUS_TIMEOUT_MS): Promise<boolean> {
    return this.keys(ref, [{ key: "v", modifiers: ["command"] }], focusTimeoutMs);
  }

  /**
   * Focus the composer's body and send a burst of keystrokes to it.
   *
   * What `paste` was, generalised, because replacing a reply's text without
   * touching its quote is a sequence rather than one key: the caret goes to the
   * top of the document, the selection is walked down to the end of the
   * sender's own text, and only then is anything pasted over it.
   *
   * Sent through `apple_desktop_run` so a burst is ONE round trip. That is not
   * only speed: every stroke in a run is checked before the first one is posted,
   * and the run stops at the first failure, so a selection cannot be left
   * half-extended by a refusal partway through.
   *
   * Each stroke names the body's handle, so the desktop server brings Mail
   * forward before posting and refuses rather than typing into whatever the
   * person at the keyboard just switched to.
   */
  async keys(
    ref: ComposerRef,
    strokes: Keystroke[],
    focusTimeoutMs = FOCUS_TIMEOUT_MS,
  ): Promise<boolean> {
    if (strokes.length === 0) return true;
    try {
      await this.#call("raise_window", { handle: ref.window });
      await this.activate();
      const deadline = Date.now() + focusTimeoutMs;
      for (;;) {
        const focused = (await this.#call("focus", { handle: ref.body })) as { focused?: boolean };
        if (focused.focused === true) break;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, FOCUS_POLL_MS));
      }
      for (let at = 0; at < strokes.length; at += KEY_BURST) {
        const chunk = strokes.slice(at, at + KEY_BURST);
        if (chunk.length === 1) {
          const only = chunk[0] as Keystroke;
          await this.#call("key", { ...only, handle: ref.body });
          continue;
        }
        await this.#call("run", {
          steps: chunk.map((stroke) => ({ tool: "key", ...stroke, handle: ref.body })),
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the composer's own text, stopping where the quoted original begins.
   *
   * Null when the boundary cannot be established, and that answer is the point.
   * Two ways it happens: the body cannot be read at all, or no quoted block was
   * found within `BLOCK_SCAN_MAX` of a body that has more blocks than that.
   * Reporting the second as "no quote, all of it is yours" would hand the whole
   * quoted message to a caller that is about to replace what it is given.
   *
   * The quote level is read per element rather than from the tree, because the
   * tree's field set is chosen for addressing controls and does not carry it.
   * Affordable only natively — 0.2 ms a read against System Events' 47 ms — and
   * bounded anyway, since the loop stops at the first quoted block and on a
   * reply that is two or three in.
   */
  /**
   * One block's quote level, retried, because "busy" is not "no".
   *
   * MEASURED, macOS 27.0: on a composer quoting a long thread, a single
   * `AXBlockQuoteLevel` read came back `Reading AXBlockQuoteLevel of 'e8320' did
   * not answer in time. The app may be busy; retry.` — WebKit still digesting
   * the paste that had just landed in it. One such timeout used to fail the
   * whole read, which failed the verification, which refused a rewrite that had
   * in fact gone in perfectly and left the composer unsaved.
   *
   * The app says to retry, so it retries. Null is kept for a read that never
   * answers, because the caller must not mistake it for level zero.
   */
  async #quoteLevel(handle: string): Promise<number | null> {
    for (let attempt = 0; attempt < QUOTE_READ_TRIES; attempt += 1) {
      try {
        const read = (await this.#call("get_attribute", {
          handle,
          attribute: "AXBlockQuoteLevel",
        })) as { value?: unknown };
        return typeof read.value === "number" ? read.value : 0;
      } catch {
        if (attempt + 1 >= QUOTE_READ_TRIES) return null;
        await new Promise((resolve) => setTimeout(resolve, QUOTE_READ_PAUSE_MS));
      }
    }
    return null;
  }

  async composerBody(body: string): Promise<ComposerBody | null> {
    let tree: Tree;
    try {
      tree = (await this.#call("expand", {
        handle: body,
        detail: "all",
        maxDepth: BODY_DEPTH,
      })) as Tree;
    } catch {
      return null;
    }
    const elements = tree.elements ?? [];
    const starts = elements.flatMap((el, at) => (el.depth === 0 ? [at] : []));

    let boundary: number | null = null;
    for (let block = 0; block < starts.length && block < BLOCK_SCAN_MAX; block += 1) {
      const handle = elements[starts[block] as number]?.handle;
      if (!handle) continue;
      const level = await this.#quoteLevel(handle);
      // Unknown, not zero. A block whose level could not be read cannot be
      // called the sender's own — that is the reading that decides what may be
      // replaced, and guessing it is how a quoted original gets overwritten.
      if (level === null) return null;
      if (level > 0) {
        boundary = block;
        break;
      }
    }

    // Every block read was the sender's own. Believable only if the scan saw
    // the whole body: a truncated list or one longer than the bound leaves the
    // boundary unknown, which is not the same as there being none.
    const truncated = tree.truncated !== undefined || (tree.matched ?? 0) > elements.length;
    if (boundary === null) {
      if (truncated || starts.length > BLOCK_SCAN_MAX) return null;
      boundary = starts.length;
    }

    // A block's text is its own value plus its descendants' — inline runs on one
    // line, so they join with nothing, and the blocks themselves with newlines.
    const lines: string[] = [];
    for (let block = 0; block < boundary; block += 1) {
      const from = starts[block] as number;
      const to = starts[block + 1] ?? elements.length;
      lines.push(
        elements
          .slice(from, to)
          .map((el) => el.value)
          .filter((v): v is string => typeof v === "string")
          .join(""),
      );
    }
    return { text: lines.join("\n"), blocks: boundary, quoted: boundary < starts.length };
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
   */
  async finish(sendNow: boolean, ref: ComposerRef): Promise<"pressed" | "gone" | "refused"> {
    try {
      await this.#call("raise_window", { handle: ref.window });
      await this.activate();
    } catch {
      return "gone";
    }
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
   */
  async composerGone(subject: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const listed = (await this.#call("list_windows", {
        bundleId: MAIL_BUNDLE,
        includeTitles: true,
      })) as Windows;
      if (!(listed.windows ?? []).some((w) => (w.title ?? "") === subject)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Select everything in the body, for the quote strip. */
  async selectAll(): Promise<void> {
    await this.#call("key", { key: "a", modifiers: ["command"] });
  }

  /**
   * The deepest quote level anywhere in the body; 0 once the citation is gone.
   *
   * `AXBlockQuoteLevel` is not in the tree's field set, which is chosen for
   * addressing controls — so it is read one element at a time. That is
   * affordable only natively: 343 elements at 0.2 ms is well under a tenth of a
   * second, where the same walk through System Events would be sixteen.
   */
  async maxQuoteLevel(body: string): Promise<number> {
    const tree = (await this.#call("expand", {
      handle: body,
      detail: "all",
      maxDepth: BODY_DEPTH,
    })) as Tree;
    let worst = 0;
    for (const el of tree.elements ?? []) {
      const read = (await this.#call("get_attribute", {
        handle: el.handle,
        attribute: "AXBlockQuoteLevel",
      })) as { value?: unknown };
      const level = typeof read.value === "number" ? read.value : 0;
      if (level > worst) worst = level;
    }
    return worst;
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
