import { describe, expect, it } from "vitest";

import { searchableSubject } from "../src/client/mail.js";

describe("searchableSubject", () => {
  /*
   * MEASURED: the index keeps `Re: ` apart from the subject row it filters on,
   * so a reply draft searched by its full subject came back with nothing while
   * the same draft was sitting in Drafts.
   */
  it("drops the reply prefix the index stores apart from the subject", () => {
    expect(searchableSubject("Re: CR - Rendez-vous finalisation")).toBe(
      "CR - Rendez-vous finalisation",
    );
  });

  it("drops stacked and localised prefixes", () => {
    expect(searchableSubject("Re: Fwd: TR: lunch")).toBe("lunch");
    expect(searchableSubject("AW: Re[2]: lunch")).toBe("lunch");
  });

  it("leaves a subject with no prefix alone", () => {
    expect(searchableSubject("CR - Rendez-vous finalisation")).toBe(
      "CR - Rendez-vous finalisation",
    );
  });

  it("is empty for a subject that is only a prefix", () => {
    expect(searchableSubject("Re: ")).toBe("");
  });
});
