// Dependency hygiene: @throughline/core and the store packages must never depend on an
// LLM/provider SDK. Providers live only in adapters-* and examples/. Wired into CI.
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
];

const GUARDED = ["packages/core", "packages/store-sqlite", "packages/store-postgres"];

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
