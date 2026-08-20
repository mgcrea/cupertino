import { execSync } from "node:child_process";

import { defineConfig } from "tsdown";

const tryGit = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
};

/**
 * Server bundles for Cupertino.app.
 *
 * Distinct from each package's own `tsdown.config.ts`, which builds for npm and
 * leaves dependencies external — correct there, because npm installs them.
 * Inside the app bundle there is no `node_modules` to resolve against, so
 * `dist/cli.js` importing `@modelcontextprotocol/sdk` would fail at startup.
 *
 * `deps.alwaysBundle` inlines everything, which is also what docs/distribution.md
 * already assumes: it lists `Resources/servers/{mail,notes,reminders}/cli.js`, one file
 * per surface.
 *
 * Paths are relative to this file, not to the working directory — tsdown
 * resolves them against the config's own location.
 */
export default defineConfig({
  entry: {
    // `<id>/dist/cli` rather than `<id>/cli`, so the layout matches an
    // installed npm package. `build-info.ts` reads its version from
    // `new URL("../package.json", import.meta.url)`; with cli.js directly in
    // `servers/<id>/` that resolves to a single shared `servers/package.json`,
    // which cannot carry two different versions. The staging step writes a
    // real package.json beside each `dist/`.
    "mail/dist/cli": "../packages/mail/src/cli.ts",
    "notes/dist/cli": "../packages/notes/src/cli.ts",
    "reminders/dist/cli": "../packages/reminders/src/cli.ts",
  },
  outDir: ".build/staged/servers",
  format: ["esm"],
  target: "node24",
  platform: "node",
  fixedExtension: false,
  // Everything in one file: node: builtins stay external because `platform`
  // is "node", and they are provided by the embedded runtime.
  deps: { alwaysBundle: [/.*/] },
  // Same substitution the npm builds do, so `apple_mail_diagnostics` can still
  // say which commit is running. Without it the field reads "unknown", which is
  // the one thing it must never say in a bug report.
  define: {
    __GIT_COMMIT__: JSON.stringify(process.env.GIT_COMMIT || tryGit("git rev-parse --short HEAD")),
    __GIT_COMMIT_DATE__: JSON.stringify(
      process.env.GIT_COMMIT_DATE || tryGit("git log -1 --format=%cI"),
    ),
  },
  dts: false,
  sourcemap: false,
  clean: true,
});
