import { describe, expect, it } from "vitest";

import { urlVariants } from "../src/client/match.js";

/**
 * The join between Safari's two lanes is a URL, and this is the ladder that
 * makes it survive the cosmetic differences between the URL a tab shows and the
 * URL Safari committed to history.
 *
 * The invariant that matters most is ORDER: the ladder is walked first-hit-wins
 * by `AppleSafariClient.tabs`, so a looser rung placed above a tighter one
 * would silently start reporting weaker matches as strong ones.
 */
const urls = (u: string): string[] => urlVariants(u).map((v) => v.url);
const kindOf = (u: string, candidate: string): string | undefined =>
  urlVariants(u).find((v) => v.url === candidate)?.kind;

describe("the variant ladder", () => {
  it("always offers the exact URL first", () => {
    const ladder = urlVariants("https://example.com/a?b=1#frag");
    expect(ladder[0]).toEqual({ url: "https://example.com/a?b=1#frag", kind: "exact" });
  });

  it("puts the query-stripped rung last, so a faithful match always wins", () => {
    const ladder = urlVariants("https://example.com/search?q=weather&utm_source=x");
    const stripped = ladder.findIndex((v) => v.kind === "query-stripped");
    expect(stripped).toBe(ladder.length - 1);
    // And the rung that keeps `q` is above it, so `/search?q=weather` is
    // preferred over the bare `/search` it would otherwise collapse into.
    expect(ladder[stripped]?.url).toBe("https://example.com/search");
    expect(urls("https://example.com/search?q=weather&utm_source=x")).toContain(
      "https://example.com/search?q=weather",
    );
  });

  it("drops tracking parameters but keeps the ones a page reads", () => {
    // `v` identifies the video. Dropping it would match one video to another.
    expect(urls("https://example.com/watch?v=abc&utm_campaign=x&fbclid=y")).toContain(
      "https://example.com/watch?v=abc",
    );
  });

  it("sorts surviving parameters, so link order stops mattering", () => {
    const a = urls("https://example.com/p?b=2&a=1");
    const b = urls("https://example.com/p?a=1&b=2");
    expect(a).toContain("https://example.com/p?a=1&b=2");
    expect(b).toContain("https://example.com/p?a=1&b=2");
  });

  it("covers fragment, trailing slash, scheme and www", () => {
    expect(urls("https://example.com/a#top")).toContain("https://example.com/a");
    expect(urls("https://example.com/a")).toContain("https://example.com/a/");
    expect(urls("https://example.com/a/")).toContain("https://example.com/a");
    expect(urls("https://example.com/a")).toContain("http://example.com/a");
    expect(urls("https://www.example.com/a")).toContain("https://example.com/a");
    expect(urls("https://example.com/a")).toContain("https://www.example.com/a");
  });

  it("calls a cosmetic difference `normalized`, never `exact`", () => {
    expect(kindOf("https://example.com/a#top", "https://example.com/a")).toBe("normalized");
  });

  /**
   * A query made ENTIRELY of tracking parameters is a special case worth
   * keeping: removing it lands on the same URL the blunt query-stripping rung
   * would, but it got there faithfully — nothing the page reads was discarded.
   * Dedup keeps the first, stronger rung, so this reports `normalized`.
   */
  it("reports a fully-tracking query as normalized rather than query-stripped", () => {
    expect(kindOf("https://example.com/a?utm_source=x&fbclid=y", "https://example.com/a")).toBe(
      "normalized",
    );
  });

  /** Whereas discarding a parameter the page reads is the weak rung. */
  it("reports a match that cost a real parameter as query-stripped", () => {
    expect(kindOf("https://example.com/a?q=weather", "https://example.com/a")).toBe(
      "query-stripped",
    );
  });

  /**
   * Safari shows `about:blank`, `file://` and native error pages. None of them
   * has a `www.` to peel or a scheme worth swapping, and a thrown `URL` here
   * would take out the whole tab list.
   */
  it("degrades to the exact URL alone for anything unparseable or non-http", () => {
    expect(urls("about:blank")).toEqual(["about:blank"]);
    expect(urls("not a url at all")).toEqual(["not a url at all"]);
    expect(urls("file:///Users/x/page.html")).toEqual(["file:///Users/x/page.html"]);
  });

  it("stays short and duplicate-free on a plain URL", () => {
    const ladder = urls("https://example.com/");
    expect(new Set(ladder).size).toBe(ladder.length);
    // The whole set of ladders for every open tab goes into one SQL `IN`, so a
    // combinatorial expansion here would be paid per tab.
    expect(ladder.length).toBeLessThanOrEqual(6);
  });
});
