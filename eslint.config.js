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
);
