// Build-time / runtime identity for the running server. `name`/`version` are
// read from package.json at startup (always accurate); `gitCommit` /
// `gitCommitDate` are injected by tsdown's `define` substitution at build time
// and fall back to "unknown" when running from source (e.g. vitest).

import { readPackageIdentity, type BuildInfo } from "@mgcrea/mcp-apple-core";

// oxlint-disable no-underscore-dangle -- bundler-injected build-time constants.
declare const __GIT_COMMIT__: string;
declare const __GIT_COMMIT_DATE__: string;

const pkg = readPackageIdentity(new URL("../package.json", import.meta.url), {
  name: "@mgcrea/mcp-apple-contacts",
  version: "0.0.0",
});

export type { BuildInfo };

export const BUILD_INFO: BuildInfo = {
  name: pkg.name,
  version: pkg.version,
  gitCommit: typeof __GIT_COMMIT__ === "string" ? __GIT_COMMIT__ : "unknown",
  gitCommitDate: typeof __GIT_COMMIT_DATE__ === "string" ? __GIT_COMMIT_DATE__ : "unknown",
};
