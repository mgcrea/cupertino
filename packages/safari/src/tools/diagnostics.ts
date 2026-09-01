import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "../build-info.js";
import { QUIET_AFTER_SECONDS } from "../client/pages.js";
import type { AppleSafariClient } from "../client/safari.js";
import { wrap } from "./util.js";

/**
 * Build the report.
 *
 * Split out of the tool registration so the `cupertino://safari/diagnostics`
 * resource can serve the same bytes. Two renderings of one probe: duplicated,
 * the resource and the tool would drift, and the disagreement would surface as
 * "the diagnostics lied" — the one thing this file must never do.
 */
export const buildDiagnostics = async (
  client: AppleSafariClient,
): Promise<Record<string, unknown>> => {
  const status = client.status();
  const pages = client.pagesStatus();
  const located = status.located;
  return {
    server: { name: BUILD_INFO.name, version: BUILD_INFO.version },
    // Off means the prompts and the cupertino:// resources are not registered at
    // all. Reported here because this tool still is, so it stays the one place
    // that explains a capability the client cannot see.
    settings: { exposePrompts: client.config.exposePrompts },
    lanes: {
      summary:
        "Safari's two lanes are NOT fallbacks for each other. They see almost disjoint " +
        "things: the file lane holds everything about the past and nothing about the " +
        "present; Apple Events sees only what is open right now, which Safari never " +
        "writes to disk. An ungranted Safari server is not a slower one — it is a " +
        "different and much smaller one.",
      fileLane: {
        needs: "Full Disk Access",
        answers: "history, bookmarks, the Reading List",
        working: status.store.opened,
      },
      appleEvents: {
        needs: "an Automation grant for com.apple.Safari, and Safari running",
        answers: "the tabs currently open",
        enabled: client.config.liveTabs,
      },
      extension: {
        needs:
          "the Cupertino Safari extension, enabled in Safari and allowed on the site in question",
        answers:
          "what a page actually says, as text or HTML — and, through a command channel in " +
          "the same container, what is on it (page_elements), acting on it (click, fill, " +
          "scroll) and any one-time code it is showing (find_codes)",
        // `working` is measured — the store exists — and `captured` is what is in
        // it. Both matter: a directory with nothing in it means the extension ran
        // but has been allowed on no site, which is a different fix from not
        // having the extension at all.
        working: pages.exists,
        captured: pages.count,
        newestAgeSeconds: pages.newestAgeSeconds,
        // Measured, not asserted. Whether the extension is ENABLED is a switch
        // in Safari that only the containing app can read, and a value handed
        // to this process at spawn would be a snapshot of something the user
        // can flip a second later. Silence is what CAN be measured here.
        quiet:
          pages.newestAgeSeconds !== null && pages.newestAgeSeconds > QUIET_AFTER_SECONDS
            ? "Nothing captured recently. The extension is probably switched off, or allowed " +
              "on no site visited since — check Safari > Settings > Extensions. Anything still " +
              "on disk is stale."
            : undefined,
        directory: pages.directory,
        note:
          "A capture is a SNAPSHOT taken when the page loaded, not a live read. Nothing here can " +
          "ask Safari for a fresh copy, so every result carries capturedAt and ageSeconds. The " +
          "ACTING tools do not use captures at all: they send a command the page picks up on " +
          "its next poll, which is about a second on a visible tab and up to ten on a hidden " +
          "one. A timeout there means nothing was listening — the extension off, or not " +
          "allowed on that site, or the page closed — and never that the page refused.",
      },
      writes: client.config.allowWrites
        ? "enabled — open_url and add_reading_list_item (Apple Events), plus click, fill and " +
          "scroll (extension, no Apple Event)"
        : "off — set APPLE_SAFARI_ALLOW_WRITES to enable open_url, add_reading_list_item, " +
          "click, fill and scroll. They are not registered at all, so they do not appear in " +
          "the tool list.",
      codes: client.config.allowCodes
        ? "enabled — apple_safari_find_codes is registered, and page_elements returns the " +
          "value of a one-time-code field. A password or card number is still withheld."
        : 'off — a one-time-code field reads back as redacted:"code" and ' +
          "apple_safari_find_codes is not registered. Set APPLE_SAFARI_ALLOW_CODES to change " +
          "that. A password or card number is withheld either way.",
    },
    history: {
      path: located.historyPath,
      exists: located.exists,
      readable: located.readable,
      opened: status.store.opened,
      mode: status.store.mode,
      reason: status.store.reason,
      ...status.capabilities,
    },
    files: {
      bookmarks: {
        path: located.bookmarks.path,
        exists: located.bookmarks.exists,
        readable: located.bookmarks.readable,
      },
      downloads: {
        path: located.downloads.path,
        exists: located.downloads.exists,
        note: "Present but never parsed by this server.",
      },
      cloudTabs: {
        path: located.cloudTabs.path,
        exists: located.cloudTabs.exists,
        note:
          "Tabs open on other devices. Absent on the probed machine and unmeasured, " +
          "so nothing here reads it.",
      },
    },
    caveats: [
      "The tab-to-history match rate varies enormously with the tab set: 60.7%, 55.3% and " +
        "8.3% across three measured runs. A null `history` on a tab means NOT FOUND, never " +
        "'never visited'. Safari offers no shared identifier between the lanes — the URL is " +
        "the only join key, and it is trivially lossy. Single-page apps are the main cause: a " +
        "page reached by pushState commits no history row. The variant ladder also only " +
        "strips cruft OFF a tab's URL, so it cannot reach a stored row that carries MORE " +
        "query than the tab does — see docs/safari.md.",
      "History timestamps are placed on an epoch DETECTED from the store rather than an " +
        "assumed one, because an earlier probe run misread this column by 31 years. When " +
        "detection fails, every date reads null rather than being guessed.",
      "Page content comes from the Safari extension and nowhere else, and it is a SNAPSHOT " +
        "rather than a live read — apple_safari_read_page returns what a page looked like when " +
        "it was captured, with capturedAt and ageSeconds saying when. This server still ships " +
        "no `do JavaScript` verb: that would need 'Allow JavaScript from Apple Events', a " +
        "developer-menu toggle that is not a TCC grant and whose state cannot be read, so this " +
        "report could never say in advance whether it would work. Accessibility is not a route " +
        "either — Safari exposes no AXWebArea for page content at all (measured, macOS 26.6). " +
        "The extension is the only one, and it sees only the sites you allow it on.",
      "The write lane is two different things behind one flag. open_url and " +
        "add_reading_list_item are Apple Events that need no Full Disk Access, so they work " +
        "on a machine where the read lane does not; they accept http and https only, because " +
        "a javascript: URL would reach `do JavaScript` through a navigation tool. click, fill " +
        "and scroll send no Apple Event at all — they go through the extension, which Safari " +
        "consents to one website at a time. Neither Reading List add is undoable: the " +
        "dictionary has no remove verb.",
      "page_elements never returns the value of a field that looks like a credential — a " +
        "password, a card number — whatever the settings say. A one-time-code field is " +
        "withheld too unless APPLE_SAFARI_ALLOW_CODES is set, and `redacted` says which case " +
        "applies while `hasValue` still says whether the field is filled. The Passwords app " +
        "itself is unreachable by any lane; see docs/passwords.md.",
      "The exact History.db schema has not been read back on a granted machine, so every " +
        "column is treated as optional: a renamed or missing one reports null instead of " +
        "failing the query. `itemFk` and `itemPk` above show what was actually resolved.",
    ],
  };
};

/**
 * Diagnostics, which on this surface has to explain something the others do
 * not: a HALF-working server is the normal degraded state here, not an
 * anomaly. With Full Disk Access but no Automation grant, history and bookmarks
 * work and tabs do not. With Automation but no Full Disk Access, exactly the
 * reverse. Reporting one overall "healthy" boolean would be wrong in both.
 */
export const registerDiagnosticsTools = (server: McpServer, client: AppleSafariClient): void => {
  server.registerTool(
    "apple_safari_diagnostics",
    {
      description:
        "Report which of Safari's two lanes are working, what each one can answer, and what " +
        "this server deliberately cannot do. Start here when a read returns nothing — on this " +
        "surface one lane failing while the other works is normal.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => wrap(() => buildDiagnostics(client)),
  );
};
