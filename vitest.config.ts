import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["*.test.ts", "*.test.tsx", "insights/**/*.test.ts", "insights/**/*.test.tsx"] },
});
