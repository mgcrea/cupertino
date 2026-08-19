import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  // Match `main`/`exports`, which are .js — tsdown 0.22+ would default to .mjs.
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
});
