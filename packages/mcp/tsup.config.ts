import { defineConfig } from "tsup";

// The library entry ships dual ESM/CJS with types; the bin is an ESM-only executable
// (top-level await), so it gets no CJS build.
export default defineConfig([
  { entry: ["src/index.ts"], format: ["esm", "cjs"], dts: true, clean: true },
  { entry: ["src/bin.ts"], format: ["esm"] },
]);
