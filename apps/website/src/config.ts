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

export const REPO_URL = "https://github.com/mgcrea/mcp-cupertino";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const DOCS = {
  distribution: `${REPO_URL}/blob/main/docs/distribution.md`,
  licensing: `${REPO_URL}/blob/main/docs/licensing.md`,
  envelopeIndex: `${REPO_URL}/blob/main/docs/envelope-index.md`,
  notes: `${REPO_URL}/blob/main/docs/notes.md`,
  /** The app's own licence — source-available, not the repo-root MIT. */
  appLicense: `${REPO_URL}/blob/main/apps/apple/LICENSE`,
} as const;

/**
 * Nothing is published yet: the signed app and the npm packages land together.
 * Flip this when the first release ships — it gates every "not shipped yet"
 * string and the CTA, so the site cannot half-announce.
 */
export const SHIPPED = false;

/**
 * The release lives on GitHub, never here. A Cloudflare assets binding caps a
 * single file at 25 MiB and the bundle embeds a universal Node runtime, so the
 * site could not serve it even if hosting it were a good idea — see
 * docs/distribution.md.
 *
 * `latest/download` resolves to whatever the newest release published, which is
 * why CI uploads the asset with no version in its name. Do not add one here.
 */
export const DOWNLOAD = {
  /** The stable vanity URL. `public/_redirects` sends it to GitHub. */
  href: "/download",
  asset: `${REPO_URL}/releases/latest/download/Cupertino.zip`,
  checksum: `${REPO_URL}/releases/latest/download/Cupertino.zip.sha256`,
  releases: `${REPO_URL}/releases`,
  cask: "brew install --cask mgcrea/tap/cupertino",
  /** macOS 26 or later: the icon is an Icon Composer bundle, which nothing older renders. */
  requires: "macOS 26 or later",
} as const;

/** Measured on macOS 26.6 (build 25G72). See docs/verify.md and docs/notes.md. */
export const LATENCY = {
  appleEventsMs: 74_000,
  indexedMs: 97,
  /** Where the Apple Events lane stops being usable for Notes. */
  notesCeiling: "5k notes",
} as const;

/**
 * Body search, measured on the same 181,734-message store as LATENCY.
 * See docs/mail-body.md — the probe that produced these is
 * `pnpm probe:mail-body`, and the repo is the authority on every one of them.
 */
export const BODY_SEARCH = {
  /** Messages in the store the measurements were taken against. */
  storeSize: 181_734,
  /** The declared bound, APPLE_MAIL_BODY_SCAN_MAX. */
  bound: 2_000,
  /** Cost is linear in candidates, so the filter decides everything. */
  steps: [
    { label: "a tight filter", candidates: 100, ms: 48 },
    { label: "sender + a month", candidates: 500, ms: 242 },
    { label: "90 days, one mailbox", candidates: 1_932, ms: 933 },
    { label: "90 days, every mailbox", candidates: 6_566, ms: 3_171 },
    { label: "no filter at all", candidates: 182_329, ms: 88_065, refused: true },
  ],
  /** What an owned full-text index would have cost instead. */
  indexAlternative: { gigabytes: 2.2, buildSeconds: 365 },
} as const;

export const HOSTS = ["Cursor", "Claude Desktop", "Visual Studio Code", "Terminal"] as const;

/**
 * The launch price, and the ladder published alongside it.
 *
 * Rungs are tied to SHIPPED SURFACES, never to dates. A rise tied to the
 * calendar says latecomers pay more for the same thing, which earns resentment
 * and teaches people to wait for a sale; a rise tied to a surface says the price
 * went up because the product got bigger, which is true and is also the roadmap
 * restated as a reason to buy now. Two rules come with it — every rise is
 * announced before it happens, and it never goes back down. See
 * docs/licensing.md, which is the authority on all of this.
 *
 * One purchase covers every 1.x release. 2.0 is a new purchase; there is no
 * subscription and nothing lapses.
 */
export const PRICING = {
  /** Display form. `amount` is what the JSON-LD offer carries. */
  price: "€14.99",
  amount: "14.99",
  currency: "EUR",
  /** The stable vanity URL. `public/_redirects` sends it to Stripe. */
  buy: "/buy",
  /** Generous on purpose: with no trial, this is what makes buying first reasonable. */
  refundDays: 30,
  ladder: [
    { price: "€14.99", when: "At launch", covers: "Mail, Notes, Reminders, Calendar" },
    { price: "€24.99", when: "When Messages ships", covers: "+ Messages" },
    { price: "€34.99", when: "When Safari ships", covers: "+ Safari" },
  ],
} as const;
