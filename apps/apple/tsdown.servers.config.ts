import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

/**
 * Anchor a path to THIS FILE rather than to the working directory.
 *
 * The comment below used to claim tsdown resolved entries against the config's
 * own location. It does not — rolldown resolves them against `process.cwd()`,
 * and since the Makefile invokes this config from the repo root (`pnpm exec
 * tsdown --config apps/apple/tsdown.servers.config.ts`), every entry resolved
 * one directory above the repo and `make servers` failed with UNRESOLVED_ENTRY
 * for all of them.
 *
 * Resolving through `import.meta.url` makes the claim true instead of merely
 * documented, and keeps the config correct from any working directory.
 */
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

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
 * already assumes: it lists `Resources/servers/{mail,notes,reminders,calendar}/cli.js`, one file
 * per surface.
 *
 * Paths are anchored to this file through `here()`, so the config behaves the
 * same whether it is invoked from the repo root (as the Makefile does) or from
 * `apps/apple`.
 */
export default defineConfig({
  entry: {
    // `<id>/dist/cli` rather than `<id>/cli`, so the layout matches an
    // installed npm package. `build-info.ts` reads its version from
    // `new URL("../package.json", import.meta.url)`; with cli.js directly in
    // `servers/<id>/` that resolves to a single shared `servers/package.json`,
    // which cannot carry two different versions. The staging step writes a
    // real package.json beside each `dist/`.
    // <generated:surfaces> generated from surfaces.json by `make surfaces` — do not edit by hand
    "mail/dist/cli": here("../../packages/mail/src/cli.ts"),
    "notes/dist/cli": here("../../packages/notes/src/cli.ts"),
    "reminders/dist/cli": here("../../packages/reminders/src/cli.ts"),
    "calendar/dist/cli": here("../../packages/calendar/src/cli.ts"),
    "contacts/dist/cli": here("../../packages/contacts/src/cli.ts"),
    "messages/dist/cli": here("../../packages/messages/src/cli.ts"),
    "safari/dist/cli": here("../../packages/safari/src/cli.ts"),
    // </generated:surfaces>
  },
  outDir: here("./.build/staged/servers"),
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
