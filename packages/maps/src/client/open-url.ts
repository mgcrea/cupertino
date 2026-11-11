import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * How a place is opened in Maps, so Maps mints the place record a write copies.
 *
 * `maps://?q=<query>` goes through LaunchServices, not Apple Events and not
 * Accessibility, and Maps resolves the place and files it in Recents with a
 * full record attached (`place-source.ts`). Injected so tests never launch an
 * application.
 */
export type OpenUrl = (url: string) => void | Promise<void>;

export const defaultOpenUrl: OpenUrl = async (url) => {
  // `-g` so the user's foreground app is not stolen. `timeout` because a wedged
  // LaunchServices would otherwise block forever, and this runs inside a tool
  // call somebody is waiting on. Asynchronous, like the poll that follows it:
  // this is a stdio server, and a synchronous wait here is a server that cannot
  // read its stdin, answer another call or honour a cancellation meanwhile.
  await promisify(execFile)("/usr/bin/open", ["-g", url], { timeout: 10_000 });
};
