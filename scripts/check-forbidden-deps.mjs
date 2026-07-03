// Dependency hygiene: no published @throughline/* package may depend on an LLM provider
// SDK. Providers live only in the application layer (examples/, apps/). The bare `ai`
// package is allowed in adapters-ai-sdk: it is Vercel's provider-NEUTRAL SDK — the
// provider bindings live in @ai-sdk/* packages, which stay forbidden. Wired into CI.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  /^openai$/,
  /^@anthropic-ai\//,
  /^@langchain\//,
  /^langchain$/,
  /^cohere-ai$/,
  /^@mistralai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^ollama$/,
  /^groq-sdk$/,
  /^@aws-sdk\/client-bedrock/,
  /^@ai-sdk\/(?!provider$|provider-utils$)/,
];

const GUARDED = [
  "packages/core",
  "packages/store-sqlite",
  "packages/store-postgres",
  "packages/adapters-llm",
  "packages/adapters-ai-sdk",
];

const violations = [];
for (const pkg of GUARDED) {
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
  };
  for (const name of Object.keys(deps)) {
    if (FORBIDDEN.some((re) => re.test(name))) violations.push(`${pkg} -> ${name}`);
  }
}

if (violations.length > 0) {
  console.error("Forbidden LLM/provider SDK in a dependency-guarded package:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`OK: no LLM/provider SDKs in ${GUARDED.join(", ")}`);
