/**
 * MessageRef — the one identifier any tool accepts or returns.
 *
 * A bare row id is not enough: the same integer means different messages in
 * different mailboxes, and `messages.byId` is only resolvable inside a mailbox
 * (a global `Mail.messages.byId(...)` fails with -1728). Handing the model a
 * naked integer would let it address the wrong message; the ref carries the
 * mailbox with it so that cannot happen.
 *
 * Wire format:  m1:<accountUuid>/<mailboxPath>#<id>
 *
 * The `m1:` prefix is deliberate. If the Phase 0 spike ever shows that the
 * SQLite ROWID is not the AppleScript message id, resolution has to fall back
 * to the RFC 5322 Message-ID — and a versioned prefix makes that an additive
 * change instead of a silent reinterpretation of every ref already in a
 * conversation.
 */

import { PreconditionError } from "./errors.js";

export const REF_VERSION = "m1";

export type MessageRef = {
  accountUuid: string;
  mailbox: string;
  id: number;
};

const UUID_RE = /^[0-9A-Fa-f-]{8,64}$/;

export const encodeRef = (ref: MessageRef): string =>
  `${REF_VERSION}:${ref.accountUuid}/${encodeURIComponent(ref.mailbox)}#${ref.id}`;

export const decodeRef = (raw: string): MessageRef => {
  const m = /^([a-z0-9]+):([^/]+)\/(.*)#(\d+)$/.exec(raw);
  if (!m) {
    throw new PreconditionError(
      `Malformed message ref "${raw}". Refs come from the search and list tools — ` +
        `construct them from those results rather than by hand.`,
      { expected: `${REF_VERSION}:<accountUuid>/<mailbox>#<id>` },
    );
  }
  const [, version, accountUuid, mailboxRaw, idRaw] = m;
  if (version !== REF_VERSION) {
    throw new PreconditionError(
      `Unsupported message ref version "${version}". This server issues "${REF_VERSION}" refs; ` +
        `re-run the search to get current ones.`,
    );
  }
  if (!accountUuid || !UUID_RE.test(accountUuid)) {
    throw new PreconditionError(`Message ref "${raw}" does not carry a valid account id.`);
  }
  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PreconditionError(`Message ref "${raw}" does not carry a valid message id.`);
  }
  return { accountUuid, mailbox: decodeURIComponent(mailboxRaw ?? ""), id };
};

/** Group refs by mailbox so a batch of them costs one Apple Event per mailbox, not per message. */
export const groupRefsByMailbox = (refs: MessageRef[]): Map<string, MessageRef[]> => {
  const groups = new Map<string, MessageRef[]>();
  for (const ref of refs) {
    const key = `${ref.accountUuid}/${ref.mailbox}`;
    const existing = groups.get(key);
    if (existing) existing.push(ref);
    else groups.set(key, [ref]);
  }
  return groups;
};
