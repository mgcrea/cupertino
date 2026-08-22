# Cupertino website

Marketing site for [Cupertino](../..) — the MCP servers and the signed menu-bar app that holds
their one Full Disk Access grant. Static Astro build, deployed to Cloudflare at
`cupertino.mgcrea.io`.

## Development

```bash
pnpm dev          # astro dev
pnpm check        # astro check
pnpm build        # static build into dist/
pnpm deploy       # build + wrangler deploy, by hand
```

Before committing: `pnpm check` and `pnpm build` from here, then `pnpm lint` and
`pnpm format:check` **from the repository root** — both are root-only commands covering every
workspace at once. oxfmt formats the `.css`, `.mjs` and `.ts` here but leaves `.astro` alone.

## `src/assets/shots/` belongs to the pipeline

The three app screenshots in `Screens.astro` are captured, not placed. `make screenshots` from the
repository root builds Cupertino, launches it in demo mode onto each screen, checks the result
against committed goldens, and writes the images here.

**That command deletes every `.png` in `src/assets/shots/` before writing.** Do not park anything
else in the directory, and do not edit the files — the next capture overwrites them. To change what
a shot shows, change the fixture in `apps/apple/Cupertino/DemoSeed.swift` and re-run.

They are committed via Git LFS (see `.gitattributes` here) because `astro build` imports them
through `astro:assets`, so a clone that has not just run a capture still has to build. A checkout
without `git lfs pull` gets 131-byte pointer files still named `.png`, and the build then fails
inside sharp complaining about the image format rather than about the checkout.

The hand-drawn macOS mocks — `Activity.astro`, `FdaPane.astro`, `MenuBar.astro`, `Status.astro` —
are **not** superseded by these. Each is drawn because it needs something a capture cannot give it:
content that differs between two states, a layout that reflows on a phone, or a surface `appshot`
cannot photograph at all (a menu-bar dropdown is a high-layer panel, not an ordinary window). Keep
them honest against the captures rather than replacing them.

## There is one theme

Dark, and no toggle. The design canvas is drawn dark-first and has no light artboard, so a light
theme would be invented rather than implemented. Everything in `global.css` is still a token, so
adding one later is a second `:root` block and no component edits — do not start hard-coding
literals on the assumption that dark is forever.

## The CSP is invisible in dev

`astro.config.mjs` sets `security.csp`, and Astro emits that `<meta http-equiv>` **only on
`astro build`** — never from the dev server. Anything CSP can break is therefore invisible locally
by construction and ships straight to production. Check anything CSP-adjacent with
`pnpm build && pnpm preview`, not `astro dev`.

- **Inline `style` attributes are allowed**, via `style-src-attr 'unsafe-inline'`. The latency
  bars, the grant diagram's lanes and the row geometry all carry computed values that way.
  `'unsafe-inline'` on `style-src` itself would be a no-op — Astro appends hashes there, and a hash
  nullifies `'unsafe-inline'` in the same directive.
- **A new `is:inline` script or `<style>` block will be blocked.** Astro hashes neither. Put the
  script in `public/` (covered by `script-src 'self'`) and the CSS in `global.css`.

## Where things live

- **`src/config.ts`** — every fact that changes between releases: the domain, the repo and doc
  URLs, the measured latencies, `SHIPPED`. `SHIPPED` gates the pre-release pill and the CTA, so the
  site cannot half-announce a release. Never hard-code one of these in a component.
- **`src/data/surfaces.ts`** — the four surfaces and every tool name, split into `read` (always
  registered) and `write` (registered only when `*_ALLOW_WRITES` is true). The homepage JSON-LD,
  the surface cards, the marquee and the write-gate demo all read from it.
- **Everything else is inline in its component.** No content collection, no CMS.
- **`src/styles/global.css`** — the whole design system. Tailwind v4, CSS-first, no
  `tailwind.config.js`, no `dark:` variants anywhere.

## Claims discipline

The repo is the authority on what ships, and this site is downstream of it.

- **Tool counts come from the tree, not from the root README.** `packages/<surface>/src/tools/`
  is what registers them; the README has drifted before. The v4 design canvas still shows Reminders
  as "in progress, no server yet" — it shipped, with 11 tools, and the site follows the code.
- **`SHIPPED` is true, and its other branch is still live code.** The app released at 1.0.0, so
  the nav, hero, pricing plate and closing plate each render their shipped half — a download
  button, a buy button carrying the price, and a `SoftwareApplication` schema that now does carry
  an offer. Keep the `!SHIPPED` half rather than deleting it; it is what the site falls back to if
  a release is ever pulled.
  **A string outside a SHIPPED branch has to be true on its own.** That is not theoretical: the
  hero's buttons were never gated at all, so they went on inviting people to "watch the repo" for
  the whole period after the app had actually shipped, with no way to buy it above the fold.
- **The no-network claim is load-bearing and checked.** `scripts/audit-network.sh` at the repo root
  gates it in CI. If that check is ever relaxed, the Status row here comes down first.
- **Unofficial, not affiliated with Apple** stays in the hero caption and the footer.

## Every call to action goes through `Button.astro`

Nav, hero, pricing plate and closing plate were four hand-written class strings that had already
drifted in radius and padding. They are one component now — `variant` is `primary` (the accent
fill, at most one per viewport), `secondary` or `quiet`, and `size` is `sm`/`md`/`lg`.

`external` is opt-in rather than inferred from the href, because the two off-site links that matter
most want opposite behaviour: GitHub wants a new tab, and `/download` must not have one — it
redirects to a zip, and a tab that opens only to close itself is worse than no tab.

**Never put `hidden` on a `Button` directly.** It will not work, and nothing in the markup shows
why. `Button` sets `inline-flex`, and Tailwind emits `.inline-flex` _after_ `.hidden` in the
utilities layer — equal specificity, later declaration wins, so the button stays visible at every
width. The nav hides its two optional buttons with a wrapping `<span class="hidden sm:block">`
instead. The breakpoint variants are safe on either element, because they land in media queries
that come after the whole base layer.

The order the buttons drop in on a narrow viewport is deliberate: GitHub first (it is also in the
footer and the Status table), then Download (also in the closing plate), leaving the price — the
one thing with nowhere else to be at every scroll position.

## Design source and brand marks

The homepage was built from `../../.idea/design/Cupertino Site v4.dc.html` — two artboards, D1
desktop and D2 mobile. That directory is gitignored and is layout reference only.

**The marks are not copied from there.** `pnpm icons` reads the repo-root `design/`, which is
where `make icon` writes them, so the chain is one geometry end to end:

```
design/cupertino-mark.svg --make icon--> design/cupertino-icon.svg --pnpm icons--> public/*
                          --make icon--> apps/apple/Cupertino/Cupertino.icon
```

It used to stop short. These files were hand-copied out of `.idea/design/logo/`, and by the time
anyone checked, the site was serving an **earlier direction of the mark than the app shipped** —
which is the exact failure the generated chain now prevents. Run `make icon && pnpm icons` when the
mark changes; never move an SVG by hand.

Two consequences worth keeping:

- **There is one rendering, not a small variant.** `Logo.astro` always serves the plated squircle.
  The superseded direction had a simplified mark for 64px and below; the current one does not, and
  hand-authoring one here would restart the drift.
- **The menu-bar glyph is a template image** — pure black plus alpha, which macOS inverts for a
  dark menu bar. Nothing does that on the web, so `MenuBar.astro` applies `filter:invert(1)` by
  hand. It is not a colour asset and must not be recoloured.

`pnpm icons` also renders `favicon-32.png`, `apple-touch-icon.png` and `og-image.png` with sharp.
Every output is committed, so a checkout builds without running it. The touch icon is squared first
— iOS applies its own mask, and the corner radius applied twice reads pinched — through a
`replaceOnce` that throws rather than silently passing the artwork through if `make icon`'s output
shifts.

## The social card is baked, and its words live in `config.ts`

`og-image.png` is the lockup reversed out of the page's own background over two lines of copy,
composed by `composeCard` in `../../scripts/lib/lockup.mjs` — the same module that writes the README
banner, so the two cannot fork.

- **The copy is `SOCIAL_CARD` in `src/config.ts`, and the surfaces come from `data/surfaces.ts`.**
  Editing a line there is half the change: `pnpm icons` bakes it into the PNG, and until you run
  that, the picture and the page disagree. Nothing checks this.
- **It is rendered here, not in the reader's browser.** The wordmark's `textLength` pin exists for
  the README's SVG, where a reader's font substitutes; in this PNG the font resolves on whichever
  machine ran `pnpm icons`. That is safe only because the repo is already macOS-only — rendering it
  on Linux CI would silently swap the typeface for a fallback.
- **X crops it.** `summary_large_image` renders at 2:1 while og:image is 1.91:1, so roughly 15px
  comes off the top and bottom. `composeCard` throws if a mark strays into that band; keep new
  elements inside `SAFE_INSET`.
- **`Layout.astro` declares the dimensions and the alt text**, and both `twitter:site` and
  `twitter:creator` carry `X_HANDLE`. A page passing its own `ogImage` must pass `ogImageAlt` with
  it and match the 1200×630 shape the width/height tags promise.
