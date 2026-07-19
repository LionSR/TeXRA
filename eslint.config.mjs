// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import importPlugin from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAliasEntries } from './scripts/aliasUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INTERNAL_ALIAS_NAMES = [
  ...new Set(
    loadAliasEntries(__dirname)
      .map(({ alias }) => alias)
      .filter((alias) => alias.startsWith('@')),
  ),
].toSorted();

const INTERNAL_ALIAS_PATH_GROUPS = INTERNAL_ALIAS_NAMES.flatMap((alias) => [
  {
    pattern: alias,
    group: 'internal',
    position: 'after',
  },
  {
    pattern: `${alias}/*`,
    group: 'internal',
    position: 'after',
  },
  {
    pattern: `${alias}/**`,
    group: 'internal',
    position: 'after',
  },
]);

const COMPOSITION_ROOT_FILES = new Set([
  path.join(__dirname, 'packages/extension/src/extension.ts'),
  path.join(__dirname, 'packages/desktop/src/main/platform/index.ts'),
  path.join(__dirname, 'packages/cli/src/runtime/initPlatform.ts'),
  // The test suite's composition root: the sole place vitest suites swap the
  // fake platform, replacing the per-suite `await import('@platform/platform')`
  // dance every suite used to hand-roll to dodge this same rule.
  path.join(__dirname, 'src/test-kernel/support/setupPlatform.ts'),
]);

const extensionPackageDir = path.join(__dirname, 'packages', 'extension');

const ALIAS_CONFIGS = [
  aliasConfigForRoot(extensionPackageDir),
  aliasConfigForRoot(__dirname),
];

const VSCODE_FREE_ZONE_DIRS = [
  'src/agent',
  'src/model',
  'src/latex',
  'src/tools',
  'src/controllers',
  'src/shared',
  'src/replacement',
  'src/eventBus',
  'src/hosts',
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((dir) => path.join(__dirname, dir));

const HOST_LAYER_RESTRICTED_IMPORT_PATHS = [
  {
    name: '@common/state',
    message:
      'Production src code must not import host-owned state helpers; route host access through platform or host adapters.',
  },
  {
    name: '@common/webview',
    message:
      'Production src code must not import host-owned webview helpers; route host access through platform or host adapters.',
  },
];

const HOST_LAYER_RESTRICTED_IMPORT_PATTERNS = [
  {
    group: [
      '@webview/**',
      '@commands/**',
      '@progressView/**',
      '@settingsView/**',
      '@frontend/**',
      '@extensionSchemas/**',
      '@resources/**',
      '@common/state/**',
      '@common/webview/**',
      '@cli/**',
      '@desktop/**',
    ],
    message:
      'Production src code must not import extension, CLI, or desktop host layers; route host access through platform or host adapters.',
  },
];

const AGENT_CORE_RESTRICTED_IMPORT_PATTERNS = [
  {
    group: ['@agent/modelHandlers', '@agent/modelHandlers/**'],
    message:
      'Agent core must not import model handler implementations; move provider-neutral contracts to @agent/types or a core helper.',
  },
  ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
];

const AUTH_RESTRICTED_IMPORT_PATTERNS = [
  {
    regex: '^(?:@model(?:/|$)|(?:\\.\\./)+model(?:/|$))',
    message:
      'Authentication must not own or depend on model policy; move the policy to src/model.',
  },
  ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
];

function isUnderDir(filename, dir) {
  const relativePath = path.relative(dir, filename);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

function aliasConfigForRoot(rootDir) {
  return {
    rootDir,
    entries: aliasEntriesFromTsconfigPaths(rootDir),
  };
}

function aliasEntriesFromTsconfigPaths(rootDir) {
  const byAliasAndPath = new Map();

  for (const { alias, absolutePath, requiresSubpath } of loadAliasEntries(
    rootDir,
  )) {
    const key = `${alias}\0${absolutePath}\0${requiresSubpath}`;
    byAliasAndPath.set(key, {
      alias,
      requiresSubpath,
      absolutePath: path.normalize(absolutePath),
    });
  }

  return [...byAliasAndPath.values()].sort(
    (left, right) => right.absolutePath.length - left.absolutePath.length,
  );
}

function toPosixPath(importPath) {
  return importPath.split(path.sep).join('/');
}

function parentTraversalCount(importPath) {
  return importPath.split('/').filter((part) => part === '..').length;
}

function isSameOrUnderPath(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function aliasEntriesForFile(filename) {
  return (
    ALIAS_CONFIGS.find(({ rootDir }) => isSameOrUnderPath(filename, rootDir))
      ?.entries ?? []
  );
}

function aliasedImportFor(filename, importPath) {
  if (
    typeof importPath !== 'string' ||
    parentTraversalCount(importPath) < 2 ||
    !path.isAbsolute(filename)
  ) {
    return undefined;
  }

  const targetPath = path.normalize(
    path.resolve(path.dirname(filename), importPath),
  );
  const matchingAlias = aliasEntriesForFile(filename).find((aliasEntry) => {
    if (!isSameOrUnderPath(targetPath, aliasEntry.absolutePath)) return false;

    const relativePath = path.relative(aliasEntry.absolutePath, targetPath);
    return aliasEntry.requiresSubpath === Boolean(relativePath);
  });

  if (!matchingAlias) return undefined;
  const relativePath = path.relative(matchingAlias.absolutePath, targetPath);
  const aliasedPath = relativePath
    ? `${matchingAlias.alias}/${toPosixPath(relativePath)}`
    : matchingAlias.alias;

  return aliasedPath === importPath ? undefined : aliasedPath;
}

const localRules = {
  rules: {
    'no-platform-init-outside-composition-root': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow initPlatform imports outside composition roots.',
        },
        messages: {
          forbidden:
            'initPlatform may only be imported by composition roots; use platform() elsewhere.',
        },
        schema: [],
      },
      create(context) {
        const filename = path.normalize(context.filename);
        const isAllowedFile = COMPOSITION_ROOT_FILES.has(filename);

        if (isAllowedFile) {
          return {};
        }

        return {
          ImportDeclaration(node) {
            const importsInitPlatform = node.specifiers.some((specifier) => {
              return (
                specifier.type === 'ImportSpecifier' &&
                specifier.imported.type === 'Identifier' &&
                specifier.imported.name === 'initPlatform'
              );
            });

            if (!importsInitPlatform) return;

            context.report({
              node,
              messageId: 'forbidden',
            });
          },
        };
      },
    },
    'no-vscode-import-in-free-zones': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow direct VS Code imports in platform-independent source zones.',
        },
        messages: {
          forbiddenVscodeImport:
            'VS Code-free zones must not import "vscode"; route host access through platform or host adapters.',
        },
        schema: [],
      },
      create(context) {
        const filename = context.filename;
        if (!VSCODE_FREE_ZONE_DIRS.some((dir) => isUnderDir(filename, dir))) {
          return {};
        }

        function reportIfVscodeSource(node) {
          if (node.source?.value === 'vscode') {
            context.report({
              node: node.source,
              messageId: 'forbiddenVscodeImport',
            });
          }
        }

        return {
          ImportDeclaration: reportIfVscodeSource,
          ExportAllDeclaration: reportIfVscodeSource,
          ExportNamedDeclaration: reportIfVscodeSource,
          TSImportEqualsDeclaration(node) {
            const expression = node.moduleReference?.expression;
            if (expression?.value === 'vscode') {
              context.report({
                node: expression,
                messageId: 'forbiddenVscodeImport',
              });
            }
          },
          CallExpression(node) {
            if (
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require' &&
              node.arguments.length === 1 &&
              node.arguments[0]?.type === 'Literal' &&
              node.arguments[0].value === 'vscode'
            ) {
              context.report({
                node: node.arguments[0],
                messageId: 'forbiddenVscodeImport',
              });
            }
          },
          ImportExpression(node) {
            if (node.source?.value === 'vscode') {
              context.report({
                node: node.source,
                messageId: 'forbiddenVscodeImport',
              });
            }
          },
        };
      },
    },
    'prefer-alias-for-deep-relative-imports': {
      meta: {
        type: 'suggestion',
        fixable: 'code',
        docs: {
          description:
            'Prefer configured path aliases over deep relative imports.',
        },
        messages: {
          preferAlias:
            'Use "{{aliasPath}}" instead of deep relative import "{{importPath}}".',
        },
        schema: [],
      },
      create(context) {
        function reportIfAliasExists(source) {
          const importPath = source?.value;
          const aliasPath = aliasedImportFor(context.filename, importPath);

          if (!aliasPath) return;

          context.report({
            node: source,
            messageId: 'preferAlias',
            data: {
              aliasPath,
              importPath,
            },
            fix(fixer) {
              const quote = source.raw?.startsWith("'") ? "'" : '"';
              return fixer.replaceText(source, `${quote}${aliasPath}${quote}`);
            },
          });
        }

        return {
          ImportDeclaration(node) {
            reportIfAliasExists(node.source);
          },
          ExportAllDeclaration(node) {
            reportIfAliasExists(node.source);
          },
          ExportNamedDeclaration(node) {
            reportIfAliasExists(node.source);
          },
          TSImportEqualsDeclaration(node) {
            reportIfAliasExists(node.moduleReference?.expression);
          },
          CallExpression(node) {
            if (
              node.callee.type === 'Identifier' &&
              node.callee.name === 'require' &&
              node.arguments.length === 1
            ) {
              reportIfAliasExists(node.arguments[0]);
            }
          },
          ImportExpression(node) {
            reportIfAliasExists(node.source);
          },
        };
      },
    },
  },
};

export default tseslint.config(
  // Global ignores specified in the old config
  {
    ignores: ['dist/', '**/*.d.ts'],
  },

  // Apply ESLint recommended rules globally
  js.configs.recommended,

  // Configuration for TypeScript files
  {
    files: [
      'src/**/*.ts',
      'src/**/*.mts',
      'packages/extension/src/**/*.ts',
      'packages/desktop/src/**/*.ts',
      'packages/cli/src/**/*.ts',
      'packages/cli/src/**/*.tsx',
      'packages/trace-viewer/src/**/*.ts',
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.test-kernel.json',
          './packages/desktop/tsconfig.main.json',
          './packages/desktop/tsconfig.preload.json',
          './packages/desktop/tsconfig.renderer.json',
          './packages/cli/tsconfig.json',
          './packages/trace-viewer/tsconfig.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@stylistic': stylistic,
      import: importPlugin,
      local: localRules,
      unicorn,
    },
    rules: {
      'local/no-platform-init-outside-composition-root': 'error',

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
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      'no-throw-literal': 'warn',
      'local/prefer-alias-for-deep-relative-imports': 'error',
      'no-nested-ternary': 'error',
      'import/order': [
        'error',
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

      // --- Adjustments for ESLint v9/v10 ---

      // Temporarily disable strict any checks - REVISIT LATER
      '@typescript-eslint/no-explicit-any': 'off',

      // Disable rules causing many errors after upgrade - REVISIT LATER
      'no-case-declarations': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      // ESLint 10 recommended additions; keep this dependency PR policy-neutral.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
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
      'local/no-vscode-import-in-free-zones': 'error',
      'prefer-const': 'error',
    },
  },

  // Production core code must not reach back into host-owned layers. The only
  // intentional prose reference in this area is a JSDoc note in
  // src/shared/state/PersistedState.ts; import declarations stay forbidden.
  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/test-kernel/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
        },
      ],
    },
  },

  // Agent core is the neutral execution layer. It may depend on shared agent
  // contracts, but not on concrete provider-handler implementations.
  {
    files: ['src/agent/core/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: AGENT_CORE_RESTRICTED_IMPORT_PATTERNS,
        },
      ],
    },
  },

  // Authentication owns credentials, sessions, and preferences. Model policy
  // may consume that state, but auth must not depend back on the model layer.
  {
    files: ['src/auth/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: AUTH_RESTRICTED_IMPORT_PATTERNS,
        },
      ],
    },
  },

  // Extension browser frontends may use host-neutral types from backend
  // modules, but runtime values must come from browser-safe shared modules.
  {
    files: [
      'packages/extension/src/{webview,progressView,settingsView}/frontend/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@common', '@common/**', '@tools', '@tools/**'],
              allowTypeImports: true,
              message:
                'Extension browser frontends must import runtime values from browser-safe shared modules.',
            },
          ],
        },
      ],
    },
  },
);
