// eslint.config.mjs  —— Flat Config（Next 15 推荐）
// 1) 先引入 Next 官方配置
import next from 'eslint-config-next';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  // Next 的默认规则（等同于以前的 "extends": ["next/core-web-vitals"]）
  ...next,

  // 2) 你的自定义覆盖（把烦人的规则关掉）
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'prefer-const': 'off',
    },
  },
];