import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  // src/vendor/** is GENERATED (scripts/vendor-engine.mjs) from a pinned commit of
  // the engine repo, where it is linted under that repo's own config. Linting it
  // here would either fail on rules this config does not define or invite hand
  // edits to a tree `npm run vendor:check` requires to be byte-identical.
  { ignores: ["dist/**", "node_modules/**", "src/vendor/**", ".vendor-src/**"] },
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
