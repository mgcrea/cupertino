import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://cupertino.mgcrea.io",
  integrations: [sitemap()],
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        // The feedback Worker. Without this the browser refuses the POST from
        // /feedback at runtime and the form silently does nothing — no build error.
        // The beacon POSTs its measurement to cloudflareinsights.com (no `static.`
        // prefix). Miss it and the script loads, runs, and every report stays empty.
        "connect-src 'self' https://feedback.mgcrea.io https://cloudflareinsights.com",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
      /*
       * The Cloudflare Web Analytics beacon is a manual embed, so the browser has to be
       * allowed to fetch it from a third-party origin. Astro fills `script-src` with
       * `'self'` plus a sha256 per inline script and nothing else, and hashes only ever
       * match inline scripts — an external URL needs a host source or it is refused
       * silently, with the tag sitting in the HTML looking perfect.
       *
       * `resources` REPLACES Astro's default source list rather than extending it, so
       * `'self'` has to be repeated here. The per-script hashes are still appended.
       */
      scriptDirective: {
        resources: ["'self'", "https://static.cloudflareinsights.com/beacon.min.js"],
      },
      // The latency bars, the grant diagram's connector lanes and the tool
      // marquee carry computed widths and delays in per-element `style`
      // attributes. CSP hashes never cover style attributes, and 'unsafe-inline'
      // on `style-src` is nullified by the hashes Astro appends there — so the
      // allowance is scoped to `style-src-attr`, leaving <style> and <link>
      // under the strict policy.
      styleDirective: {
        resources: [{ resource: "'unsafe-inline'", kind: "attribute" }],
      },
    },
  },
  vite: { plugins: [tailwindcss()] },
});
