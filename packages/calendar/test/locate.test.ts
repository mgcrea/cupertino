import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultContainerPath,
  defaultStorePath,
  GROUP_CONTAINER,
  locateStore,
  STORE_FILENAME,
} from "../src/client/locate.js";

const home = () => mkdtempSync(join(tmpdir(), "mcp-apple-calendar-home-"));
const container = (h: string) => join(h, "Library", "Group Containers", GROUP_CONTAINER);

const makeStore = (h: string, name = STORE_FILENAME, bytes = 16) => {
  mkdirSync(container(h), { recursive: true });
  const path = join(container(h), name);
  writeFileSync(path, "x".repeat(bytes));
  return path;
};

describe("defaultStorePath", () => {
  /**
   * `~/Library/Calendars` is the path docs/distribution.md originally checked,
   * found absent, and concluded from that Calendar needed EventKit. It is
   * genuinely absent; the conclusion did not follow, because only one of the two
   * candidate roots had been looked at. Pinned so the wrong one cannot creep back.
   */
  it("points at the group container, not ~/Library/Calendars", () => {
    expect(defaultContainerPath("/Users/x")).toBe(
      "/Users/x/Library/Group Containers/group.com.apple.calendar",
    );
    expect(defaultStorePath("/Users/x")).toBe(
      "/Users/x/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb",
    );
  });
});

describe("locateStore", () => {
  it("finds the store at its known filename", () => {
    const h = home();
    const path = makeStore(h);
    const got = locateStore({ home: h });
    expect(got.storePath).toBe(path);
    expect(got.readable).toBe(true);
    expect(got.reason).toBeNull();
  });

  it("notices Extras.db beside the store", () => {
    const h = home();
    makeStore(h);
    writeFileSync(join(container(h), "Extras.db"), "");
    expect(locateStore({ home: h }).extrasPresent).toBe(true);
  });

  /**
   * The advantage over Reminders, and the reason diagnostics can be specific:
   * the filename is a constant, so a missing store is distinguishable from a
   * denied grant without any permission at all.
   */
  it("reports a container that exists but holds no store as a setup problem, not a permission one", () => {
    const h = home();
    mkdirSync(container(h), { recursive: true });
    writeFileSync(join(container(h), "unrelated.txt"), "");
    const got = locateStore({ home: h });
    expect(got.exists).toBe(false);
    expect(got.readable).toBe(false);
    expect(got.reason).toMatch(/Has Calendar ever been set up/);
  });

  it("prefers the known filename over a larger unknown file", () => {
    const h = home();
    const known = makeStore(h, STORE_FILENAME, 16);
    makeStore(h, "SomeOtherAccount.sqlitedb", 4096);
    // Size is a tie-breaker between unknowns, not evidence against a
    // documented filename.
    expect(locateStore({ home: h }).storePath).toBe(known);
  });

  it("treats an explicit path as a bypass and says so when it points at nothing", () => {
    const got = locateStore({ storePath: "/nope/missing.sqlitedb" });
    expect(got.storePath).toBe("/nope/missing.sqlitedb");
    expect(got.exists).toBe(false);
    expect(got.reason).toMatch(/APPLE_CALENDAR_STORE points at nothing/);
  });

  /**
   * The distinction packages/core/src/fs.ts exists to keep: `stat` succeeds on
   * a file you cannot read. "Absent" and "EPERM" lead to different fixes, and
   * conflating them is what put Calendar on a path toward EventKit it never
   * needed.
   */
  it("separates an unreadable store from a missing one", () => {
    const h = home();
    const path = makeStore(h);
    chmodSync(path, 0o000);
    const got = locateStore({ home: h });
    // Running as root defeats the chmod, so only assert when it took effect.
    if (!got.readable) {
      expect(got.exists).toBe(true);
      expect(got.reason).toMatch(/exists but cannot be read|cannot read it/);
      expect(got.reason).toMatch(/Full Disk Access/);
    }
    chmodSync(path, 0o600);
  });
});
