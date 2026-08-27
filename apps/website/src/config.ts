/**
 * Every fact that changes between releases lives here, and nowhere else.
 * Components and the JSON-LD both read from this file, so a surface landing or
 * a first release is a single edit.
 *
 * The repo is the authority on all of it. If a count here disagrees with
 * a `packages/<surface>/src/tools/index.ts`, the tree is right and this file is stale.
 */

import { SURFACES } from "./data/surfaces.ts";

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
 * The account X attributes the card to. Both `twitter:site` (the publisher) and
 * `twitter:creator` (the author) are the same handle here, because they are the
 * same person — splitting them would be a fiction.
 */
export const X_HANDLE = "@mgcrea";

/**
 * Small counts are spelled out; a digit mid-sentence reads as a spec sheet.
 * Exported because headings need it too: the Surfaces heading used to open with
 * a literal "Four", which is exactly the drift this file exists to prevent.
 */
export const SPELLED = ["no", "one", "two", "three", "four", "five", "six", "seven"];

/** "Mail, Notes, Reminders and Calendar" — however many there turn out to be. */
const surfaceList = SURFACES.map((s) => s.name)
  .join(", ")
  .replace(/, ([^,]+)$/, " and $1");

/**
 * The og:image card. `pnpm icons` bakes these two lines into `og-image.png`, so
 * editing them here is only half the change — re-run it, or the picture and the
 * page disagree.
 *
 * They deliberately do not repeat the page title. X renders og:title and
 * og:description as text beneath the image, so a card that restates the title
 * spends its one visual asset saying something already on screen. The title
 * carries the promise ("Put your agent to work in your everyday Apple apps");
 * these carry the specifics it leaves out — which apps, and what it costs you
 * in permissions.
 *
 * It said "for Claude" until the hero stopped naming a host. Claude is the
 * biggest MCP host and it is still not the only one, and a card that names it
 * argues against the servers being host-agnostic, which is the thing that makes
 * them worth adopting.
 *
 * `alt` is the accessible description X and Mastodon both expose, capped at 420
 * characters. It describes the picture, not the product.
 *
 * There is no `ground` here any more. The card is composed on the same gradient
 * the App Store plates are, read by `scripts/generate-icons.mjs` straight out of
 * `apps/apple/Screenshots/screenshots.config.json` — so changing the plate there
 * changes the card, and the two cannot quote different grounds at each other.
 * It used to be a flat `#0b0c0f` stated here, which was true of the page but had
 * stopped being true of everything else the brand puts a product visual on.
 *
 * The surfaces are read from `data/surfaces.ts` rather than typed out, for the
 * reason CLAUDE.md gives about every other count on this site. It has been worth
 * it twice over: a hand-written "four" here would have been wrong the day
 * Contacts shipped and wrong again at 1.2.0, in a picture nothing in CI looks
 * at.
 */
const spelledSurfaces = SPELLED[SURFACES.length] ?? String(SURFACES.length);

/**
 * The two lines swapped jobs at eight surfaces, and the reason is mechanical:
 * **`composeCard` does not fit text.** Both lines are a fixed font size, centred,
 * with no measuring and no wrap — so a line that outgrows 1200px is clipped at
 * both ends, silently, in a picture nothing in CI looks at. The enumerated
 * headline already spanned nearly edge to edge at six names; Safari would have
 * pushed it over.
 *
 * So the COUNT is the headline, where it costs 43 characters however many
 * surfaces there are, and the NAMES moved to the subhead, which is 28px against
 * the headline's 38px and has room for several more. Both still come from
 * `data/surfaces.ts` rather than being typed out, which is the point: the card
 * cannot fall behind what ships.
 *
 * "for any agent" is gone with the swap, and is not missed — the page title
 * already carries the promise, and this card's job is the specifics the title
 * leaves out: which apps, and what it costs in permissions.
 */
export const SOCIAL_CARD = {
  headline: `${spelledSurfaces[0]?.toUpperCase()}${spelledSurfaces.slice(1)} Apple apps, one Full Disk Access grant`,
  subhead: surfaceList,
  alt: `The Cupertino icon — a low sun over two hills — beside the word Cupertino, above the line “${spelledSurfaces} Apple apps, one Full Disk Access grant”, and the list ${surfaceList}.`,
  width: 1200,
  height: 630,
} as const;

/**
 * True since app-v1.0.0. It gates the CTA and the buy button, so the site cannot
 * half-announce — but it does not gate every string: anything outside a SHIPPED
 * branch has to be true on its own, which the Status "Release" row was not.
 *
 * The app shipped WITHOUT the npm packages, so any copy still promising they
 * land together is stale rather than merely early.
 */
export const SHIPPED = true;

/**
 * The app version currently shipping, as a bare marketing version.
 *
 * GENERATED from the root `package.json` by `make version`, and CI fails if it
 * has drifted. Do not edit the line below; bump the root version and rerun.
 *
 * This used to be a hand-kept mirror of the newest `app-v*` tag, with a note
 * saying nothing checked it agreed with the CHANGELOG heading or the packages.
 * Nothing did, and it lost: the site said 1.2.0 through both 1.2.1 and 1.2.2 —
 * the one copy of the number a visitor ever reads, wrong for two releases.
 *
 * The tag is still what people are RUNNING (nothing bumps `MARKETING_VERSION`
 * in the pbxproj, so CI overrides it from the tag name — see the release-app
 * job in .github/workflows/ci.yml). It just cannot be what this file is
 * generated from: the value has to be right in the commit the tag points at,
 * and the site builds from a shallow clone with no tags. That job now refuses
 * to build a tag whose commit disagrees with the root version, which is what
 * keeps the two ends honest.
 *
 * It deliberately does not carry a build number. `CFBundleVersion` is a commit
 * count, which orders builds but identifies none of them, and it is not a fact
 * a visitor can do anything with.
 *
 * Shown in the nav and carried in the JSON-LD, both gated on SHIPPED: a version
 * printed before there is a release names something nobody can download.
 */
// <generated:version> generated from package.json by `make version` — do not edit by hand
export const APP_VERSION = "1.3.1";
// </generated:version>

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
 * The price. There is no ladder any more, and that is the change worth
 * recording here.
 *
 * There were three rungs, each tied to a surface shipping rather than to a date
 * — the argument being that a rise tied to the calendar makes latecomers pay
 * more for the same thing, while a rise tied to a surface says the product got
 * bigger. Every rung then came due and every one was held: Calendar landed
 * before launch, Contacts after it, then Messages and Safari together in 1.2.0.
 * Four surfaces, no rise.
 *
 * So the ladder was retired rather than rewritten a fourth time. Two reasons, and
 * only the second is about money. Every surface the probes mapped now ships, so
 * there is nothing left to tie a rung to, and docs/licensing.md had already
 * refused the alternative — "promising a price for a surface nobody has built
 * yet is the kind of schedule that gets quietly dropped". And a rise is earned
 * by demand as much as by scope; charging more before the audience arrives
 * prices out the earliest buyers, who are the ones taking the risk.
 *
 * What that leaves is simpler and needs no maintenance: one price, covering
 * every surface, fixed for every 1.x release once bought. Nothing on the page
 * announces a future price, because there is no longer one to announce. See
 * docs/licensing.md, which keeps the history.
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
} as const;
