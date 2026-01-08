// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INTERNAL_ALIAS_NAMES = [
  'agent',
  'common',
  'frontend',
  'historyView',
  'logger',
  'memoryView',
  'model',
  'progressView',
  'replacement',
  'tools',
  'utils',
  'eventBus',
  'webview',
  'latex',
  'commands',
  'housekeeping',
  'types',
];

const INTERNAL_ALIAS_PATH_GROUPS = INTERNAL_ALIAS_NAMES.flatMap((alias) => [
  {
    pattern: `@${alias}`,
    group: 'internal',
    position: 'after',
  },
  {
    pattern: `@${alias}/*`,
    group: 'internal',
    position: 'after',
  },
  {
    pattern: `@${alias}/**`,
    group: 'internal',
    position: 'after',
  },
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default tseslint.config(
  // Global ignores specified in the old config
  {
    ignores: ['out/', 'dist/', '**/*.d.ts'],
  },

  // Apply ESLint recommended rules globally
  js.configs.recommended,

  // Configuration for TypeScript files
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
      import: importPlugin,
      unicorn,
    },
    rules: {
      // --- Unicorn modernization rules (ES2023+) ---
      'unicorn/prefer-string-replace-all': 'warn',
      'unicorn/prefer-at': 'warn',
      'unicorn/prefer-array-flat-map': 'warn',
      'unicorn/prefer-includes': 'warn',
      'unicorn/prefer-array-find': 'warn',
      'unicorn/no-array-push-push': 'warn',
      'unicorn/prefer-spread': 'warn',
      'unicorn/prefer-ternary': 'off', // Often less readable
      'unicorn/no-null': 'off', // null is valid in this codebase
      'unicorn/prevent-abbreviations': 'off', // Too strict
      // --- Migrated rules from .eslintrc.json ---
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      '@stylistic/semi': 'warn',
      semi: 'off',
      curly: 'off',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
      'import/order': [
        'warn',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index', 'object'],
            'type',
          ],
          pathGroups: [
            ...INTERNAL_ALIAS_PATH_GROUPS,
            {
              pattern: '@/**',
              group: 'internal',
              position: 'after',
            },
            {
              pattern: '~/**',
              group: 'internal',
              position: 'after',
            },
          ],
          distinctGroup: false,
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'ignore',
        },
      ],

      // --- Adjustments for ESLint v9 ---

      // Temporarily disable strict any checks - REVISIT LATER
      '@typescript-eslint/no-explicit-any': 'off',

      // Disable rules causing many errors after upgrade - REVISIT LATER
      'no-case-declarations': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      '@typescript-eslint/prefer-as-const': 'off',

      // Allow @ts-ignore with description, but prefer @ts-expect-error
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': 'allow-with-description', // Allow ts-ignore for now
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 3,
        },
      ],

      // Keep useful rules, adjust if needed
      '@typescript-eslint/no-unused-vars': 'off',
      'prefer-const': 'error',
    },
  },

  // Configuration for JavaScript view modules
  {
    files: [
      'src/historyView/modules/**/*.js',
      'src/memoryView/modules/**/*.js',
      'src/progressView/modules/**/*.js',
      'src/webview/modules/**/*.js',
      'src/common/*.js',
      'src/common/modules/*.js',
      'src/common/webview/*.js',
      'src/historyView/script.js',
      'src/memoryView/script.js',
      'src/progressView/script.js',
      'src/webview/script.js',
    ],
    // Disable TS type-checking rules for these JS files
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.browser, // Add browser globals like document, window
        ...globals.node, // Add Node globals if potentially used
        acquireVsCodeApi: 'readonly', // Define VS Code specific API
        Sortable: 'readonly', // Define Sortable library global
      },
    },
    rules: {
      // Disable or adjust rules specifically for these JS files if needed
      'no-undef': 'warn', // Downgrade no-undef to warning for potentially missed globals
      'no-unused-vars': 'off', // Disable unused var checks
      'no-case-declarations': 'off', // Disable the rule for JS files
      // Add any other JS-specific rule adjustments here
    },
  },
);
