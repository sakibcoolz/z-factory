import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fromRoot("./test/stubs/server-only.ts"),
      "@": fromRoot("./"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // Integration tests share one PostgreSQL database.
    fileParallelism: false,
  },
});
