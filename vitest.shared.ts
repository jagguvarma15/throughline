import { resolve } from "node:path";

// Resolve @throughline/* imports to package SOURCE during tests, so the suite runs
// against the current code without a build step. Builds (tsup) still externalize these.
const root = import.meta.dirname;

export const alias: Record<string, string> = {
  "@throughline/core": resolve(root, "packages/core/src/index.ts"),
  "@throughline/store-sqlite": resolve(root, "packages/store-sqlite/src/index.ts"),
  "@throughline/store-postgres": resolve(root, "packages/store-postgres/src/index.ts"),
  "@throughline/testing": resolve(root, "packages/testing/src/index.ts"),
};
