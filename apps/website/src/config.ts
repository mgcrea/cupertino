/**
 * Every fact that changes between releases lives here, and nowhere else.
 * Components and the JSON-LD both read from this file, so a surface landing or
 * a first release is a single edit.
 *
 * The repo is the authority on all of it. If a count here disagrees with
 * a `packages/<surface>/src/tools/index.ts`, the tree is right and this file is stale.
 */

export const SITE_DOMAIN = "cupertino.mgcrea.io";
export const SITE_URL = `https://${SITE_DOMAIN}`;

export const APP_NAME = "Cupertino";
export const BUNDLE_ID = "io.mgcrea.cupertino";

export const REPO_URL = "https://github.com/mgcrea/mcp-apple-mail";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const DOCS = {
  distribution: `${REPO_URL}/blob/main/docs/distribution.md`,
  licensing: `${REPO_URL}/blob/main/docs/licensing.md`,
  envelopeIndex: `${REPO_URL}/blob/main/docs/envelope-index.md`,
  notes: `${REPO_URL}/blob/main/docs/notes.md`,
} as const;

/**
 * Nothing is published yet: the signed app and the npm packages land together.
 * Flip this when the first release ships — it gates every "not shipped yet"
 * string and the CTA, so the site cannot half-announce.
 */
export const SHIPPED = false;

/** Measured on macOS 26.6 (build 25G72). See docs/verify.md and docs/notes.md. */
export const LATENCY = {
  appleEventsMs: 74_000,
  indexedMs: 97,
  /** Where the Apple Events lane stops being usable for Notes. */
  notesCeiling: "5k notes",
} as const;

export const HOSTS = ["Cursor", "Claude Desktop", "Visual Studio Code", "Terminal"] as const;
