import { describe, expect, it } from "vitest";

import { settleGroups } from "../src/batch.js";
import {
  AppNotRunningError,
  OsascriptTimeoutError,
  ProtocolError,
  TccDeniedError,
  type SurfaceContext,
} from "../src/errors.js";

const SURFACE: SurfaceContext = { appName: "TestApp", envPrefix: "TEST_APP" };

type Group = { name: string; refs: string[] };

const A: Group = { name: "A", refs: ["a1", "a2"] };
const B: Group = { name: "B", refs: ["b1"] };
const C: Group = { name: "C", refs: ["c1"] };

/** One script per group: answers each ref ok, or throws what the group is mapped to. */
const runner =
  (fails: Record<string, Error> = {}) =>
  async (group: Group) => {
    const thrown = fails[group.name];
    if (thrown) throw thrown;
    return group.refs.map((ref) => ({ ref, ok: true }));
  };

const settle = (fails: Record<string, Error>) =>
  settleGroups([A, B, C], (g) => g.refs, runner(fails));

/**
 * A batch write runs one script per group, and each one APPLIES before the next
 * starts. A throwing group used to discard every row already collected, so the
 * tool answered with a bare error although earlier groups had been changed:
 * the caller was told nothing happened, and a retry ran them a second time.
 */
describe("settleGroups", () => {
  it("keeps earlier groups' rows when a later one fails, and goes on", async () => {
    const { rows, unknown } = await settle({
      B: new ProtocolError("No mailbox B", { code: "MAILBOX_NOT_FOUND" }),
    });
    expect(unknown).toBe(0);
    expect(rows).toEqual([
      { ref: "a1", ok: true },
      { ref: "a2", ok: true },
      { ref: "b1", ok: false, error: "No mailbox B", code: "MAILBOX_NOT_FOUND" },
      { ref: "c1", ok: true },
    ]);
  });

  it("names the error class when the error carries no code", async () => {
    const { rows } = await settle({ B: new Error("boom") });
    expect(rows[2]).toEqual({ ref: "b1", ok: false, error: "boom", code: "Error" });
  });

  /** A timed-out script may have applied, so its rows are neither ok nor failed. */
  it("reports a timed-out group as unknown, not as failed", async () => {
    const { rows, unknown } = await settle({ B: new OsascriptTimeoutError(30_000, SURFACE) });
    expect(unknown).toBe(1);
    expect(rows[2]).toMatchObject({ ref: "b1", ok: null });
    expect(rows[3]).toEqual({ ref: "c1", ok: true });
  });

  /** No later group can do better without a permission or a running app. */
  it("stops at a surface-wide error and marks the rest not attempted", async () => {
    const { rows } = await settle({ B: new TccDeniedError(SURFACE) });
    expect(rows.slice(0, 2)).toEqual([
      { ref: "a1", ok: true },
      { ref: "a2", ok: true },
    ]);
    expect(rows[2]).toMatchObject({ ref: "b1", ok: false, code: "TccDeniedError" });
    expect(rows[3]).toMatchObject({ ref: "c1", ok: false, notAttempted: true });
  });

  /** Nothing applied, so a plain error is the honest answer, as it always was. */
  it("rethrows the first error when no group succeeded", async () => {
    const first = new AppNotRunningError(SURFACE);
    await expect(settleGroups([A], (g) => g.refs, runner({ A: first }))).rejects.toBe(first);
    await expect(
      settleGroups([A, B], (g) => g.refs, runner({ A: first, B: new Error("second") })),
    ).rejects.toBe(first);
  });

  it("keeps an all-unknown result rather than claiming nothing happened", async () => {
    const { rows, unknown } = await settleGroups(
      [B],
      (g) => g.refs,
      runner({ B: new OsascriptTimeoutError(30_000, SURFACE) }),
    );
    expect(unknown).toBe(1);
    expect(rows).toHaveLength(1);
  });
});
