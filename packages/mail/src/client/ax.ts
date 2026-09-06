import { openAxChannel, type AxChannel } from "@mgcrea/mcp-apple-core";

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

type Element = {
  handle: string;
  role: string;
  name?: string | null;
  value?: string | null;
  depth: number;
};

type Tree = { elements?: Element[]; matched?: number; truncated?: string };
type Windows = { windows?: { handle: string; index: number; title?: string | null }[] };

export type ComposerRef = { window: string; body: string; index: number };

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
   * main window and the drafts list. Counting windows does not work: Mail closes
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
   */
  async bodySize(body: string): Promise<number> {
    try {
      const tree = (await this.#call("expand", {
        handle: body,
        detail: "all",
        maxDepth: BODY_DEPTH,
      })) as Tree;
      return tree.matched ?? (tree.elements ?? []).length;
    } catch {
      return -1;
    }
  }

  /**
   * Focus the body and paste, and say whether the focus took.
   *
   * Focus is not a raise: a raise orders a window forward inside Mail while the
   * keystroke goes wherever the focus actually is. Both are needed, and the
   * focus is read back because an element can report itself focusable and not
   * take it.
   */
  async paste(ref: ComposerRef): Promise<boolean> {
    await this.#call("raise_window", { handle: ref.window });
    await this.activate();
    const focused = (await this.#call("focus", { handle: ref.body })) as { focused?: boolean };
    if (focused.focused !== true) return false;
    await this.#call("key", { key: "v", modifiers: ["command"] });
    return true;
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
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export const containsText = (haystack: string, needle: string): boolean => {
  const n = squash(needle);
  if (!n) return true;
  return squash(haystack).includes(n);
};
