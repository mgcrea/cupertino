import type { ArrivalRow, ArrivalSource } from "@mgcrea/mcp-apple-core";

import { renderInstant } from "./dates.js";
import { encodeChatRef, encodeMessageRef } from "./ref.js";
import type { MessagesStore } from "./store.js";

/**
 * Messages' arrival source over chat.db.
 *
 * Metadata only: a `MessageArrival` has no `text`, even when the row's column is
 * set. The body stays behind `apple_messages_get_message`.
 *
 * `message` is AUTOINCREMENT, so the ROWID is the cursor and never repeats; `key`
 * is the guid, which is also what the public ref carries.
 *
 * What the source drops for every watch (`excluded`): my own messages and
 * tapbacks. Messages has no per-watch scope, so `scope` stays undefined.
 */

/** No `text`: a message's text is its body, and watch reads carry metadata only. */
export type MessageArrival = ArrivalRow & {
  /** The message's public ref, as `get_message` and search emit it. */
  id: string;
  /** The chat's public ref, as listing tools emit it. */
  chat: string | null;
  handle: string | null;
  /** As search and range render it; null when the row has no date. */
  date: string | null;
};

export type MessagesArrivalSourceOptions = { store: MessagesStore };

export class MessagesArrivalSource implements ArrivalSource<MessageArrival> {
  readonly #store: MessagesStore;

  constructor(opts: MessagesArrivalSourceOptions) {
    this.#store = opts.store;
  }

  head(): number {
    return this.#store.headRowid();
  }

  since(after: number, limit: number): MessageArrival[] {
    return this.#store.arrivalsAfter(after, limit).map((r) => {
      // The store projects NULL for a column this schema lacks, and `#toRow` turns
      // a missing or zero reaction type into null, so both checks degrade to
      // "not excluded" the way `range()` does.
      const excluded = r.isFromMe || r.reactionType !== null;
      return {
        cursor: r.rowid,
        key: r.guid,
        sender: r.handle?.trim().toLowerCase() || null,
        ...(excluded ? { excluded: true } : {}),
        id: encodeMessageRef(r.guid),
        chat: r.chatGuid ? encodeChatRef(r.chatGuid) : null,
        handle: r.handle,
        date: renderInstant(r.sentAt),
      };
    });
  }
}
