# @through-line/store-postgres

## 0.2.0

### Minor Changes

- 074ffee: First adoptable release. New `@through-line/adapters-ai-sdk` package makes Vercel AI SDK
  (`ai@^7`) agent loops durable: `durableModel`/`durableMiddleware` journal every
  `generateText` model call as its own step, and `durableToolExecute` keys tool executions
  by `toolCallId` for exactly-once effects across crashes — proven by crash-resume and
  offline golden-replay tests, plus a runnable kill-and-resume example
  (`examples/ai-sdk-agent`). The dependency guard now also covers the adapter packages,
  forbidding provider SDKs (`@ai-sdk/openai`, ...) everywhere while allowing the
  provider-neutral `ai` package in the adapter.

### Patch Changes

- Updated dependencies [074ffee]
  - @through-line/core@0.2.0
