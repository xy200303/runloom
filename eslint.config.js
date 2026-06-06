import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const commonIgnores = [
  "node_modules/**",
  "dist/**",
  "coverage/**",
  ".tsbuildinfo/**",
  "packages/*/dist/**",
  "packages/*/*.tsbuildinfo"
];

export default tseslint.config(
  {
    ignores: commonIgnores
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2024
      }
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ],
      "@typescript-eslint/no-empty-object-type": "off"
    }
  }
);
