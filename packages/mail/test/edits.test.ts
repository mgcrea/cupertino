import { describe, expect, it } from "vitest";

import { applyEdits, applyHtmlEdits, htmlText, sameQuote } from "../src/client/edits.js";

/**
 * The TypeScript twin of the app's `MailComposerText`.
 *
 * The cases are the Swift ones in `scripts/mail-composer-check.swift`, ported
 * one for one: a draft whose window is closed is edited here, before any window
 * exists, and it must match exactly what the app would have matched in an open
 * one. Every whitespace run folds to one space on both sides; each find must
 * match once; the result keeps the original text around every match.
 */

const result = (edits: { find: string; replace: string }[], own: string): string | null => {
  const matched = applyEdits(edits, own);
  return matched.kind === "ok" ? matched.result : null;
};

describe("applyEdits", () => {
  it("a single edit replaces its match in place", () => {
    expect(result([{ find: "two", replace: "2" }], "one\ntwo")).toBe("one\n2");
  });

  it("a find spanning a line break matches across paragraphs", () => {
    expect(result([{ find: "one two", replace: "x" }], "one\ntwo")).toBe("x");
  });

  it("a find matches through a run of blank lines", () => {
    expect(result([{ find: "one two", replace: "x" }], "one\n\n  \ntwo")).toBe("x");
  });

  it("a repeated find is ambiguous, with its count", () => {
    expect(applyEdits([{ find: "a", replace: "b" }], "a a")).toEqual({
      kind: "ambiguous",
      find: "a",
      count: 2,
    });
  });

  it("a missing find is not found", () => {
    expect(applyEdits([{ find: "z", replace: "b" }], "a")).toEqual({ kind: "notFound", find: "z" });
  });

  it("an empty find is not found", () => {
    expect(applyEdits([{ find: "", replace: "b" }], "a b")).toEqual({
      kind: "notFound",
      find: "",
    });
  });

  it("edits whose matches intersect are overlapping", () => {
    expect(
      applyEdits(
        [
          { find: "a b", replace: "x" },
          { find: "b c", replace: "y" },
        ],
        "a b c",
      ),
    ).toEqual({ kind: "overlapping" });
  });

  it("edits that only touch are not overlapping", () => {
    expect(
      result(
        [
          { find: "a ", replace: "x" },
          { find: "b", replace: "y" },
        ],
        "a b",
      ),
    ).toBe("xy");
  });

  it("several edits apply right to left against the original text", () => {
    expect(
      result(
        [
          { find: "one", replace: "1111" },
          { find: "three", replace: "3" },
        ],
        "one two\nthree",
      ),
    ).toBe("1111 two\n3");
  });

  it("matches index the original text, in edit order", () => {
    const own = "x\ny z";
    const matched = applyEdits(
      [
        { find: "z", replace: "Z" },
        { find: "x y", replace: "Q" },
      ],
      own,
    );
    expect(matched.kind).toBe("ok");
    if (matched.kind !== "ok") return;
    expect(matched.matches.map((m) => own.slice(m.start, m.end))).toEqual(["z", "x\ny"]);
  });

  it("non-ASCII text matches and keeps its surroundings", () => {
    expect(result([{ find: "ça", replace: "ok" }], "Désolé — ça marche")).toBe(
      "Désolé — ok marche",
    );
  });

  /* Overlapping hits are counted, as the Swift does: "aa" in "aaa" is two places. */
  it("counts overlapping hits of one find", () => {
    expect(applyEdits([{ find: "aa", replace: "b" }], "aaa")).toEqual({
      kind: "ambiguous",
      find: "aa",
      count: 2,
    });
  });

  /* A character is a grapheme, as a Swift Character is: an emoji is never split. */
  it("never matches inside an emoji", () => {
    expect(result([{ find: "👍", replace: "ok" }], "marche 👍🏽 et 👍")).toBe("marche 👍🏽 et ok");
  });
});

describe("sameQuote", () => {
  it("a quote header is the same quote across a line break", () => {
    expect(sameQuote("On 22 Oct, X wrote:\nHi", "On 22 Oct, X wrote: Hi")).toBe(true);
  });

  it("different quotes are not the same", () => {
    expect(sameQuote("On 22 Oct, X wrote:\nHi", "On 23 Oct, X wrote: Hi")).toBe(false);
  });
});

/*
 * Final review M2: a closed formatted draft is edited in its HTML, and HTML
 * shows a bare newline as a space, so a two-line replacement used to land as
 * one line while the folded read-back still matched.
 */
describe("applyHtmlEdits", () => {
  it("turns a line break in a replacement into <br>, which reads back as a line break", () => {
    const edited = applyHtmlEdits(
      [{ find: "see you", replace: "see you\nOlivier" }],
      "<div>Thanks, see you</div>",
    );
    expect(edited).toMatchObject({
      kind: "ok",
      html: "<div>Thanks, see you<br>Olivier</div>",
    });
    expect(edited.kind === "ok" && htmlText(edited.html)).toBe("\nThanks, see you\nOlivier\n");
  });

  it("keeps a newline already in the run's source as it was, and encodes the rest", () => {
    const edited = applyHtmlEdits(
      [{ find: "two", replace: "2 < 3\r\nfour" }],
      "<p>one\ntwo &amp; three</p>",
    );
    expect(edited).toMatchObject({ kind: "ok", html: "<p>one\n2 &lt; 3<br>four &amp; three</p>" });
  });

  it("applies several edits in one run, each in its place", () => {
    const edited = applyHtmlEdits(
      [
        { find: "alpha", replace: "A\nA" },
        { find: "gamma", replace: "G" },
      ],
      "<div>alpha beta gamma</div>",
    );
    expect(edited).toMatchObject({ kind: "ok", html: "<div>A<br>A beta G</div>" });
  });
});
