import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // .guard-dist/ is the compiled tree scripts/check-hosted-isolation.mjs traces;
  // the script deletes it, but an interrupted run must not turn `eslint .` into a
  // lint of build output.
  { ignores: ["dist/**", "node_modules/**", ".guard-dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // No `console.*` in shipped source. In stdio mode STDOUT is the JSON-RPC
    // channel, so a stray log line corrupts the protocol; the engine also routes
    // every message through a redacting logger (src/wallet-engine/logger.ts) that
    // console bypasses. Inherited from the engine's own config, applied to all of
    // src/ because the same two reasons hold for the gateway half.
    files: ["src/**/*.ts", "src/**/*.js"],
    rules: {
      "no-console": "error",
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
