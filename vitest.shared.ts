import { resolve } from "node:path";

// Resolve @through-line/* imports to package SOURCE during tests, so the suite runs
// against the current code without a build step. Builds (tsup) still externalize these.
const root = import.meta.dirname;

export const alias: Record<string, string> = {
  "@through-line/core": resolve(root, "packages/core/src/index.ts"),
  "@through-line/adapters-llm": resolve(root, "packages/adapters-llm/src/index.ts"),
  "@through-line/adapters-ai-sdk": resolve(root, "packages/adapters-ai-sdk/src/index.ts"),
  "@through-line/store-sqlite": resolve(root, "packages/store-sqlite/src/index.ts"),
  "@through-line/store-postgres": resolve(root, "packages/store-postgres/src/index.ts"),
  "@through-line/testing": resolve(root, "packages/testing/src/index.ts"),
};
