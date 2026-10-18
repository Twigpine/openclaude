// Minimal flat config — only the rule we need to track `any` usage.
// Part of the phased `any`-reduction work landing on fix/reduce-any-types.
//
// Note: the repo has many existing `// eslint-disable custom-rules/<name>`
// comments referencing rules from a previous (now-removed) custom plugin.
// We register a stub `custom-rules` plugin whose rules are all "off"; this
// makes the comments valid so eslint doesn't error on unknown rule names.
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

const DEPRECATED_CUSTOM_RULE_NAMES = [
  "bootstrap-isolation",
  "no-cross-platform-process-issues",
  "no-direct-json-operations",
  "no-direct-ps-commands",
  "no-lookbehind-regex",
  "no-process-cwd",
  "no-process-env-top-level",
  "no-process-exit",
  "no-sync-fs",
  "no-top-level-dynamic-import",
  "no-top-level-side-effects",
  "prefer-use-keybindings",
  "prefer-use-terminal-size",
  "prompt-spacing",
  "require-bun-typeof-guard",
  "require-tool-match-name",
  "safe-env-boolean-check",
];

// Stub plugin: each rule is a no-op listener so eslint resolves the name
// but does nothing.
const stubRules = Object.fromEntries(
  DEPRECATED_CUSTOM_RULE_NAMES.map((name) => [
    name,
    {
      meta: { schema: [], deprecated: true },
      create() {
        return {};
      },
    },
  ]),
);

/** @type {import("eslint").ESLint.Plugin} */
const customRulesPlugin = {
  rules: stubRules,
};

// Stub plugin for legacy `eslint-plugin-n/*` references in source comments.
const eslintPluginNPlugin = {
  rules: {
    "no-unsupported-features/node-builtins": {
      meta: { schema: [], deprecated: true },
      create() {
        return {};
      },
    },
  },
};

// Stub plugin for legacy `react-hooks/*` references in source comments.
const reactHooksPlugin = {
  rules: {
    "exhaustive-deps": {
      meta: { schema: [], deprecated: true },
      create() {
        return {};
      },
    },
    "rules-of-hooks": {
      meta: { schema: [], deprecated: true },
      create() {
        return {};
      },
    },
  },
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "vendor/**",
      "web/**",
      "vscode-extension/**",
      "coverage/**",
      "reports/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "custom-rules": customRulesPlugin,
      "eslint-plugin-n": eslintPluginNPlugin,
      "react-hooks": reactHooksPlugin,
    },
    linterOptions: {
      // Source has many `// eslint-disable` comments that may now refer to
      // rules not enabled here; don't fail on unused directives.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // Flags both `: any` annotations and `as any` casts.
      // warn (not error) so existing code keeps building while we
      // surface counts and reduce incrementally.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];