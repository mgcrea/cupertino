import { readFileSync } from "node:fs";

export type PackageIdentity = { name: string; version: string };

export type BuildInfo = PackageIdentity & {
  gitCommit: string;
  gitCommitDate: string;
};

/**
 * Read a package's own name and version at startup, so they are always accurate
 * rather than baked in at build time.
 *
 * Callers pass their own `new URL("../package.json", import.meta.url)`: resolving
 * it here would find *this* package, not theirs. The git fields stay with the
 * caller too, because `__GIT_COMMIT__` is substituted by whichever bundler build
 * compiles the file that mentions it.
 */
export const readPackageIdentity = (
  packageJsonUrl: URL,
  fallback: PackageIdentity,
): PackageIdentity => {
  try {
    return JSON.parse(readFileSync(packageJsonUrl, "utf8")) as PackageIdentity;
  } catch {
    return fallback;
  }
};
