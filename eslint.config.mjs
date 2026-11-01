import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * 只给「没有其它闸门」的文件上 lint。
 *
 * src 下的 .ts 已经不在这里：tsconfig.json 是 strict + noUncheckedIndexedAccess，
 * tsc 检查得比 eslint 严得多，再跑一遍只是重复。真正裸奔的是：
 *   - src/client/index.jsx：esbuild 只转译不检查（现在另有 tsconfig.client.json 兜类型，
 *     但 no-undef / no-unused-vars / hooks 规则仍是它缺的一块）；
 *   - scripts/*.mjs、test/*.mjs：纯 JS，没有任何类型检查。
 *
 * 规则只挑「能真发现问题」的，不追求风格统一（这个仓库没有 prettier，也不想引入
 * 格式争议）。
 */
export default [
  {
    ignores: ["**/lib/**", "**/node_modules/**", "coverage/**"],
  },
  {
    files: ["packages/plugin/src/client/**/*.jsx"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      // 未定义变量：就是白屏那类事故的直接来源，必须拦。
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 空 catch 等于静默吞错；这个仓库的约定是「要么记日志要么抛」。
      "no-empty": ["error", { allowEmptyCatch: false }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-console": "off",
      // 模板串里用全角空格（U+3000）排版子模块缩进是有意的，别当成错字。
      "no-irregular-whitespace": ["error", { skipTemplates: true }],
      eqeqeq: ["warn", "smart"],
    },
  },
  {
    files: ["packages/*/scripts/**/*.mjs", "packages/*/test/**/*.mjs", "eslint.config.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-console": "off",
      eqeqeq: ["warn", "smart"],
    },
  },
];
