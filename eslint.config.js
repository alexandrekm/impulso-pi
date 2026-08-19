import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Vendored, upstream-managed extensions (Orca/herdr overwrite their own
    // ~/.pi/agent copies on integration updates) — excluded so re-vendoring
    // stays a clean diff against upstream instead of drifting to our style.
    ignores: [
      "node_modules/**",
      "investigation/**",
      "extensions/orca-integration/**",
      "extensions/herdr/**",
      // Vendored fork of @juanbenjumea/pi-dynamic-footer (v0.1.7) + its
      // opencode-go-usage dep. Excluded so re-syncing from upstream stays a
      // clean diff; theme edits live in lib/footer-engine/{segments,layout}.ts.
      "extensions/pi-dynamic-footer/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
