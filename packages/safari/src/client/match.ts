/**
 * The join between the two lanes, which is a URL and nothing else.
 *
 * ## Why this file exists
 *
 * Safari offers no opaque id shared between a live tab and a history row, so
 * the only key is the URL itself — trivially available and trivially lossy.
 * MEASURED, macOS 26.6, 76 open tabs: 19 matched exactly, 23 more only once the
 * query string came off, and 34 did not match at all.
 *
 * The lesson in those numbers is not "half of history is missing". It is that
 * the URL a tab is showing and the URL Safari committed to history differ in
 * ways that are mostly COSMETIC — a fragment, a trailing slash, a tracking
 * parameter added by whoever linked to it. Stripping the entire query string
 * recovered a third of the misses, which says the cosmetic difference is
 * usually IN the query. But it is a blunt instrument: it also matches
 * `/search?q=weather` to `/search`, which are not the same page.
 *
 * So this is a LADDER rather than a normaliser. The variants run from most to
 * least faithful, the first hit wins, and the caller is told which rung
 * matched. A match found by throwing the query away is a weaker claim than an
 * exact one, and a tool that reports both as `history` teaches a model to state
 * a visit count for a page somebody never opened.
 *
 * ## What is deliberately NOT here
 *
 * Following `redirect_source` / `redirect_destination`. Those columns link
 * VISITS, and both endpoints of a redirect already own their own
 * `history_items` row — so walking the chain cannot surface a URL that is not
 * already in the table. It addresses none of the 34 misses.
 */

/**
 * How faithfully a tab's URL matched the history row it was joined to.
 *
 * Ordered by strength, and the caller is expected to treat them differently:
 *
 *   exact          — byte-identical. USUALLY the row is about this page, but a
 *                    reused address defeats it: `http://localhost:4321/` is
 *                    whatever dev server ran last, and one measured run matched
 *                    a tab titled "Bastion" to a row titled "Skirdv". When the
 *                    tab's own title disagrees, the tab is right.
 *   normalized     — differed only in a fragment, a trailing slash, a scheme,
 *                    a `www.`, or a tracking parameter. Same page.
 *   query-stripped — matched only with the whole query string removed. The row
 *                    may be about a DIFFERENT view of the same path, so the
 *                    visit count is about the path rather than about this page.
 */
export type MatchKind = "exact" | "normalized" | "query-stripped";

/**
 * Parameters that identify who sent you, never what you are looking at.
 *
 * Kept to the ones that are unambiguously provenance. Anything arguably
 * load-bearing — `q`, `id`, `page`, `v` — stays, because dropping a parameter
 * the page actually reads is how `/watch?v=A` gets matched to `/watch?v=B`.
 */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "si",
  "_ga",
  "yclid",
]);

const isTracking = (key: string): boolean =>
  TRACKING_PARAMS.has(key) || key.startsWith("utm_") || key.startsWith("_hs");

/**
 * Every candidate spelling of one URL, most faithful first.
 *
 * The first element is always the input unchanged, so an exact match is always
 * reachable and always wins. `kind` travels with each variant because the
 * caller needs to report HOW it matched, not just that it did.
 *
 * Deduped, since most of these collapse together on a plain URL: a bare
 * `https://example.com/` produces two variants, not twelve. That matters
 * because the whole ladder for every open tab goes into one SQL `IN`.
 *
 * A URL `URL` cannot parse is not an error — Safari shows `about:blank`, local
 * files and error pages. It yields the single exact variant and joins or misses
 * on that alone.
 */
export const urlVariants = (url: string): { url: string; kind: MatchKind }[] => {
  const out: { url: string; kind: MatchKind }[] = [{ url, kind: "exact" }];
  const seen = new Set([url]);

  const add = (candidate: string, kind: MatchKind): void => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      out.push({ url: candidate, kind });
    }
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return out;
  }

  // Only http(s) has the equivalences below. `file:`, `about:` and custom
  // schemes get the exact variant and nothing else, because swapping the scheme
  // or peeling a `www.` off them is meaningless.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return out;

  // Each axis is applied to a fresh copy of a common base rather than
  // compounded, so the ladder stays a short list of single differences instead
  // of a combinatorial sweep of every scheme × host × slash × query.
  const base = new URL(parsed.href);
  base.hash = "";
  add(base.href, "normalized");

  const withParams = (fn: (u: URL) => void, kind: MatchKind): void => {
    const u = new URL(base.href);
    fn(u);
    add(u.href, kind);
  };

  // Trailing slash, both directions. `/a/` and `/a` are one page to a reader
  // and two rows to a UNIQUE index.
  withParams((u) => {
    u.pathname = u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : `${u.pathname}/`;
  }, "normalized");

  withParams((u) => {
    u.protocol = u.protocol === "https:" ? "http:" : "https:";
  }, "normalized");

  withParams((u) => {
    u.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  }, "normalized");

  // Tracking parameters off, survivors sorted. Sorting matters because two
  // links to the same page routinely carry the same parameters in a different
  // order, which a string comparison calls two different pages.
  if (parsed.search) {
    withParams((u) => {
      const kept = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
      kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      u.search = "";
      for (const [k, v] of kept) u.searchParams.append(k, v);
    }, "normalized");

    // Last rung, and the weakest: the whole query gone. This is the behaviour
    // the surface shipped with, and it is kept because it MEASURED well — 23 of
    // 76 tabs matched on it alone. It sits last so a more faithful rung always
    // wins, and it reports as `query-stripped` so the caller can discount it.
    withParams((u) => {
      u.search = "";
    }, "query-stripped");
  }

  return out;
};
