import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultContainerPath, GROUP_CONTAINER, locateStore } from "../src/client/locate.js";

const home = () => mkdtempSync(join(tmpdir(), "mcp-apple-reminders-home-"));
const container = (h: string) => join(h, "Library", "Group Containers", GROUP_CONTAINER);

const makeStore = (h: string, ...segments: string[]) => {
  const dir = join(container(h), ...segments.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, segments.at(-1) as string);
  writeFileSync(path, "");
  return path;
};

describe("defaultContainerPath", () => {
  it("points at the group container, not ~/Library/Reminders", () => {
    // ~/Library/Reminders does not exist on macOS 26 — a commonly cited path
    // that is simply wrong, and worth pinning so it does not creep back in.
    expect(defaultContainerPath("/Users/x")).toBe(
      "/Users/x/Library/Group Containers/group.com.apple.reminders",
    );
  });
});

describe("locateStore", () => {
  it("finds the store in the preferred Container_v1/Stores layout", () => {
    const h = home();
    const path = makeStore(h, "Container_v1", "Stores", "Data-ABC123.sqlite");
    const got = locateStore({ home: h });
    expect(got.storePath).toBe(path);
    expect(got.readable).toBe(true);
    expect(got.reason).toBeNull();
  });

  /**
   * The preferred subpath is observed, not documented — Apple has moved this
   * data before. A store somewhere else in the container must still be found.
   */
  it("falls back to a walk when the layout changes", () => {
    const h = home();
    const path = makeStore(h, "SomeOtherPlace", "Data-XYZ.sqlite");
    expect(locateStore({ home: h }).storePath).toBe(path);
  });

  it("prefers the largest readable candidate over readdir order", () => {
    const h = home();
    const small = makeStore(h, "Container_v1", "Stores", "Data-AAA.sqlite");
    const big = makeStore(h, "Container_v1", "Stores", "Data-ZZZ.sqlite");
    writeFileSync(small, "x");
    writeFileSync(big, "x".repeat(4096));
    const got = locateStore({ home: h });
    expect(got.storePath).toBe(big);
    expect(got.candidates).toHaveLength(2);
  });

  /**
   * The distinction that decides which fix to suggest. "Cannot list the
   * container" is a permission problem; "listed it, found nothing" means
   * Reminders was never set up. Conflating them sends people to the wrong pane.
   */
  it("says the store cannot be located when the container is absent", () => {
    const got = locateStore({ home: home() });
    expect(got.storePath).toBeNull();
    expect(got.containerListable).toBe(false);
    expect(got.reason).toMatch(/cannot even be located/);
    expect(got.reason).toMatch(/Full Disk Access/);
  });

  it("says Reminders was never set up when the container is empty", () => {
    const h = home();
    mkdirSync(container(h), { recursive: true });
    writeFileSync(join(container(h), "placeholder.txt"), "");
    const got = locateStore({ home: h });
    expect(got.storePath).toBeNull();
    expect(got.containerListable).toBe(true);
    expect(got.reason).toMatch(/never been set up|Has Reminders ever/);
  });

  it("honours an explicit store path without discovery", () => {
    const h = home();
    const path = makeStore(h, "elsewhere", "custom.sqlite");
    const got = locateStore({ storePath: path });
    expect(got.storePath).toBe(path);
    expect(got.readable).toBe(true);
  });

  it("reports an explicit path that points at nothing", () => {
    const got = locateStore({ storePath: "/nope/missing.sqlite" });
    expect(got.exists).toBe(false);
    expect(got.reason).toMatch(/APPLE_REMINDERS_STORE/);
  });

  it("notices a write-ahead log beside the store", () => {
    const h = home();
    const path = makeStore(h, "Container_v1", "Stores", "Data-A.sqlite");
    writeFileSync(`${path}-wal`, "x".repeat(64));
    const got = locateStore({ home: h });
    expect(got.walPresent).toBe(true);
    expect(got.walSizeBytes).toBe(64);
  });
});
