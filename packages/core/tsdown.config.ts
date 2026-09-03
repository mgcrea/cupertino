import { defineSurfaceConfig } from "../../tsdown.base.ts";

// No CLI: core is a library. No git define either — it has no `build-info` of
// its own to substitute into, and each server carries its own.
export default defineSurfaceConfig({ entry: ["src/index.ts"], git: false });
