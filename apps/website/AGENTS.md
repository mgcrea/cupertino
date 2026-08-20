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
