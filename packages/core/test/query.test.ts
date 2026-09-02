import { describe, expect, it } from "vitest";

import { describeAggregation, project } from "../src/query.js";

const KNOWN = ["ref", "subject", "sender", "size"] as const;

const rows = [
  { ref: "m1:a/INBOX#1", subject: "Invoice", sender: "billing@domaine.fr", size: 5000 },
  { ref: "m1:a/INBOX#2", subject: "Lunch?", sender: "sam@example.com", size: 2000 },
];

describe("project", () => {
  it("returns rows untouched when nothing is selected", () => {
    expect(project(rows, undefined, KNOWN)).toEqual({ rows });
    expect(project(rows, [], KNOWN)).toEqual({ rows });
  });

  it("keeps only the named fields", () => {
    const { rows: out, unknownFields } = project(rows, ["ref", "size"], KNOWN);
    expect(out).toEqual([
      { ref: "m1:a/INBOX#1", size: 5000 },
      { ref: "m1:a/INBOX#2", size: 2000 },
    ]);
    expect(unknownFields).toBeUndefined();
  });

  /*
   * The point of reporting rather than dropping: a silently ignored field name
   * is indistinguishable from a field that was null on every row, and the model
   * has no way to tell those apart.
   */
  it("reports a name this surface does not have, and still projects the rest", () => {
    const { rows: out, unknownFields } = project(rows, ["ref", "priority"], KNOWN);
    expect(out).toEqual([{ ref: "m1:a/INBOX#1" }, { ref: "m1:a/INBOX#2" }]);
    expect(unknownFields).toEqual(["priority"]);
  });

  it("hands back the full row when every name was wrong", () => {
    const { rows: out, unknownFields } = project(rows, ["nope", "alsoNope"], KNOWN);
    expect(out).toEqual(rows);
    expect(unknownFields).toEqual(["nope", "alsoNope"]);
  });

  it("still reports a bad name on an empty result", () => {
    // The case a rows-derived key set would miss entirely — and the one where a
    // typo is the most likely reason there are no rows.
    expect(project([], ["priority"], KNOWN).unknownFields).toEqual(["priority"]);
  });
});

describe("describeAggregation", () => {
  const groups = [
    { key: "a", count: 2 },
    { key: "b", count: 1 },
  ];

  it("marks a top-N as truncated", () => {
    const agg = describeAggregation("sender", groups, { totalGroups: 9, totalRows: 40 });
    expect(agg.truncated).toBe(true);
    expect(agg.totalRows).toBe(40);
  });

  it("does not mark a complete list as truncated", () => {
    const agg = describeAggregation("sender", groups, { totalGroups: 2, totalRows: 3 });
    expect(agg.truncated).toBe(false);
  });
});
