import { execSync } from "node:child_process";

import { defineConfig } from "tsdown";

const tryGit = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
};

const gitCommit = process.env.GIT_COMMIT || tryGit("git rev-parse --short HEAD");
const gitCommitDate = process.env.GIT_COMMIT_DATE || tryGit("git log -1 --format=%cI");

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __GIT_COMMIT_DATE__: JSON.stringify(gitCommitDate),
  },
});
