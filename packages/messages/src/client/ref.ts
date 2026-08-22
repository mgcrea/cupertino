import { AppleAutomationError } from "@mgcrea/mcp-apple-core";

/**
 * Refs for messages and chats.
 *
 * ## Why a GUID rather than a rowid
 *
 * Both exist, and the rowid is faster to look up. The GUID wins anyway because
 * **rowids are reused.** SQLite hands a deleted row's id to the next insert
 * unless the table is `AUTOINCREMENT`, and Messages deletes constantly — every
 * "delete this conversation" frees a block of them. A ref handed to a model in
 * one turn and used two turns later would then resolve to a DIFFERENT message,
 * with no error anywhere. That is the failure this project keeps designing
 * against: plausible, wrong, and silent.
 *
 * The GUID is also what Apple itself joins on — `associated_message_guid` for
 * reactions, `thread_originator_guid` for replies — so it is the identifier the
 * schema already treats as stable.
 *
 * ## Why `m1:` and `mc1:`
 *
 * `c1:` is Calendar's, `r1:` is Reminders', `k1:` is Contacts'. A ref that
 * decodes under two surfaces would be worse than one that decodes under none,
 * so each prefix is claimed once and the version digit keeps a future scheme
 * change additive.
 */

export const MESSAGE_REF_VERSION = "m1";
export const CHAT_REF_VERSION = "mc1";

/**
 * A GUID is opaque and not always a UUID — measured shapes include
 * `iMessage;-;+15551234567` on chats, which carries semicolons and a phone
 * number. So the tail is greedy and nothing inside it is parsed.
 */
const MESSAGE_PATTERN = /^m1:(.+)$/;
const CHAT_PATTERN = /^mc1:(.+)$/;

const otherSurface = (raw: string): string => {
  if (raw.startsWith("c1:")) return " That one is a Calendar event ref.";
  if (raw.startsWith("r1:")) return " That one is a Reminders ref.";
  if (raw.startsWith("k1:")) return " That one is a Contacts ref.";
  if (raw.startsWith("mc1:")) return " That one is a CHAT ref — this wants a message ref.";
  if (raw.startsWith("m1:")) return " That one is a MESSAGE ref — this wants a chat ref.";
  return "";
};

export class InvalidMessageRefError extends AppleAutomationError {
  override readonly name = "InvalidMessageRefError";

  constructor(raw: string, want: "message" | "chat") {
    const shape = want === "message" ? '"m1:<guid>"' : '"mc1:<guid>"';
    super(
      `"${raw}" is not a ${want} ref. Refs come from apple_messages_* results and look like ` +
        `${shape} — they are opaque and must not be constructed by hand.${otherSurface(raw)}`,
      { ref: raw },
    );
  }
}

export const encodeMessageRef = (guid: string): string => `${MESSAGE_REF_VERSION}:${guid}`;
export const encodeChatRef = (guid: string): string => `${CHAT_REF_VERSION}:${guid}`;

export const decodeMessageRef = (raw: string): string => {
  const m = MESSAGE_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidMessageRefError(raw, "message");
  return m[1];
};

export const decodeChatRef = (raw: string): string => {
  const m = CHAT_PATTERN.exec(raw.trim());
  if (!m?.[1]) throw new InvalidMessageRefError(raw, "chat");
  return m[1];
};
