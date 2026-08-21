import { describe, expect, it } from "vitest";

import { REPAIR_BODY_SRC } from "../src/client/jxa/repair.js";

/**
 * The repair runs inside osascript, so the unit under test is a source string.
 * Evaluating it here keeps one copy: a regression that changes the shipped
 * script fails these assertions.
 */
const repairBody = new Function(`${REPAIR_BODY_SRC}\nreturn repairBody;`)() as (
  html: string,
) => string;

/**
 * What Notes' HTML parser does to a *well-formed* body on the way back in.
 *
 * Order is the whole point: runs of literal spaces collapse, and only then do
 * entities decode — so an `&nbsp;` survives as a space where a literal space
 * would not. Modelling it the other way round is what makes a broken repair
 * look like it works.
 */
const reparse = (html: string): string =>
  html
    .replace(/ {2,}/g, " ")
    .replace(/<div>/g, "")
    .replace(/<\/div>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("repairBody", () => {
  // Captured verbatim from Notes' body() getter — see repair.ts.
  it("terminates the entities the getter leaves open", () => {
    expect(repairBody("<div>ends with ps.&quotprojectId&quot;</div>")).toBe(
      "<div>ends with ps.&quot;projectId&quot;;</div>",
    );
  });

  it("keeps the semicolon that an unrepaired round trip eats", () => {
    // Unrepaired, the trailing `&quot` fuses with the literal `;` after it into
    // one `"`, and the semicolon is gone. `reparse` models a well-formed body
    // only, so the loss is asserted on the repaired form: the `;` survives.
    const fromGetter = "<div>ends with ps.&quotprojectId&quot;</div>";
    expect(reparse(repairBody(fromGetter))).toBe('ends with ps."projectId";\n');
  });

  it("does not mangle a literal ampersand or a literal entity", () => {
    const fromGetter = "<div>amp test: a &amp b &ampquot; c</div>";
    expect(reparse(repairBody(fromGetter))).toBe("amp test: a & b &quot; c\n");
  });

  it("preserves indentation that HTML would collapse", () => {
    expect(reparse(repairBody("<div>   indented 3</div>"))).toBe("   indented 3\n");
    expect(reparse(repairBody("<div>a    b</div>"))).toBe("a    b\n");
  });

  it("preserves a single leading space", () => {
    expect(reparse(repairBody("<div> one</div>"))).toBe(" one\n");
  });

  it("leaves already-correct markup alone", () => {
    expect(repairBody("<div>plain text</div>")).toBe("<div>plain text</div>");
  });

  it("does not double-terminate the semicolons it just added", () => {
    expect(repairBody("<div>a  b</div>")).not.toContain("&nbsp;;");
  });
});
