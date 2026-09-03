import { execSync } from "node:child_process";

import { defineConfig, type UserConfig } from "tsdown";

/**
 * One build configuration for every package here.
 *
 * There were ten copies of this file, and the eight surface ones differed by
 * nothing but which comments had been carried along — which is the state a
 * shared build config exists to prevent: a bundler flag fixed in one package and
 * not the other nine is a difference nobody sees until an artifact behaves
 * oddly. `fixedExtension: false` is exactly such a flag, and its reason is
 * recorded once below rather than eight times.
 *
 * At the repo root rather than inside `packages/core`, because a package cannot
 * import its own build tooling from a workspace dependency that has not been
 * built yet.
 *
 * Each `tsdown.config.ts` imports this by its `.ts` path, which is what the
 * bundler's own loader resolves — and it is why those config files are no longer
 * in any package's `include`: they reference a file above the package's
 * `rootDir`, which `tsc` refuses on both counts. Nothing is lost by it. A build
 * config that does not load fails the build that loads it, immediately and in
 * every package, which is a stricter check than typechecking it was.
 */

const tryGit = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
};

export type SurfaceBuild = {
  /** Defaults to a server's two entry points. `core` has no CLI. */
  entry?: string[];
  /**
   * Substitute `__GIT_COMMIT__` and `__GIT_COMMIT_DATE__`.
   *
   * On for anything that reports a build in its diagnostics, which is every
   * server; off for `core`, which has no `build-info` of its own to fill in.
   */
  git?: boolean;
};

export const defineSurfaceConfig = ({
  entry = ["src/index.ts", "src/cli.ts"],
  git = true,
}: SurfaceBuild = {}): UserConfig => {
  // Env vars take precedence so CI builds — where `.git` is not in the build
  // context — can pass git info in.
  const gitCommit = process.env.GIT_COMMIT || tryGit("git rev-parse --short HEAD");
  const gitCommitDate = process.env.GIT_COMMIT_DATE || tryGit("git log -1 --format=%cI");

  return defineConfig({
    entry,
    format: ["esm"],
    target: "node24",
    platform: "node",
    // tsdown 0.22+ defaults to `.mjs` when platform is "node"; opt out so the
    // output matches the `bin`/`main`/`exports` paths, which are `.js` and
    // already ESM through `"type": "module"`.
    fixedExtension: false,
    dts: true,
    clean: true,
    sourcemap: true,
    outDir: "dist",
    ...(git
      ? {
          define: {
            __GIT_COMMIT__: JSON.stringify(gitCommit),
            __GIT_COMMIT_DATE__: JSON.stringify(gitCommitDate),
          },
        }
      : {}),
  }) as UserConfig;
};
