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
 * `network-hook.js` must be listed before `network.js`.
 *
 * Not because it runs in the page: Safari ignores `"world": "MAIN"` (measured
 * on the notarized build of 385bb73), so this entry lands in the isolated world
 * and wraps nothing. It is there as the SOURCE PROVIDER — it leaves its own
 * source on the isolated window, and `network.js`, the next entry, injects that
 * into the page as an inline `<script>` when the tab is armed. Listed first so
 * the source is there when `network.js` looks. The key is gone rather than kept
 * as a hope, because a manifest that says MAIN reads as if it worked. JSON has
 * no comments, so this is where that reasoning lives.
 *
 * `web_accessible_resources` exposes the same file for the fallback on a page
 * whose CSP refuses inline scripts, and `scripting` is gone with the
 * registration it was asked for.
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
  it("lists the hook, the buffer, then the existing scripts, in that order", () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ["<all_urls>"],
        js: ["network-hook.js"],
        run_at: "document_start",
        all_frames: false,
      },
      {
        matches: ["<all_urls>"],
        js: ["network.js"],
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

  it("asks for native messaging only, now that nothing registers scripts", () => {
    expect(manifest.permissions).toEqual(["nativeMessaging"]);
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
