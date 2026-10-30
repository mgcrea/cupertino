import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The extension manifest, read as the release check reads it.
 *
 * `scripts/verify-extension.sh` fails a build whose manifest names a file the
 * bundle does not carry, but it only runs against a built app, which is late
 * for "I added a script to the manifest and forgot the file". This asserts the
 * same thing at test time, plus the one ordering that matters here:
 * `network-hook.js` must run before `network.js`.
 *
 * Not because it runs in the page: Safari ignores `"world": "MAIN"` (measured
 * on the notarized build of 385bb73), so the hook lands in the isolated world
 * and wraps nothing. It is there as the SOURCE PROVIDER — it leaves its own
 * source on the isolated window, and `network.js` injects that into the page
 * as an inline `<script>` when the tab is armed. It has to run first so the
 * source is there when `network.js` looks. The world key is gone rather than
 * kept as a hope, because a manifest that says MAIN reads as if it worked.
 * JSON has no comments, so this is where that reasoning lives.
 *
 * The two are ONE entry, `"js": ["network-hook.js", "network.js"]`, because
 * that is the only form whose order the extension platform promises: files in
 * one entry's `js` array are injected in the order listed. Two entries with
 * the same `matches` and `run_at` happen to run in manifest order in Safari
 * today, but nothing documents that, and the failure would be silent — a
 * `network.js` that looked before the source existed would report the
 * injection "unavailable" on every armed tab.
 *
 * `web_accessible_resources` exposes the same file for the fallback on a page
 * whose CSP refuses inline scripts, and `scripting` is gone with the
 * registration it was asked for. `scripts/verify-extension.sh` checks those
 * resources exist in the built bundle too, as the last test here does at
 * source.
 */

const RESOURCES = fileURLToPath(
  new URL("../../../apps/apple/CupertinoSafariExtension/Resources/", import.meta.url),
);

interface ContentScript {
  matches: string[];
  js: string[];
  run_at: string;
  all_frames: boolean;
  world?: string;
}

interface WebAccessible {
  resources: string[];
  matches: string[];
}

const manifest = JSON.parse(readFileSync(`${RESOURCES}manifest.json`, "utf8")) as {
  background: { service_worker?: string; scripts?: string[] };
  content_scripts: ContentScript[];
  permissions: string[];
  web_accessible_resources?: WebAccessible[];
  icons: Record<string, string>;
  action: { default_icon: Record<string, string>; default_popup?: string };
};

describe("extension manifest", () => {
  it("loads the hook then the buffer in one entry, then the existing scripts", () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["<all_urls>"],
        js: ["network-hook.js", "network.js"],
        run_at: "document_start",
        all_frames: false,
      },
      {
        matches: ["<all_urls>"],
        js: ["actions.js", "content.js"],
        run_at: "document_idle",
        all_frames: false,
      },
    ]);
  });

  it("asks for no world, which Safari ignores anyway", () => {
    for (const cs of manifest.content_scripts) expect(cs).not.toHaveProperty("world");
  });

  /**
   * `cookies` is the one API permission besides native messaging, for
   * `apple_safari_cookies`. It was expected to make Safari ask for approval
   * again; on the install measured it did not (docs/safari.md, "The
   * permission change"). It reads only on sites the user has allowed the extension on:
   * there is still no `host_permissions` entry and so no new `<all_urls>`
   * grant, only the content scripts' `matches`, which Safari asks about one
   * site at a time.
   */
  it("asks for native messaging and cookies, and nothing that registers scripts", () => {
    expect(manifest.permissions).toEqual(["nativeMessaging", "cookies"]);
  });

  it("asks for no host permission, so cookies stay behind the per-site grant", () => {
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  it("exposes the hook file to pages, for the src fallback, and nothing else", () => {
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ["network-hook.js"], matches: ["<all_urls>"] },
    ]);
  });

  it("names only files the bundle carries", () => {
    const named = new Set<string>();
    const { service_worker, scripts = [] } = manifest.background;
    if (service_worker) named.add(service_worker);
    scripts.forEach((s) => named.add(s));
    for (const cs of manifest.content_scripts) cs.js.forEach((j) => named.add(j));
    Object.values(manifest.icons).forEach((i) => named.add(i));
    Object.values(manifest.action.default_icon).forEach((i) => named.add(i));
    if (manifest.action.default_popup) named.add(manifest.action.default_popup);
    for (const war of manifest.web_accessible_resources ?? []) {
      war.resources.forEach((r) => named.add(r));
    }
    const missing = [...named].filter((n) => !existsSync(`${RESOURCES}${n}`)).toSorted();
    expect(missing).toEqual([]);
  });
});
