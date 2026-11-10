import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Only the data source layer may talk to Docker or the host OS (Requirement 1.4).
const DATA_SOURCE_ONLY_MODULES = ["dockerode", "systeminformation"];
const restrictedImports = [
  "error",
  {
    paths: DATA_SOURCE_ONLY_MODULES.map((name) => ({
      name,
      message: `"${name}" may only be imported under src/server/datasource/.`,
    })),
    patterns: DATA_SOURCE_ONLY_MODULES.map((name) => ({
      group: [`${name}/*`],
      message: `"${name}" may only be imported under src/server/datasource/.`,
    })),
  },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-restricted-imports": restrictedImports,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/server/datasource/**/*.{ts,tsx,js}"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
