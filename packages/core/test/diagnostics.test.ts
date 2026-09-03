import { describe, expect, it } from "vitest";

import { buildBaseDiagnostics } from "../src/diagnostics.js";

const build = {
  name: "@mgcrea/mcp-apple-example",
  version: "1.10.0",
  gitCommit: "abc1234",
  gitCommitDate: "2026-09-03",
};

describe("buildBaseDiagnostics", () => {
  /*
   * The failure this exists to prevent: three surfaces reported their lane
   * status under `server` and so could not name their own build at all, which
   * is the first thing anyone asks about a server behaving oddly.
   */
  it("names the build, the runtime and the platform", () => {
    const { server } = buildBaseDiagnostics({
      build,
      config: { exposePrompts: true, lazyTools: false, maxResults: 200 },
      allowWrites: false,
    });
    expect(server).toEqual({
      name: "@mgcrea/mcp-apple-example",
      version: "1.10.0",
      gitCommit: "abc1234",
      node: process.version,
      platform: process.platform,
    });
  });

  /*
   * `allowWrites` comes from the tool context rather than from the config, so
   * the report cannot disagree with what was actually registered — Contacts'
   * diagnostics claimed the surface had no mutating tool for three releases
   * after two shipped.
   */
  it("reports the write gate it was handed, not the one in the config", () => {
    const config = { exposePrompts: true, lazyTools: false, maxResults: 50 };
    expect(buildBaseDiagnostics({ build, config, allowWrites: true }).settings.allowWrites).toBe(
      true,
    );
    expect(buildBaseDiagnostics({ build, config, allowWrites: false }).settings.allowWrites).toBe(
      false,
    );
  });

  it("carries the cost knobs every surface has", () => {
    const { settings } = buildBaseDiagnostics({
      build,
      config: { exposePrompts: false, lazyTools: true, maxResults: 25, indexMode: "ro" },
      allowWrites: false,
    });
    expect(settings).toEqual({
      allowWrites: false,
      exposePrompts: false,
      lazyTools: true,
      maxResults: 25,
      indexMode: "ro",
    });
  });

  /*
   * A surface with no SQLite lane must not report an index mode it does not
   * have: an absent key says "not applicable", where `"auto"` would say "on".
   */
  it("omits indexMode entirely for a surface that has no index", () => {
    const { settings } = buildBaseDiagnostics({
      build,
      config: { exposePrompts: true, lazyTools: false, maxResults: 200 },
      allowWrites: false,
    });
    expect("indexMode" in settings).toBe(false);
  });
});
