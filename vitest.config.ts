import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
  },
});
