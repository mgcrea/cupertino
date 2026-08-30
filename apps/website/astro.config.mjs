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
        "connect-src 'self' https://feedback.mgcrea.io",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
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
