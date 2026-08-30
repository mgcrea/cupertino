#!/usr/bin/env node
/**
 * Assert the built /feedback page is actually wired up.
 *
 * Two of the three things checked here fail *at runtime, in the browser, with
 * nothing in the build to warn you* — which is why they are worth a script:
 *
 * 1. **The CSP origin.** `connect-src` is `'self'` in six sibling repos. Omit
 *    the Worker's origin and the page renders perfectly, the user types a bug
 *    report, presses Send, and the browser refuses the fetch. The only symptom
 *    is a console entry nobody is looking at.
 * 2. **The field names.** They are a contract with a Worker in another repo,
 *    deployed on its own schedule. A rename lands the row with one column empty.
 * 3. **No hidden diagnostics.** The privacy pages promise the four facts are
 *    visible, editable and deletable. A `type="hidden"` or `readonly` on one of
 *    them turns that promise into marketing, so it fails the build instead.
 *
 * Two more were added after both shipped to production undetected, and this
 * script passed through both:
 *
 * 4. **Something must link to the page.** The form went live orphaned — the only
 *    occurrences of "/feedback" in the built site were the CSP directive. A
 *    destination with no route to it is not a feature, and every structural
 *    assertion above was green while it was unreachable.
 * 5. **No button may inherit its colour from the prose layer.** The legal
 *    layout styles `a` at a specificity Tailwind utilities cannot beat, so an
 *    anchor carrying both a `bg-*` and a `text-*` class renders in the prose
 *    link colour instead of its own. That shipped as orange text on an orange
 *    pill. The layout here now scopes its rule to `a:not([class])`, but the
 *    eight sibling sites have their own layouts and have not been fixed, so the
 *    assertion travels with the template.
 *
 * Run after `astro build`. Reads `dist/` only — it never starts a server, so it
 * is safe in CI and says which assertion broke rather than "the page is wrong".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PARAM } from "@mgcrea/feedback-contract";

import { FEEDBACK_API } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = join(root, "dist", "feedback", "index.html");

let html;
try {
  html = readFileSync(page, "utf8");
} catch {
  console.error(`feedback:check — ${page} is missing. Run \`pnpm build\` first.`);
  process.exit(1);
}

const failures = [];

// Conditional on purpose: not every sibling site ships a CSP. Where there is
// none the browser imposes no restriction and the form works, so asserting a
// directive that does not exist would fail on a non-defect. Where there *is*
// one, omitting the origin breaks the form at runtime with no build error, and
// that is the case worth failing on.
const csp = html.match(/connect-src [^;"]*/)?.[0];
if (csp && !csp.includes(FEEDBACK_API)) {
  failures.push(
    `CSP does not allow the feedback Worker.\n` +
      `    expected to contain: ${FEEDBACK_API}\n` +
      `    emitted:             ${csp}\n` +
      `    fix: add it to security.csp.directives in the Astro config`,
  );
}

// The form posts these names; the Worker's zod schema reads them. `PARAM` covers
// the URL side, and the body uses the long names, so both are asserted.
const bodyFields = [
  "kind",
  "subject",
  "body",
  "email",
  "appVersion",
  "osVersion",
  "hardware",
  "language",
];
for (const name of bodyFields) {
  if (!html.includes(`name="${name}"`)) failures.push(`form is missing the "${name}" field`);
}
if (!html.includes('name="website"')) failures.push('the "website" honeypot is missing');

for (const [key, param] of Object.entries(PARAM)) {
  if (!param) failures.push(`contract PARAM.${key} is empty`);
}

// The promise, enforced.
for (const name of ["appVersion", "osVersion", "hardware", "language"]) {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
  if (/type="hidden"|readonly|disabled/.test(tag)) {
    failures.push(
      `"${name}" is not editable by the user (${tag.match(/type="hidden"|readonly|disabled/)[0]}).\n` +
        `    The privacy pages promise these four are visible, editable and deletable.`,
    );
  }
}

// 4. Reachability. Scan every built page for a link to the form.
const pages = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".html")) pages.push(full);
  }
};
walk(join(root, "dist"));

const linkers = pages.filter((f) => {
  if (f === page) return false; // the form linking to itself proves nothing
  return /href="\/feedback\/?"/.test(readFileSync(f, "utf8"));
});
if (linkers.length === 0) {
  failures.push(
    `nothing links to /feedback/ — the page is reachable only by typing the URL.\n` +
      `    Checked ${pages.length} built pages.\n` +
      `    fix: add it to the footer, and to the support page's primary route`,
  );
}

// 5. No prose layout may style bare `a` at a specificity Tailwind cannot beat.
//
// Asserted against the emitted CSS rather than by working out which anchors sit
// inside the prose container: a containment check has to parse the DOM and
// false-positives on the header's skip link, which carries focus:bg-* and
// text-* classes but lives nowhere near the prose. The defect is the *rule*, so
// the rule is what gets checked.
//
// `.foo[data-astro-cid-…] a{color:…}` is specificity (0,2,1). Every Tailwind
// colour utility is (0,1,0). Any anchor in that container silently renders in
// the prose link colour, which shipped here as orange text on an orange pill.
const unscopedAnchorRule = /\.[a-z-]+\[data-astro-cid-[^\]]+\]\s*a\s*\{[^}]*color:/;
// The same defect in this portfolio's other idiom. Several sites style prose with
// Tailwind arbitrary variants — `[&_a]:text-fg` — which compiles to a descendant
// selector at the same (0,2,1) and loses to nothing a button can set on itself.
// Matching the emitted CSS is unreliable here because the class name is escaped,
// so the source class is what gets checked.
const unscopedVariant = /\[&_a\]:(text|decoration|underline)/;
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const variant = html.match(unscopedVariant);
  if (variant) {
    failures.push(
      `${file.replace(root + "/", "")}: prose styles anchors with \`${variant[0]}\`.\n` +
        `    That arbitrary variant compiles to a descendant selector that outranks any\n` +
        `    colour a button anchor sets on itself.\n` +
        `    fix: write it as \`[&_a:not([class])]:…\``,
    );
  }

  const hit = html.match(unscopedAnchorRule);
  if (hit) {
    failures.push(
      `${file.replace(root + "/", "")}: a scoped layout styles bare \`a\` with a colour.\n` +
        `    ${hit[0].slice(0, 80)}…\n` +
        `    That is specificity (0,2,1) and beats every Tailwind colour utility (0,1,0),\n` +
        `    so any button anchor in that container loses its own colour.\n` +
        `    fix: scope the rule to \`a:not([class])\``,
    );
  }
}

if (failures.length) {
  console.error(`feedback:check FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `feedback:check ok — ${bodyFields.length} fields, honeypot, editable diagnostics, ` +
    `${csp ? `${FEEDBACK_API} in connect-src` : "no CSP on this site"}, ` +
    `linked from ${linkers.length} page(s)`,
);
