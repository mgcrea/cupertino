import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MailAxLane, squash } from "./ax.js";
import { awaitNewComposer } from "./compose.js";
import { applyEdits, applyHtmlEdits, htmlText, type Edit, type HtmlMatched } from "./edits.js";
import { locateSidecar, splitEmlx } from "./emlx.js";
import { COMMIT_REPLACEMENT, OPEN_COMPOSER } from "./jxa/write.js";
import {
  decodeEncodedWords,
  hasContent,
  headerValue,
  isAttachmentPart,
  parsePart,
  partBytes,
  partText,
  type MimePart,
} from "./mime.js";
import { withBusyRetry, type OsascriptRunner } from "./osascript.js";
import type { MessageRef } from "./ref.js";
import type { DraftFacts } from "./revise.js";

/**
 * Rebuild a saved draft whose window is closed (route B).
 *
 * Mail's scripting interface cannot edit a saved draft, and its window is the
 * only thing that can. So a closed draft is rebuilt from its own message file:
 *
 *   * a REPLY is reopened as a reply to its original, found by its
 *     `In-Reply-To`, so Mail writes the threading headers and the quote again
 *     itself; anything else is reopened as a new message;
 *   * the draft's own HTML (everything before Mail's `AppleOriginalContents`
 *     div) and its files are pasted into that window by the app's verb, which
 *     reads them back and saves;
 *   * the old draft is deleted only once the new one is found in Drafts by what
 *     it holds (`COMMIT_REPLACEMENT`).
 *
 * Every refusal leaves the original untouched, and every one that can be made
 * before a window opens is made before: a composer already open under the
 * subject, a forward, an original the index cannot find, an edit that does not
 * match once or that crosses formatting, a file that is not stored locally.
 * After the window opens, the regenerated quote must match the old one and the
 * recipients must be the ones asked for, or the window is left open, unsaved,
 * for the person to close.
 *
 * Message-ID and row id both change on every save of a draft (measured), so
 * neither is ever used to find the new one.
 */

/** How much of the new reply's quote to read back for the comparison. */
const QUOTE_CHARS = 20_000;

/** How much of the new text identifies the rebuilt draft in Drafts. */
const HEAD_CHARS = 120;

/** How long to wait for the new composer, as compose.ts does. */
const COMPOSER_TIMEOUT_MS = 8_000;

/** The class Mail gives the div that holds a reply's quoted original. */
const ORIGINAL_CONTENTS = /<div\b[^>]*\bclass\s*=\s*["']?[^"'>]*\bAppleOriginalContents\b/i;

/** An inline image the draft's HTML points at by Content-ID. Its file is re-attached instead. */
const CID_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']?cid:[^>]*>/gi;

/** Every `cid:` reference in HTML, the Content-ID captured. */
const CID_REF = /\bcid:([^"'\s>)]+)/gi;

/** A Content-ID as compared: unescaped, without angle brackets, lower case. */
const contentIdKey = (raw: string): string => {
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Not escaped after all.
  }
  return id.replace(/^<|>$/g, "").toLowerCase();
};

export type RebuildTarget = MessageRef;

/** Where the message a reply answers is, or why it could not be found. */
export type OriginalLookup =
  | { ref: MessageRef }
  /**
   * No index at all; no Message-ID column in it; no message with that
   * Message-ID; or one only in another account than the draft's, which a
   * reply would be sent from.
   */
  | { missing: "index" | "column" | "not-found" | "other-account" };

/**
 * Which of the rows carrying a Message-ID to reply to.
 *
 * Only one in the draft's own account: Mail sends a reply from the account the
 * original is in, so replying to a copy in another account would silently
 * change who the rebuilt draft is from. `place` maps an index mailbox rowid to
 * a scriptable account and mailbox, or undefined when it cannot.
 */
export const pickOriginal = (
  rows: { rowid: number; mailbox: number }[],
  place: (mailbox: number) => { accountUuid: string; mailbox: string } | undefined,
  accountUuid: string,
): OriginalLookup => {
  let elsewhere = false;
  for (const row of rows) {
    const where = place(row.mailbox);
    if (!where) continue;
    if (where.accountUuid === accountUuid) {
      return { ref: { accountUuid, mailbox: where.mailbox, id: row.rowid } };
    }
    elsewhere = true;
  }
  return { missing: elsewhere ? "other-account" : "not-found" };
};

export type RebuildDeps = {
  lane: MailAxLane;
  runner: OsascriptRunner;
  /** The saved draft's `.emlx`, or why it cannot be read. */
  messageFile: (
    target: RebuildTarget,
  ) => Promise<{ found: true; path: string } | { found: false; explain: string }>;
  /**
   * The message a reply answers, by the Message-ID its `In-Reply-To` names, in
   * the draft's account (see `pickOriginal`).
   */
  findOriginal: (messageId: string, accountUuid: string) => Promise<OriginalLookup>;
  /** Overridable so a test need not wait out the composer timeout. */
  composerTimeoutMs?: number;
};

export type RebuildOptions = {
  /** `DRAFT_FACTS`' answer for the draft. */
  facts: DraftFacts;
  /** A whole new body, pasted as plain text. */
  body?: string | undefined;
  /** Edits to the draft's own text, applied to its HTML's text. */
  edits?: Edit[] | undefined;
  /** A new subject. */
  subject?: string | undefined;
  /** Files to add after the draft's own, absolute and already gated. */
  attachments?: string[] | undefined;
};

/** What the saved draft holds, read from its message file. */
type SavedDraft = {
  subject: string | null;
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  inReplyTo: string | null;
  references: string | null;
  /** The body content of every HTML part, joined; null when there is none. */
  html: string | null;
  plain: string | null;
  files: MimePart[];
};

/**
 * The addresses in an address header. Commas inside quoted names (`"Rivers,
 * Cy" <cy@…>`) do not split; an entry with angle brackets gives what is in them.
 */
const addresses = (value: string | null): string[] => {
  if (!value) return [];
  const text = decodeEncodedWords(value);
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (const ch of text) {
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    if (ch === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  entries.push(current);
  return entries
    .map((entry) => {
      const inAngles = /<([^>]*)>/.exec(entry);
      return (inAngles ? (inAngles[1] ?? "") : entry).trim();
    })
    .filter((a) => a.includes("@"));
};

/** The first `<id>` in a header that names messages, brackets kept. */
const firstMessageId = (value: string | null): string | null => {
  if (!value) return null;
  const bracketed = /<[^<>\s]+>/.exec(value);
  if (bracketed) return bracketed[0];
  const bare = value.trim().split(/\s+/)[0];
  return bare ? `<${bare}>` : null;
};

/** What sits inside an HTML document's body; the whole text when it has none. */
const bodyContent = (html: string): string => {
  const open = /<body\b[^>]*>/i.exec(html);
  let inner = open ? html.slice(open.index + open[0].length) : html;
  const close = inner.search(/<\/body\s*>/i);
  if (close !== -1) inner = inner.slice(0, close);
  if (!open) {
    inner = inner
      .replace(/<head\b[\s\S]*?<\/head\s*>/i, "")
      .replace(/<\/?html\b[^>]*>/gi, "")
      .replace(/<!doctype[^>]*>/i, "");
  }
  return inner;
};

const readDraft = (path: string): SavedDraft => {
  const root = parsePart(splitEmlx(readFileSync(path)));
  const htmlParts: string[] = [];
  let plain: string | null = null;
  const files: MimePart[] = [];
  const walk = (part: MimePart) => {
    if (part.contentType.startsWith("multipart/")) {
      for (const child of part.parts) walk(child);
      return;
    }
    if (isAttachmentPart(part)) {
      files.push(part);
      return;
    }
    // Mail splits a draft's HTML around the files in it, one document per piece.
    if (part.contentType === "text/html") htmlParts.push(bodyContent(partText(part)));
    else if (part.contentType === "text/plain" && plain === null) plain = partText(part);
  };
  walk(root);

  const header = (name: string) => headerValue(root.headers, name);
  const subject = header("subject");
  return {
    subject: subject === null ? null : decodeEncodedWords(subject).trim(),
    from: addresses(header("from"))[0] ?? null,
    to: addresses(header("to")),
    cc: addresses(header("cc")),
    bcc: addresses(header("bcc")),
    inReplyTo: firstMessageId(header("in-reply-to")),
    references: header("references"),
    html: htmlParts.length > 0 ? htmlParts.join("") : null,
    plain,
    files,
  };
};

/**
 * A file name that cannot leave the directory it is written to: the last path
 * component only, no leading dots, no control characters, and a number added
 * when the name is already taken.
 */
const safeName = (raw: string | null, taken: Set<string>): string => {
  const last = (raw ?? "").split(/[/\\]/).pop() ?? "";
  const printable = [...last].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
  const cleaned = printable.join("").replace(/^\.+/, "").trim();
  const base = cleaned || "attachment";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
    const dot = base.lastIndexOf(".");
    name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`;
  }
  taken.add(name.toLowerCase());
  return name;
};

/** Text compared as the composer's verb compares it: no file marks, whitespace folded. */
const fold = (text: string): string => squash(text.replaceAll("￼", ""));

/**
 * Is the new reply's quote the old draft's?
 *
 * Both folded. The composer's is cut at `QUOTE_CHARS`; when it was, only the
 * opening both have is compared.
 */
const quoteMatches = (shown: string, shownTruncated: boolean, saved: string): boolean => {
  const a = fold(shown);
  const b = fold(saved);
  if (shownTruncated) return a.length > 0 && b.startsWith(a);
  return a === b;
};

const addressKey = (list: string[]): string =>
  list
    .map((x) => x.toLowerCase())
    .toSorted()
    .join("\n");

const sameAddresses = (a: string[], b: string[]): boolean => addressKey(a) === addressKey(b);

export const rebuildDraft = async (
  deps: RebuildDeps,
  target: RebuildTarget,
  opts: RebuildOptions,
): Promise<Record<string, unknown>> => {
  const { lane, runner } = deps;
  const { facts } = opts;
  const draft = {
    subject: facts.subject,
    isReply: facts.isReply,
    attachments: facts.attachments,
    recipientCount: facts.recipientCount,
  };
  const refuse = (
    capability: string,
    reason: string,
    hint: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    replaced: false,
    degraded: true,
    method: "rebuild",
    capability,
    draft,
    reason,
    hint,
    ...extra,
  });
  const untouched = "Nothing was opened and the draft was not changed.";

  // ─── 1. Preflight: nothing is opened until all of this passes ────────────

  const reach = await lane.reach();
  if (!reach.ok) {
    return refuse(
      "accessibility",
      MailAxLane.grantMessage("replacement"),
      MailAxLane.nothingWritten,
    );
  }

  const clash = (await lane.composers()).filter((c) => c.subject === facts.subject);
  if (clash.length > 0) {
    const handles = clash.map((c) => c.composer).join(", ");
    return refuse(
      "composer",
      `A compose window titled "${facts.subject}" is open in Mail (${handles}). It may be this ` +
        `draft's own window, and rebuilding the draft beside it would leave two windows under ` +
        `one title, either of which could be saved over the other. ${untouched}`,
      "Close that window first (save it if it is this draft and you changed it), then try again.",
      { composers: clash.map((c) => ({ composer: c.composer, subject: c.subject })) },
    );
  }

  if (target.mailbox.toLowerCase() !== facts.draftsMailbox.toLowerCase()) {
    return refuse(
      "draft",
      `That message is in ${target.mailbox}, not in ${facts.draftsMailbox}. Only an unsent draft ` +
        `can be rebuilt. ${untouched}`,
      "Pass the ref of a draft.",
    );
  }

  const file = await deps.messageFile(target);
  if (!file.found) {
    return refuse(
      "file",
      `The saved draft is rebuilt from its message file, and it could not be read: ` +
        `${file.explain} ${untouched}`,
      "Open the draft in Mail and edit it there, or run apple_mail_diagnostics.",
    );
  }
  let saved: SavedDraft;
  try {
    saved = readDraft(file.path);
  } catch (error) {
    return refuse(
      "file",
      `The saved draft's message file could not be parsed ` +
        `(${error instanceof Error ? error.message : String(error)}). ${untouched}`,
      "Open the draft in Mail and edit it there.",
    );
  }

  // A forward carries References and no In-Reply-To. Mail's forward command
  // needs the message forwarded, which nothing here can tell, so it is refused.
  if (saved.references !== null && saved.inReplyTo === null) {
    return refuse(
      "forward",
      `This draft is a forward (it names earlier messages but answers none), and a forward ` +
        `cannot be rebuilt: what was forwarded is not known from here. ${untouched}`,
      "Open the draft in Mail and edit it there.",
    );
  }

  // The sender's own part, and the quoted original after it.
  let own: { html: string | null; text: string };
  let savedQuote = "";
  // The files the quoted original shows (its images, by Content-ID) are the
  // original's, and the new reply quotes them again itself.
  const quoted = new Set<string>();
  if (saved.html !== null) {
    const at = saved.html.search(ORIGINAL_CONTENTS);
    const ownHtml = (at === -1 ? saved.html : saved.html.slice(0, at)).replaceAll(CID_IMAGE, "");
    if (at !== -1) {
      const quoteHtml = saved.html.slice(at);
      savedQuote = htmlText(quoteHtml);
      for (const ref of quoteHtml.matchAll(CID_REF)) quoted.add(contentIdKey(ref[1] ?? ""));
    }
    own = { html: ownHtml, text: htmlText(ownHtml) };
  } else if (saved.inReplyTo === null) {
    own = { html: null, text: saved.plain ?? "" };
  } else {
    return refuse(
      "format",
      `This reply draft was saved without an HTML part, so its own text cannot be told apart ` +
        `from the quote below it. ${untouched}`,
      "Open the draft in Mail and edit it there.",
    );
  }

  const ownFiles = saved.files.filter(
    (part) => part.contentId === null || !quoted.has(contentIdKey(part.contentId)),
  );

  // A quoted original with nothing saying what it answers: rebuilt as a new
  // message, the original would be silently lost.
  if (saved.inReplyTo === null && savedQuote !== "") {
    return refuse(
      "forward",
      `This draft holds a quoted or forwarded original but does not name the message it ` +
        `answers, so rebuilding it as a new message would drop that original. ${untouched}`,
      "Open the draft in Mail and edit it there.",
    );
  }

  // What goes into the new window.
  let fill: { html?: string; body: string };
  if (opts.body !== undefined) {
    fill = { body: opts.body };
  } else if (opts.edits !== undefined) {
    let edited: HtmlMatched;
    if (own.html === null) {
      const plain = applyEdits(opts.edits, own.text);
      edited = plain.kind === "ok" ? { kind: "ok", html: "", text: plain.result } : plain;
    } else {
      edited = applyHtmlEdits(opts.edits, own.html);
    }
    switch (edited.kind) {
      case "ok":
        fill = own.html === null ? { body: edited.text } : { html: edited.html, body: edited.text };
        break;
      case "notFound":
        return refuse(
          "edits",
          `This edit's text is not in the draft's own text. ${untouched}`,
          "Read the draft again and quote its text exactly; line breaks do not matter.",
          { find: edited.find },
        );
      case "ambiguous":
        return refuse(
          "edits",
          `This edit's text is in the draft's own text ${edited.count} times, so which one to ` +
            `change is unknown. ${untouched}`,
          "Quote more of the text around it, so it matches once.",
          { find: edited.find, count: edited.count },
        );
      case "overlapping":
        return refuse(
          "edits",
          `Two edits change overlapping text. ${untouched}`,
          "Merge them into one edit, or make them touch separate text.",
        );
      case "spans":
        return refuse(
          "edits",
          `This edit's text runs across formatting (part of it is bold, a link, or in another ` +
            `paragraph), and a change across formatting can only be made in the open window, ` +
            `where it can be seen. ${untouched}`,
          "Open the draft in Mail and edit it there, or quote only text with one formatting.",
          { find: edited.find },
        );
    }
  } else {
    fill = own.html === null ? { body: own.text } : { html: own.html, body: own.text };
  }

  // The verb needs something to put in: text, or files.
  if (fill.body.trim() === "" && ownFiles.length + (opts.attachments ?? []).length === 0) {
    return refuse(
      "edits",
      `The rebuilt draft would hold no text and no files, so there is nothing to put in it. ` +
        untouched,
      "Pass a body.",
    );
  }

  // The original a reply answers.
  let original: MessageRef | null = null;
  if (saved.inReplyTo !== null) {
    const found = await deps.findOriginal(saved.inReplyTo, target.accountUuid);
    if ("missing" in found) {
      const why =
        found.missing === "not-found"
          ? `no message with the Message-ID ${saved.inReplyTo} it answers is in Mail's search index`
          : found.missing === "other-account"
            ? `the message it answers (${saved.inReplyTo}) was found only in another account ` +
              `than the draft's, and a reply to it there would be sent from that account`
            : found.missing === "column"
              ? `Mail's search index on this Mac keeps no Message-ID to look ${saved.inReplyTo} up by`
              : `Mail's search index cannot be read, and it is how the message it answers ` +
                `(${saved.inReplyTo}) is found`;
      return refuse(
        "original",
        `This draft is a reply, and it can only be rebuilt as a reply to its original, so that ` +
          `it stays in the thread. But ${why}. ${untouched}`,
        "Open the draft in Mail and edit it there.",
        { inReplyTo: saved.inReplyTo },
      );
    }
    original = found.ref;
  }

  // ─── 2. The files, then the window ────────────────────────────────────────

  const dir = await mkdtemp(join(tmpdir(), "cupertino-rebuild-"));
  try {
    const kept: string[] = [];
    const taken = new Set<string>();
    for (const part of ownFiles) {
      let bytes: Buffer | null = partBytes(part);
      if (!hasContent(bytes)) {
        const sidecar = part.filename ? locateSidecar(file.path, target.id, part.filename) : null;
        bytes = sidecar ? readFileSync(sidecar) : null;
      }
      if (!bytes) {
        return refuse(
          "attachments",
          `The draft's file "${part.filename ?? "unnamed"}" is not stored on this Mac, so it ` +
            `could not be carried over. ${untouched}`,
          "Open the draft in Mail, which downloads it, and try again; or edit it there.",
        );
      }
      const path = join(dir, safeName(part.filename, taken));
      await writeFile(path, bytes);
      kept.push(path);
    }
    const files = [...kept, ...(opts.attachments ?? [])];

    const subject = opts.subject ?? facts.subject;
    const recipients = { to: saved.to, cc: saved.cc, bcc: saved.bcc };
    // Taken right before Mail is asked: the new composer is the handle absent from it.
    const before = await lane.composers();
    if (before.some((c) => c.subject === facts.subject)) {
      return refuse(
        "composer",
        `A compose window titled "${facts.subject}" opened while this was preparing. ${untouched}`,
        "Close that window first, then try again.",
      );
    }
    const params: Record<string, unknown> = original
      ? {
          mode: "reply",
          accountUuid: original.accountUuid,
          mailbox: original.mailbox,
          id: original.id,
          replyToAll: false,
          subject,
          recipients,
        }
      : {
          mode: "new",
          accountUuid: target.accountUuid,
          subject,
          senderAddress: saved.from,
          to: saved.to,
          cc: saved.cc,
          bcc: saved.bcc,
          recipients,
        };
    const kind = original ? "reply" : "message";
    const leftOpen = (where: string) =>
      `The original draft was not changed. The new ${kind} window (${where}) is open in Mail ` +
      "and was not saved.";
    const closeIt = "Close it WITHOUT saving, then open the draft in Mail and edit it there.";

    // From the moment Mail is asked for a window, a failure leaves one open:
    // every throw below becomes a refusal that names it.
    let opened: { subject: string; recipients?: { to: string[]; cc: string[]; bcc: string[] } };
    let handle: string | null = null;
    let answer: Record<string, unknown>;
    let shown: string;
    // When the new draft's first save can be no earlier than (its Date header).
    const openedAt = Date.now();
    const hasText = fill.body.trim() !== "";
    try {
      opened = (await runner.run(OPEN_COMPOSER, params)) as {
        subject: string;
        recipients?: { to: string[]; cc: string[]; bcc: string[] };
      };
      const found = await awaitNewComposer(
        lane,
        before,
        deps.composerTimeoutMs ?? COMPOSER_TIMEOUT_MS,
        opened.subject,
      );
      if (found === null || "ambiguous" in found) {
        return refuse(
          "composer",
          found === null
            ? `Mail was asked to open a ${kind} for "${opened.subject}", and no new window under ` +
                "that title was readable in time. Nothing was filled. The original draft was not " +
                "changed."
            : `Mail was asked to open a ${kind} for "${opened.subject}", and ` +
                `${found.ambiguous.length} new windows under that title appeared ` +
                `(${found.ambiguous.join(", ")}), so which one is it cannot be told. Nothing was ` +
                "filled. The original draft was not changed.",
          `Look for an empty ${kind} window in Mail and close it without saving.`,
        );
      }
      handle = found.handle;

      const wanted = recipients;
      const got = opened.recipients;
      if (
        !got ||
        !sameAddresses(got.to, wanted.to) ||
        !sameAddresses(got.cc, wanted.cc) ||
        !sameAddresses(got.bcc, wanted.bcc)
      ) {
        return refuse(
          "recipients",
          `Mail did not take the draft's recipients: it was given ${JSON.stringify(wanted)} and ` +
            `holds ${JSON.stringify(got ?? null)}. Nothing was filled. ${leftOpen(handle)}`,
          closeIt,
          { composer: handle },
        );
      }

      // ─── 3. The quote Mail wrote must be the one the draft had ──────────────

      if (original) {
        const listed = (await lane.composers(QUOTE_CHARS)).find((c) => c.composer === handle);
        if (!listed || listed.quoted === null) {
          return refuse(
            "quote",
            `The new reply's quote could not be read back, so it cannot be compared with the ` +
              `draft's. Nothing was filled. ${leftOpen(handle)}`,
            closeIt,
            { composer: handle },
          );
        }
        if (!quoteMatches(listed.quote ?? "", listed.quoteTruncated === true, savedQuote)) {
          return refuse(
            "quote",
            `The quote Mail wrote into the new reply is not the one the draft holds (the ` +
              `original may have changed, or Mail quotes differently now), so the rebuilt draft ` +
              `would not be the same message. Nothing was filled. ${leftOpen(handle)}`,
            closeIt,
            {
              composer: handle,
              draftQuote: fold(savedQuote).slice(0, 200),
              newQuote: fold(listed.quote ?? "").slice(0, 200),
            },
          );
        }
      }

      // ─── 4. Fill and save, read back by the app ─────────────────────────────

      answer = await lane.editComposer({
        composer: handle,
        ...(hasText && fill.html !== undefined ? { html: fill.html } : {}),
        ...(hasText ? { body: fill.body } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        save: true,
      });
      if (answer.replaced !== true) {
        const reason = typeof answer.reason === "string" ? answer.reason : "The fill was refused.";
        return {
          ...answer,
          method: "rebuild",
          composer: handle,
          reason: `${reason} ${leftOpen(handle)}`,
          hint: closeIt,
        };
      }
      if (answer.saved !== true) {
        return refuse(
          "confirmation",
          `The new ${kind} was filled and read back, but it was not saved, so it cannot be ` +
            `confirmed. ${leftOpen(handle).replace(" and was not saved.", ".")}`,
          "Save it in Mail and delete the old draft yourself, or close it without saving.",
          { composer: handle },
        );
      }
      // Only what the app read back counts as what the draft now holds.
      if (typeof answer.text !== "string") {
        return refuse(
          "confirmation",
          `The app reported the new ${kind} filled and saved but gave back no reading of its ` +
            `text, and nothing is reported or confirmed that was not read back. ` +
            leftOpen(handle).replace(" and was not saved.", "."),
          closeIt,
          { composer: handle },
        );
      }
      shown = answer.text;
    } catch (error) {
      const what = error instanceof Error ? error.message : String(error);
      return refuse(
        handle === null ? "composer" : "confirmation",
        `The rebuild stopped after Mail was asked to open the new ${kind}: ${what}. ` +
          (handle === null
            ? `The original draft was not changed. A new ${kind} window may be open in Mail ` +
              "(handle unknown) and was not saved."
            : leftOpen(handle)),
        closeIt,
        { composer: handle ?? "unknown" },
      );
    }

    // ─── 5. Confirm the new draft, then delete the old one ──────────────────

    let committed: Record<string, unknown>;
    try {
      committed = await withBusyRetry(() =>
        runner.run<Record<string, unknown>>(COMMIT_REPLACEMENT, {
          ...target,
          subject: opened.subject,
          originalSubject: facts.subject,
          inReplyTo: saved.inReplyTo,
          head: fold(shown).slice(0, HEAD_CHARS),
          before: facts.siblings ?? [target.id],
          openedAt,
          files: Array.isArray(answer.filesAdded) ? answer.filesAdded : [],
        }),
      );
    } catch (error) {
      return refuse(
        "confirmation",
        `The new ${kind} was filled, read back and saved, but Drafts could not be asked to ` +
          `confirm it (${error instanceof Error ? error.message : String(error)}). THE ORIGINAL ` +
          `WAS NOT DELETED, so two drafts now exist under "${opened.subject}".`,
        "Look in Drafts and delete the one you do not want. Nothing here will.",
        { composer: handle },
      );
    }

    // Not confirmed: its own refusal, which says what is left where.
    if (committed.replaced !== true) {
      return { ...committed, method: "rebuild", composer: handle, draft };
    }
    const filesAdded = Array.isArray(answer.filesAdded) ? answer.filesAdded : [];
    return {
      ...committed,
      method: "rebuild",
      subject: opened.subject,
      composer: handle,
      threadingKept: original !== null,
      inReplyTo: saved.inReplyTo,
      attachmentsKept: kept.length,
      attachmentsAdded: (opts.attachments ?? []).length,
      filesAdded,
      recipientCount: saved.to.length + saved.cc.length + saved.bcc.length,
      ...(opts.body !== undefined ? { bodyLength: opts.body.length } : {}),
      bodyVerified: hasText,
      text: shown,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
