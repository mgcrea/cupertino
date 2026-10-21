import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The extension manifest, read as the release check reads it.
 *
 * `scripts/verify-extension.sh` fails a build whose manifest names a file the
 * bundle does not carry, but it only runs against a built app, which is late
 * for "I added a script to the manifest and forgot the file". This asserts the
 * same thing at test time, plus the one ordering that matters here: the
 * page-world hook must be listed (and so injected) before anything else.
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

const manifest = JSON.parse(readFileSync(`${RESOURCES}manifest.json`, "utf8")) as {
  background: { service_worker?: string; scripts?: string[] };
  content_scripts: ContentScript[];
  permissions: string[];
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
        world: "MAIN",
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

  it("asks for the scripting permission the registration fallback needs", () => {
    expect(manifest.permissions).toEqual(["nativeMessaging", "scripting"]);
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
    const missing = [...named].filter((n) => !existsSync(`${RESOURCES}${n}`)).toSorted();
    expect(missing).toEqual([]);
  });
});
