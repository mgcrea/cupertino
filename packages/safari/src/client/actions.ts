import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PreconditionError } from "./errors.js";

/**
 * The command channel: how a tool asks a page to do something.
 *
 * ## Why this exists at all
 *
 * Reading a page needs one direction — the extension pushes captures and the
 * server reads them. ACTING on a page needs the other, and nothing in the
 * push-only design could carry it.
 *
 * ## Why it is files rather than any of the obvious alternatives
 *
 * `do JavaScript` is the Apple Event that reaches into a page, and this project
 * refuses it: the toggle it needs is global, permanent, unscoped and its state
 * cannot be read, so one click's worth of consent buys every tab forever.
 *
 * `dispatch message to extension` is the Apple Event that could wake the
 * extension instead, and it was MEASURED to be a bad channel independently of
 * that: it accepted an empty dictionary and a bogus extension identifier
 * without complaint and returned nothing, so a message that went nowhere is
 * indistinguishable from one that arrived.
 *
 * `SFSafariApplication.dispatchMessage` from the containing app reports errors
 * properly, but the app cannot reach a running server and would have to sit in
 * the path for every command.
 *
 * What is left needs no Apple Event, no new permission and no app: the appex's
 * own container is readable AND writable by any same-user process — measured in
 * both directions — so the server drops a command in `commands/`, the content
 * script's poll claims it, and the answer comes back in `results/`. The lane is
 * consented per website by Safari itself, which is the property none of the
 * alternatives have.
 *
 * ## What this costs, and what it cannot promise
 *
 * A command waits for the page to poll: about a second on a visible tab, up to
 * ten on a hidden one. That is the floor on every action tool's latency and it
 * is why the timeout is generous.
 *
 * At-most-once, never at-least-once. A command is deleted as it is handed out,
 * so a page that dies mid-click loses it — and the server reports a timeout
 * rather than retrying. A click that MIGHT have landed must never be repeated
 * automatically; that is how one purchase becomes two.
 */

/** One instruction for a page. */
export type Command = {
  id: string;
  action: "elements" | "click" | "fill" | "scroll" | "codes";
  /**
   * The page this is for. A command with no URL is answered by whichever
   * allowed page polls first, which is only ever right for a question about
   * "the page" — anything that ACTS names one.
   */
  url?: string | undefined;
  elementId?: string | undefined;
  text?: string | undefined;
  direction?: "up" | "down" | undefined;
  limit?: number | undefined;
  /**
   * Whether the page may return the value of a one-time-code field.
   *
   * Set from `allowCodes`, never from a tool argument — it is a standing choice
   * the user made in Settings, not something a caller talks its way into. A
   * CREDENTIAL field is withheld whether this is set or not.
   */
  includeCodes?: boolean | undefined;
  /** Unix seconds. The handler drops an expired command rather than running it. */
  expiresAt: number;
};

export type CommandResult = {
  id: string;
  completedAt: string;
  ok: boolean;
  data?: unknown;
  error?: string;
};

/** `commands/` and `results/` sit beside `pages/` in the appex container. */
export const channelDirectory = (pagesDirectory: string, name: string): string =>
  join(dirname(pagesDirectory), name);

const isResult = (v: unknown): v is CommandResult =>
  typeof v === "object" && v !== null && typeof (v as CommandResult).id === "string";

/**
 * Send one command and wait for the page to answer it.
 *
 * The waiting is a poll of a directory rather than anything cleverer, and it
 * matches the other side: the page is polling too, so a watcher would only be
 * waiting more efficiently for something that is not going to arrive sooner.
 */
export const runCommand = async (
  opts: {
    pagesDirectory: string;
    timeoutMs: number;
    /** Injected by tests. Real callers get the wall clock. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
  command: Omit<Command, "id" | "expiresAt">,
): Promise<CommandResult> => {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Hyphens only, because the handler refuses an id that is not alphanumeric —
  // it names a file on the other side and a traversal there would write outside
  // the container.
  const id = randomUUID();
  const commands = channelDirectory(opts.pagesDirectory, "commands");
  const results = channelDirectory(opts.pagesDirectory, "results");

  const deadline = now() + opts.timeoutMs;
  const entry: Command = {
    ...command,
    id,
    // The handler drops a command past its expiry rather than running it. Tied
    // to the same deadline the server gives up on, so a command cannot run
    // after the caller has been told it did not.
    expiresAt: Math.floor(deadline / 1000) + 1,
  };

  const file = join(commands, `${id}.json`);
  try {
    mkdirSync(commands, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  } catch (cause) {
    throw new PreconditionError(
      `Could not reach the Safari extension's command directory at ${commands}. The extension ` +
        `is part of Cupertino.app and Safari only loads it from a notarized copy, so this ` +
        `usually means the app has never run or a locally built copy is installed. ` +
        `(${String(cause)})`,
    );
  }

  const resultFile = join(results, `${id}.json`);
  while (now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resultFile, "utf8"));
      if (isResult(parsed)) {
        // Collected, so remove it. The answer describes a page and there is no
        // reason for it to outlive the call that asked for it.
        rmSync(resultFile, { force: true });
        return parsed;
      }
    } catch {
      // Not there yet, or half-written. Both are "keep waiting".
    }
    await sleep(150);
  }

  // Nobody claimed it, or nobody answered. Take the command back so it cannot
  // run against a page minutes later, long after the caller was told it timed
  // out — the expiry already covers this, and removing the file makes it true
  // immediately rather than at the next poll.
  rmSync(file, { force: true });

  throw new PreconditionError(
    `No page answered within ${Math.round(opts.timeoutMs / 1000)}s. The Cupertino extension has ` +
      `to be enabled in Safari AND allowed on this specific website — Safari grants it one site ` +
      `at a time — and the page has to be open. A hidden tab polls once every 10s, so a ` +
      `background tab can legitimately be slower than this. Check with apple_safari_diagnostics.`,
  );
};
