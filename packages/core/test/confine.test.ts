import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeConfinedFile } from "../src/confine.js";
import { PreconditionError } from "../src/errors.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch root, resolved — the temp directory is under a symlink on macOS. */
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "confine-")));
  dirs.push(dir);
  return dir;
};

const bytes = new TextEncoder().encode("CONTENT");
const settingName = "APPLE_EXAMPLE_ATTACHMENT_DIR";

describe("writeConfinedFile", () => {
  it("writes inside the root, 0600, and reports where", () => {
    const root = join(scratch(), "Downloads");
    const out = writeConfinedFile({ root, name: "invoice.pdf", bytes, settingName });
    expect(out.path).toBe(join(root, "invoice.pdf"));
    expect(out.bytes).toBe(bytes.length);
    expect(readFileSync(out.path, "utf8")).toBe("CONTENT");
  });

  it.each(["../escaped.pdf", "../../../../etc/passwd", "/absolute/path.pdf", "a/b/c.pdf"])(
    "basenames %s rather than letting it traverse",
    (name) => {
      const root = join(scratch(), "Downloads");
      const out = writeConfinedFile({ root, name, bytes, settingName });
      expect(out.path.startsWith(root)).toBe(true);
      expect(out.path).not.toContain("..");
    },
  );

  it("lets the caller choose a subdirectory of the root", () => {
    const root = join(scratch(), "Downloads");
    const out = writeConfinedFile({
      root,
      directory: "receipts",
      name: "a.pdf",
      bytes,
      settingName,
    });
    expect(out.path).toBe(join(root, "receipts", "a.pdf"));
  });

  it("refuses a directory outside the root, and names the setting to change", () => {
    const root = join(scratch(), "Downloads");
    expect(() =>
      writeConfinedFile({ root, directory: "/etc", name: "a.pdf", bytes, settingName }),
    ).toThrow(PreconditionError);
    try {
      writeConfinedFile({ root, directory: "../elsewhere", name: "a.pdf", bytes, settingName });
      expect.unreachable("a directory above the root must be refused");
    } catch (error) {
      expect((error as Error).message).toContain(settingName);
    }
  });

  /*
   * The hole all three hand-written copies had. `startsWith(root + sep)`
   * compares STRINGS, and a symlink is a string that points somewhere else: the
   * path passed the check and the bytes landed outside the root.
   */
  it("refuses a subdirectory that is a symlink out of the root", () => {
    const base = scratch();
    const root = join(base, "Downloads");
    const outside = join(base, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, "escape"));

    expect(() =>
      writeConfinedFile({ root, directory: "escape", name: "a.pdf", bytes, settingName }),
    ).toThrow(PreconditionError);
    expect(() => readFileSync(join(outside, "a.pdf"))).toThrow();
  });

  it("refuses when the root itself is a symlink pointing elsewhere only if it escapes", () => {
    const base = scratch();
    const real = join(base, "real");
    mkdirSync(real, { recursive: true });
    const link = join(base, "link");
    symlinkSync(real, link);
    // A root that IS a link is fine: it is the confinement, so wherever it
    // resolves to is the boundary. What must not happen is a path escaping it.
    const out = writeConfinedFile({ root: link, name: "a.pdf", bytes, settingName });
    expect(out.path).toBe(join(real, "a.pdf"));
  });

  /*
   * Mail's bytes come out of a full parse of the message file. A refusal must
   * not pay for that, so a function is only called once every check passed.
   */
  it("does not produce the bytes for a write it refuses", () => {
    const root = join(scratch(), "Downloads");
    let produced = 0;
    const lazy = () => {
      produced += 1;
      return bytes;
    };
    expect(() =>
      writeConfinedFile({ root, directory: "/etc", name: "a.pdf", bytes: lazy, settingName }),
    ).toThrow(PreconditionError);
    expect(produced).toBe(0);
    const out = writeConfinedFile({ root, name: "a.pdf", bytes: lazy, settingName });
    expect(produced).toBe(1);
    expect(out.bytes).toBe(bytes.length);
  });

  /*
   * `existsSync` then `writeFileSync` is check-then-act. `wx` makes the refusal
   * and the write one operation the kernel performs.
   */
  it("refuses an existing file rather than overwriting it", () => {
    const root = join(scratch(), "Downloads");
    writeConfinedFile({ root, name: "a.pdf", bytes, settingName });
    expect(() => writeConfinedFile({ root, name: "a.pdf", bytes, settingName })).toThrow(
      /already exists/,
    );
  });

  it("overwrites when asked", () => {
    const root = join(scratch(), "Downloads");
    writeConfinedFile({ root, name: "a.pdf", bytes, settingName });
    const second = new TextEncoder().encode("REPLACED");
    const out = writeConfinedFile({
      root,
      name: "a.pdf",
      bytes: second,
      overwrite: true,
      settingName,
    });
    expect(readFileSync(out.path, "utf8")).toBe("REPLACED");
  });
});
