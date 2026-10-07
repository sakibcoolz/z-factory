import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "coverage/**", "next-env.d.ts", "lib/generated/**"]),
  {
    // A leading underscore marks a parameter or binding that must exist but is deliberately unused.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Server-only boundary: components are UI only and must never pull the database, the
    // session, MQTT or the environment into a client bundle.
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/db",
                "@/lib/db/**",
                "@/lib/auth/**",
                "@/lib/services/**",
                "@/lib/mqtt",
                "@/lib/mqtt/**",
                "@/lib/env",
                "@/lib/generated/**",
                "@/auth",
              ],
              message: "Server-only module — load data in a server component under app/ and pass plain props.",
            },
          ],
        },
      ],
    },
  },
]);
