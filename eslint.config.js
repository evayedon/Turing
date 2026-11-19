import js from "@eslint/js";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/target/**",
      "**/gen/**",
      ".claude/worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": hooks },
    rules: hooks.configs.recommended.rules,
  },
];
