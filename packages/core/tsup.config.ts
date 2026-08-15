import { defineConfig } from "tsup";

// @through-line/core is the single published package: the engine at the root plus
// the stores, adapters, testing utilities, MCP server, and both bins as subpaths.
// The sibling workspace packages stay private and are bundled in here at build time.
//
// Every subpath bundle imports "@through-line/core" itself (package self-reference)
// instead of inlining the engine, so error classes exist exactly once at runtime and
// instanceof checks (LeaseLostError, CancelledError) hold across subpath boundaries.
const SELF = ["@through-line/core"];
const RUNTIME = [
  "better-sqlite3",
  "pg",
  "ai",
  "vitest",
  "zod",
  "@modelcontextprotocol/sdk",
  "@opentelemetry/api",
];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      sqlite: "src/subpaths/sqlite.ts",
      postgres: "src/subpaths/postgres.ts",
      "ai-sdk": "src/subpaths/ai-sdk.ts",
      llm: "src/subpaths/llm.ts",
      testing: "src/subpaths/testing.ts",
      mcp: "src/subpaths/mcp.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    external: [...SELF, ...RUNTIME],
  },
  // The bins are ESM-only executables (top-level await). Store code is inlined into
  // each bin (via the tsconfig path mappings); the engine and the database drivers
  // stay external, so core error classes still exist exactly once at runtime.
  {
    entry: {
      "bin/throughline": "../cli/src/bin.ts",
      "bin/throughline-mcp": "../mcp/src/bin.ts",
    },
    format: ["esm"],
    external: [...SELF, ...RUNTIME],
  },
]);
