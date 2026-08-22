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
 * The clients Cupertino wires up for you, and how.
 *
 * Not the same list as HOSTS above, and deliberately so: HOSTS is the *problem*
 * — four hosts, four whole-disk grants — while this is what the app does about
 * it. `ClientWiring.swift` is the authority on both the membership and the
 * split, and the split is not about how popular a client is.
 *
 * `automatic` is every client whose config is strict JSON with servers under a
 * top-level `mcpServers`: the app merges its four entries in, keeps a backup
 * and leaves every other key alone.
 *
 * `command` is the clients whose config is not ours to rewrite. Visual Studio
 * Code's is JSONC and Codex's is TOML, and re-serialising either would delete
 * the comments in a file the user maintains by hand. Claude Code's
 * `~/.claude.json` is strict JSON and technically writable, but it holds API
 * credentials and running sessions write to it concurrently, so a
 * read-modify-write from a menu bar could drop somebody else's change. All
 * three get a line to paste instead — for the two with a CLI, one that the
 * client itself executes.
 *
 * ChatGPT is on neither list: it takes remote HTTP connectors and cannot spawn
 * a local stdio server at all.
 */
export const WIRING = {
  automatic: ["Claude Desktop", "Cursor", "LM Studio", "Windsurf"],
  command: ["Claude Code", "Visual Studio Code", "Codex CLI"],
  /**
   * How many of each `MenuBar.astro` draws. It is a fixed-height mock of a
   * 320pt popover, and the real one only ever lists the clients you actually
   * have installed — usually two or three. Drawing all seven would make the
   * mock less honest, not more.
   */
  mockRows: { automatic: 2, command: 1 },
} as const;

/**
 * The evaluation window, in minutes. `Trial.duration` in
 * apps/apple/Cupertino/Trial.swift is the authority; this is the copy's mirror
 * of it.
 *
 * It exists because the licence gate refuses at the MCP handshake, so without
 * it nobody could find out whether the servers work against *their* mail before
 * paying. That is a technical question and it is asked first; `refundDays`
 * below answers the commercial one.
 *
 * Three properties the copy must not overstate: it is started by hand, never
 * armed automatically; it runs every surface at full function, with writes
 * obeying their own toggles; and it is held in memory, so quitting and
 * reopening starts another one. Nothing enforces one per machine and nothing
 * pretends to — see EULA §3(a), which says so in those words.
 */
export const TRIAL = { minutes: 30 } as const;

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
/**
 * Two currencies, both set explicitly on the Stripe Price via `currency_options`
 * — never one converted from the other.
 *
 * USD leads because most of the audience is there. EUR is listed rather than
 * left to conversion for two reasons. Stripe's Adaptive Pricing only converts
 * *out of* a settlement currency, and this account settles in EUR alone, so a
 * USD-only price would settle through an FX conversion this side pays on every
 * sale; naming both moves that cost back to the presented rate. And EU consumer
 * law wants a VAT-inclusive total shown to EU buyers, which a dollar figure
 * converted at checkout cannot promise in advance.
 *
 * So: the USD figure is tax-exclusive and the EUR figure is tax-inclusive. That
 * is the ordinary convention on each side, not an inconsistency — but it does
 * mean the two numbers are not meant to be equal, and `Pricing.astro` has to
 * show both rather than pick one.
 */
export const PRICING = {
  /** Display form. `amount` is what the JSON-LD offer carries. */
  price: "$14.99",
  amount: "14.99",
  currency: "USD",
  /** Shown alongside, VAT included, as EU buyers are quoted and charged. */
  eur: { price: "€14.99", amount: "14.99", currency: "EUR" },
  /** The stable vanity URL. `public/_redirects` sends it to Stripe. */
  buy: "/buy",
  /**
   * Generous on purpose. The trial answers whether Cupertino works against your
   * mail; this answers whether it was worth the money, which is a different
   * question and is asked second. See TRIAL and EULA §3.
   */
  refundDays: 30,
  ladder: [
    { price: "$14.99", when: "At launch", covers: "Mail, Notes, Reminders, Calendar" },
    { price: "$24.99", when: "When Messages ships", covers: "+ Messages" },
    { price: "$34.99", when: "When Safari ships", covers: "+ Safari" },
  ],
} as const;
