import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources, not built dist output.
    alias: [
      { find: "@oa/shared", replacement: src("./packages/shared/src/index.ts") },
      { find: "@oa/db", replacement: src("./packages/db/src/index.ts") },
      { find: "@oa/ingestion", replacement: src("./packages/ingestion/src/index.ts") },
      { find: "@oa/agents", replacement: src("./packages/agents/src/index.ts") },
      { find: "@oa/video", replacement: src("./packages/video/src/index.ts") },
      { find: "@oa/worker/queue", replacement: src("./apps/worker/src/queue.ts") },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    testTimeout: 30000,
  },
});
