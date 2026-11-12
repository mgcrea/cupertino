import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { swiftString } from "./swift-string.mjs";

/**
 * What the Swift generators write for each awkward input. Every row from
 * "escape" to "paragraph separator" is one `JSON.stringify`, which they used
 * before, got wrong: the first four as escapes Swift does not accept, DEL as an
 * unprintable character Swift refuses in source, and the separators as raw
 * characters that compile but cannot be seen in a diff.
 */
const CASES = [
  ["plain", "Mail", '"Mail"'],
  ["quote and backslash", 'a "b" \\ c', '"a \\"b\\" \\\\ c"'],
  ["newline, return and tab", "a\nb\rc\td", '"a\\nb\\rc\\td"'],
  ["an interpolation stays text", "\\(x)", '"\\\\(x)"'],
  ["escape", "a\u001bb", '"a\\u{1b}b"'],
  ["NUL", "a\u0000b", '"a\\u{0}b"'],
  ["backspace", "a\bb", '"a\\u{8}b"'],
  ["form feed", "a\fb", '"a\\u{c}b"'],
  ["DEL", "a\u007fb", '"a\\u{7f}b"'],
  ["line separator", "a b", '"a\\u{2028}b"'],
  ["paragraph separator", "a b", '"a\\u{2029}b"'],
  ["non-ASCII stays literal", "é — «» “x” 😀", '"é — «» “x” 😀"'],
];

describe("swiftString", () => {
  for (const [label, input, literal] of CASES) {
    it(label, () => assert.equal(swiftString(input), literal));
  }

  it("refuses a lone surrogate, which no Swift string can hold", () => {
    assert.throws(() => swiftString("a\ud800b"), /lone surrogate/);
  });

  it("refuses what is not a string", () => {
    assert.throws(() => swiftString(1), TypeError);
    assert.throws(() => swiftString(null), TypeError);
  });

  // The table above is what the generators were believed to do. This is the
  // compiler agreeing: every literal compiles and reads back as the same scalars.
  const hasSwiftc = spawnSync("swiftc", ["--version"]).status === 0;
  it("round-trips through swiftc", { skip: !hasSwiftc }, () => {
    const dir = mkdtempSync(join(tmpdir(), "swift-string-"));
    try {
      const inputs = CASES.map(([, input]) => input);
      writeFileSync(
        join(dir, "main.swift"),
        `let xs: [String] = [\n${inputs.map((x) => `  ${swiftString(x)},`).join("\n")}\n]\n` +
          `for s in xs { print(s.unicodeScalars.map { String($0.value) }.joined(separator: ",")) }\n`,
      );
      const built = spawnSync("swiftc", ["main.swift", "-o", "main"], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(built.status, 0, built.stderr);
      const ran = spawnSync(join(dir, "main"), { encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
      assert.deepEqual(
        ran.stdout.trimEnd().split("\n"),
        inputs.map((x) => [...x].map((c) => c.codePointAt(0)).join(",")),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
