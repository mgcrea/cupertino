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
- **`src/data/surfaces.ts`** — the three surfaces and every tool name, split into `read` (always
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
- **`SHIPPED` is false and everything says so.** Nothing is on npm and the app is not signed and
  released, so the CTA is "watch the repo" and the status block says "not shipped yet". Flipping
  `SHIPPED` is a release step, not a copy edit — and the JSON-LD is deliberately
  `SoftwareApplication` with no offer, because a price or availability here would be a
  structured-data lie.
- **The no-network claim is load-bearing and checked.** `scripts/audit-network.sh` at the repo root
  gates it in CI. If that check is ever relaxed, the Status row here comes down first.
- **Unofficial, not affiliated with Apple** stays in the hero caption and the footer.

## Design source

The design lives in `../../.idea/design/` (gitignored, local reference only).
`Cupertino Site v4.dc.html` is the homepage this was built from — two artboards, D1 desktop and D2
mobile. Open it beside the dev server when changing layout.

## Brand marks

`public/app-icon.svg`, `favicon.svg`, `icon-small.svg` and `menubar-glyph.svg` are **copied in**
from `../../.idea/design/logo/`, which is gitignored — so they stay committed here and a checkout
without the design directory still builds. Re-copy by hand when the mark changes.

Two rules from the mark's own README that this site has to keep:

- **Below 64px use the small variant.** The two-hill art silts up; `Logo.astro` defaults to it and
  only the CTA plate opts into the full mark.
- **The menu-bar glyph is a template image** — pure black plus alpha, which macOS inverts for a
  dark menu bar. Nothing does that on the web, so `MenuBar.astro` applies `filter:invert(1)` by
  hand. It is not a colour asset and must not be recoloured.

`pnpm icons` regenerates `favicon-32.png`, `apple-touch-icon.png` and `og-image.png` from those
SVGs with sharp. The outputs are committed; the command is only needed when the mark changes.
