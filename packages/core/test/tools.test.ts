import { describe, expect, it } from "vitest";

import { fail, ok, okText, resolveLimit } from "../src/tools.js";

const text = (r: { content: { text: string }[] }): string => r.content[0]!.text;

describe("resolveLimit", () => {
  /**
   * The bug this helper exists to prevent. Three surfaces spelled the fallback
   * `limit ?? maxResults`, so omitting the argument returned 200 rows while
   * `limitArg` told the model the default was 25.
   */
  it("falls back to the tool's default, not the ceiling", () => {
    expect(resolveLimit(undefined, 200)).toBe(25);
  });

  it("honours a per-tool default where one is stated", () => {
    expect(resolveLimit(undefined, 200, 50)).toBe(50);
  });

  it("passes a caller's own limit through", () => {
    expect(resolveLimit(10, 200)).toBe(10);
  });

  /** maxResults stays the ceiling, whatever the caller or the default asks for. */
  it("clamps a caller above the ceiling", () => {
    expect(resolveLimit(500, 200)).toBe(200);
  });

  it("clamps a default above the ceiling", () => {
    expect(resolveLimit(undefined, 10, 50)).toBe(10);
  });
});

describe("result shaping", () => {
  /**
   * Compact, not pretty-printed: indentation is 19-24% of a list reply on these
   * surfaces' own row shapes, and no model needs it.
   */
  it("serializes compactly", () => {
    expect(text(ok({ a: 1, b: [2, 3] }))).toBe('{"a":1,"b":[2,3]}');
  });

  it("says ok when a tool returns nothing", () => {
    expect(text(ok(undefined))).toBe('{"ok":true}');
  });

  it("marks a failure and keeps its detail", () => {
    const r = fail("no", { kind: "TestError" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r))).toEqual({ error: "no", details: { kind: "TestError" } });
  });

  /** `okText` exists so a body is not JSON-escaped into one unreadable line. */
  it("leaves raw text alone", () => {
    expect(text(okText("Hi,\n\nthere"))).toBe("Hi,\n\nthere");
  });
});
