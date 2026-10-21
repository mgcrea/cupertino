import { describe, expect, it } from "vitest";

import {
  decodeBase64,
  REDACTED_HEADER,
  redactHeaders,
  resolveJsonPath,
  sniffType,
} from "../src/client/network.js";

describe("resolveJsonPath", () => {
  it("walks dotted keys", () => {
    expect(
      resolveJsonPath({ data: { document: { content: "QQ==" } } }, "data.document.content"),
    ).toEqual({
      ok: true,
      value: "QQ==",
    });
  });

  it("accepts a leading $ and numeric indices", () => {
    expect(resolveJsonPath({ items: [{ pdf: "x" }] }, "$.items[0].pdf")).toEqual({
      ok: true,
      value: "x",
    });
  });

  it("reads a quoted key that contains a dot", () => {
    expect(resolveJsonPath({ "a.b": 1 }, '["a.b"]')).toEqual({ ok: true, value: 1 });
  });

  it("names the parent and the keys that do exist when a key is missing", () => {
    const r = resolveJsonPath({ data: { document: { content: 1 } } }, "data.document.contnet");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("data.document");
      expect(r.error).toContain("content");
    }
  });

  it("reports the index and the length when an index is out of range", () => {
    const r = resolveJsonPath({ items: [1] }, "items[3]");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("index 3");
      expect(r.error).toContain("length 1");
    }
  });

  it("refuses to step into a scalar", () => {
    expect(resolveJsonPath({ a: 1 }, "a.b").ok).toBe(false);
  });

  it("reports malformed paths instead of throwing", () => {
    expect(resolveJsonPath({}, "a[").ok).toBe(false);
    expect(resolveJsonPath({}, "a[x]").ok).toBe(false);
    expect(resolveJsonPath({}, 'a["b]').ok).toBe(false);
    expect(resolveJsonPath({}, "a..b").ok).toBe(false);
  });

  it("does not read inherited properties", () => {
    expect(resolveJsonPath({}, "constructor").ok).toBe(false);
  });
});

describe("decodeBase64", () => {
  it("decodes the standard alphabet", () => {
    expect(decodeBase64("JVBERi0=").subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("strips a data: URL prefix", () => {
    expect(decodeBase64("data:application/pdf;base64,JVBERi0=")).toEqual(decodeBase64("JVBERi0="));
  });

  it("accepts the URL-safe alphabet", () => {
    expect(decodeBase64("-_-_")).toEqual(decodeBase64("+/+/"));
  });

  it("throws on characters outside the alphabet instead of skipping them", () => {
    expect(() => decodeBase64("JVBER*")).toThrow();
  });
});

describe("sniffType", () => {
  it("recognises a PDF", () => {
    expect(sniffType(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
  });

  it("recognises PNG, JPEG, GIF, ZIP and JSON", () => {
    expect(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    expect(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("application/zip");
    expect(sniffType(Buffer.from('{"a":1}'))).toBe("application/json");
    expect(sniffType(Buffer.from("[1]"))).toBe("application/json");
  });

  it("returns null for unknown bytes", () => {
    expect(sniffType(Buffer.from("hello"))).toBeNull();
    expect(sniffType(Buffer.alloc(0))).toBeNull();
  });
});

describe("redactHeaders", () => {
  it("replaces secret values with their length and leaves the rest", () => {
    expect(
      redactHeaders({ Authorization: "Bearer abc", "X-Api-Key": "k", "Content-Type": "a/b" }),
    ).toEqual({
      Authorization: "<redacted: 10 chars>",
      "X-Api-Key": "<redacted: 1 chars>",
      "Content-Type": "a/b",
    });
  });

  it("matches the documented names and substrings, case-insensitively", () => {
    for (const name of [
      "cookie",
      "Set-Cookie",
      "Proxy-Authorization",
      "x-csrf-token",
      "X-Secret",
      "apikey",
    ]) {
      expect(REDACTED_HEADER.test(name)).toBe(true);
    }
    for (const name of ["accept", "content-type", "authorization-info"]) {
      expect(REDACTED_HEADER.test(name)).toBe(false);
    }
  });

  it("exposes a flag-light pattern the content script can mirror", () => {
    expect(REDACTED_HEADER.flags).toBe("i");
  });
});
