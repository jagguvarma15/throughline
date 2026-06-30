import { defineConfig } from "vitest/config";
import { alias } from "../../vitest.shared";

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
