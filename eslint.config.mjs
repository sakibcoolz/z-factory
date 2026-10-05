import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "coverage/**", "next-env.d.ts", "graphify-out/**", "lib/generated/**"]),
  {
    // Design-system adherence (Modernist `_adherence.oxlintrc.json`): UI code takes
    // colors and sizes from the tokens in app/globals.css, never from raw literals.
    files: ["app/**/*.tsx", "components/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
          message: "Raw hex color — use a design-system color token via var() or a theme utility.",
        },
        {
          selector: "Literal[value=/\\b\\d+px\\b/]",
          message: "Raw px value — use the spacing scale or a design-system token.",
        },
      ],
    },
  },
  {
    // A leading underscore marks a parameter or binding that must exist but is deliberately unused.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Server-only boundary (docs/bootstrap.md): components are UI only and must never
    // pull database, Docker, runtime or environment modules into a client bundle.
    files: ["components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/assets",
                "@/lib/assets/**",
                "@/lib/db",
                "@/lib/db/**",
                "@/lib/docker",
                "@/lib/docker/**",
                "@/lib/runtimes",
                "@/lib/runtimes/**",
                "@/lib/protocols",
                "@/lib/protocols/**",
                "@/lib/auth",
                "@/lib/auth/**",
                "@/lib/events",
                "@/lib/events/**",
                "@/lib/services",
                "@/lib/services/**",
                "@/lib/generated/**",
                "@/lib/env",
              ],
              message: "Server-only module — load data in a server component under app/ and pass plain props.",
            },
          ],
        },
      ],
    },
  },
]);
