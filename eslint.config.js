const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');

module.exports = [
  { ignores: ['node_modules/**', 'dashboard/node_modules/**', 'dashboard/dist/**', 'docs/design/**'] },
  js.configs.recommended,
  {
    files: ['*.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, ...globals.es2021, fetch: 'readonly', WebAssembly: 'readonly', TextEncoder: 'readonly' } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.es2021, fetch: 'readonly' } },
  },
  {
    files: ['dashboard/src/**/*.{js,jsx}'],
    plugins: { react },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: { ...globals.browser, ...globals.es2021 } },
    rules: { 'react/jsx-uses-vars': 'error' },
  },
  {
    files: ['dashboard/playwright.config.js', 'dashboard/e2e/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser, ...globals.es2021 } },
  },
  {
    files: ['chrome-extension/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' } },
  },
  { files: ['studio-server.js'], rules: { 'no-control-regex': 'off' } },
];
