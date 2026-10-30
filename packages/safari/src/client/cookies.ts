import { writeConfinedFile } from "@mgcrea/mcp-apple-core";

import type { CommandResult } from "./actions.js";
import { PreconditionError } from "./errors.js";
import type { NetRun } from "./network.js";

/**
 * Reading a site's cookies, HttpOnly ones included, so a signed-in session can
 * be handed to a local tool.
 *
 * ## Why through the extension, and why its background worker
 *
 * Nothing else here can see an HttpOnly cookie. A page script cannot, by
 * definition; the network tools mask `cookie` and `set-cookie` and record only
 * the page's own fetch and XHR calls; Safari's cookie store is a file behind
 * Full Disk Access. `browser.cookies` in the extension's background worker
 * does see them, and needs the same per-site grant the rest of the lane does.
 *
 * The worker answers the command itself, out of the poll's reply, so a value
 * never enters the page's process — which is the one place an HttpOnly cookie
 * is meant never to be. See `background.js`.
 *
 * ## Why the values never come back inline
 *
 * A tool result goes into the conversation, and a login cookie is the login:
 * whoever holds it is signed in. So a listing carries metadata only — and asks
 * the worker for no value at all, so none crosses the channel — and the values
 * are written, by name, to a 0600 file the caller names. The result says where,
 * which names and how many bytes.
 *
 * ## Why two gates
 *
 * `allowCookies` registers the tool; `cookieHosts` decides which pages it may
 * read. The flag alone would let any agent take any session in the browser, so
 * the list is checked here, before any command is written, and an empty list
 * refuses everything.
 */

/** One cookie as the tool reports it. Deliberately no `value`. */
export type CookieInfo = {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  /** ISO 8601, or null for a session cookie. */
  expires: string | null;
};

export type CookiesInput = {
  url: string;
  names?: string[] | undefined;
  saveAs?: string | undefined;
  overwrite?: boolean | undefined;
};

export type CookiesResult = {
  url: string;
  host: string;
  count: number;
  cookies: CookieInfo[];
  saved?: { path: string; bytes: number; names: string[] };
};

/** A cookie as `background.js` files it: the API's fields, a value only when asked. */
type RawCookie = {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  session?: unknown;
  expirationDate?: unknown;
};

/** Two or more labels of letters, digits and hyphens: "yahoo.com", never "com". */
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/**
 * The host list as it will be matched, and what was set aside.
 *
 * Lower-cased, with a leading or trailing dot dropped, so ".Yahoo.com" is
 * "yahoo.com". An entry with no dot is set aside rather than matched: "com"
 * would allow every .com site, which is not what anyone listing hosts means.
 * There is no public-suffix list here, so "co.uk" is NOT caught; the docs say
 * so. Set-aside entries are reported in diagnostics rather than failing the
 * server, because a server that will not start is invisible to the agent that
 * would have read why.
 */
export const cookieHostRules = (entries: string[]): { hosts: string[]; ignored: string[] } => {
  const hosts: string[] = [];
  const ignored: string[] = [];
  for (const entry of entries) {
    const host = entry.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
    if (DOMAIN.test(host)) {
      if (!hosts.includes(host)) hosts.push(host);
    } else {
      ignored.push(entry.trim());
    }
  }
  return { hosts, ignored };
};

/** The domain itself or any subdomain of it, on a label boundary. */
const hostAllowed = (host: string, hosts: string[]): boolean =>
  hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

/**
 * A value that cannot sit on one `Cookie:` line. A `;` would split it into a
 * second pair and a line break would end the header; a browser should never
 * hold one, so meeting one is refused rather than escaped.
 */
// oxlint-disable-next-line eslint/no-control-regex -- control characters are what it refuses.
const UNSAFE = /[;\u0000-\u001f\u007f]/;

const toInfo = (raw: RawCookie): CookieInfo => ({
  name: String(raw.name),
  domain: typeof raw.domain === "string" ? raw.domain : "",
  path: typeof raw.path === "string" ? raw.path : "/",
  secure: raw.secure === true,
  httpOnly: raw.httpOnly === true,
  sameSite: typeof raw.sameSite === "string" ? raw.sameSite : null,
  expires:
    raw.session === true || typeof raw.expirationDate !== "number"
      ? null
      : new Date(raw.expirationDate * 1000).toISOString(),
});

/**
 * What a refusal from the worker means. An extension from before this command
 * hands it to the page, whose runner does not know it.
 */
const explain = (result: CommandResult): PreconditionError =>
  new PreconditionError(
    /Unknown action/.test(result.error ?? "")
      ? "The Safari extension that answered is older than this server and does not know the " +
          "cookies command. Update Cupertino, approve the extension again in Safari (it now asks " +
          "for the cookies permission), and reload the tab."
      : (result.error ?? "The extension could not read this page's cookies."),
  );

export async function readCookies(
  run: NetRun,
  settings: { allowWrites: boolean; downloadDir: string; cookieHosts: string[] },
  input: CookiesInput,
): Promise<CookiesResult> {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new PreconditionError(
      `"${input.url}" is not a URL. Pass the page's URL as apple_safari_list_tabs reports it.`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PreconditionError(`Only an http or https page has cookies to read here.`);
  }
  const host = parsed.hostname.toLowerCase();

  // The second gate, checked before anything is written to the channel: a
  // refused host must cost the browser nothing and tell it nothing.
  const { hosts } = cookieHostRules(settings.cookieHosts);
  if (!hostAllowed(host, hosts)) {
    throw new PreconditionError(
      `Reading cookies on ${host} is not allowed: it is not covered by APPLE_SAFARI_COOKIE_HOSTS ` +
        (hosts.length === 0
          ? "(empty, so no site's cookies are readable). "
          : `(${hosts.join(", ")}). `) +
        `The user can add the site's registrable domain to that setting, comma-separated; it ` +
        `covers the domain and its subdomains.`,
    );
  }

  const names = input.names?.length ? [...new Set(input.names)] : undefined;
  if (input.saveAs !== undefined) {
    if (!settings.allowWrites) {
      throw new PreconditionError(
        "Saving cookies to a file is a write. Set APPLE_SAFARI_ALLOW_WRITES=true to allow saveAs.",
      );
    }
    // Named, never "all of them": the file should hold the session the caller
    // asked for and not every tracker the site set beside it.
    if (!names) {
      throw new PreconditionError(
        "saveAs needs `names`, the cookies to write. List the page's cookies first without " +
          "saveAs to see their names.",
      );
    }
  }

  const result = await run({
    action: "cookies",
    url: input.url,
    ...(input.saveAs !== undefined ? { valuesFor: names } : {}),
  });
  if (!result.ok) throw explain(result);
  const raw = ((result.data as { cookies?: unknown } | undefined)?.cookies ?? []) as RawCookie[];
  const all = raw.filter((c) => typeof c?.name === "string");

  if (input.saveAs === undefined) {
    const listed = (names ? all.filter((c) => names.includes(c.name as string)) : all).map(toInfo);
    return { url: input.url, host, count: listed.length, cookies: listed };
  }

  const wanted = names as string[];
  const missing = wanted.filter((name) => !all.some((c) => c.name === name));
  if (missing.length > 0) {
    throw new PreconditionError(
      `This page has no cookie named ${missing.map((n) => `"${n}"`).join(", ")}, so nothing was ` +
        `written. It has: ${[...new Set(all.map((c) => c.name as string))].join(", ") || "none"}.` +
        ` A signed-out page lacks its login cookies; sign in in Safari and try again.`,
    );
  }

  // In the order asked for, and within one name in the order a browser sends
  // them: the longest path first (RFC 6265 §5.4).
  const chosen = wanted.flatMap((name) =>
    all
      .filter((c) => c.name === name)
      .toSorted((a, b) => String(b.path ?? "").length - String(a.path ?? "").length),
  );
  for (const cookie of chosen) {
    if (typeof cookie.value !== "string") {
      throw new PreconditionError(
        `The extension sent no value for "${String(cookie.name)}", so nothing was written.`,
      );
    }
    if (UNSAFE.test(cookie.value) || UNSAFE.test(cookie.name as string)) {
      throw new PreconditionError(
        `Cookie "${String(cookie.name)}" holds a character that cannot sit on one Cookie header ` +
          `line, so nothing was written.`,
      );
    }
  }

  // The header's VALUE: no "Cookie:" prefix and no newline, so a tool that
  // takes a cookie string (and splits it on "; ") can read the file as is.
  const line = chosen.map((c) => `${String(c.name)}=${String(c.value)}`).join("; ");
  const written = writeConfinedFile({
    root: settings.downloadDir,
    name: input.saveAs,
    bytes: Buffer.from(line, "utf8"),
    overwrite: input.overwrite ?? false,
    settingName: "APPLE_SAFARI_DOWNLOAD_DIR",
  });
  const cookies = chosen.map(toInfo);
  return {
    url: input.url,
    host,
    count: cookies.length,
    cookies,
    saved: { path: written.path, bytes: written.bytes, names: wanted },
  };
}
