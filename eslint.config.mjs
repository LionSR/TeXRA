// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
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
  path.join(__dirname, 'packages/agent/src/index.ts'),
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
  'packages/agent/src',
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
  {
    group: ['@tools', '@tools/**'],
    message:
      'Agent core must not depend on tool implementations; src/tools consumes agent/core, not the reverse — move shared logic to agent/core or @shared.',
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

const REPO_SOURCE_ROOT = __dirname;

/**
 * A union type is TeXRA's to keep exhaustive only when we declare it. Vendor
 * unions (SDK block types, NodeJS.Platform, VS Code enums) grow without our
 * say, which is exactly when a catch-all `default` is the correct handling.
 */
function isRepoDeclaredAlias(type) {
  const declarations = type?.aliasSymbol?.declarations;
  if (!declarations || declarations.length === 0) return false;
  return declarations.every((declaration) => {
    const file = declaration.getSourceFile?.().fileName;
    return (
      typeof file === 'string' &&
      !file.includes('node_modules') &&
      isUnderDir(path.normalize(file), REPO_SOURCE_ROOT)
    );
  });
}

/**
 * `T | undefined` is a synthesized union carrying no alias symbol, and a
 * `const` narrowed off a property carries none either. Walk the discriminant
 * back through its declaration and initializer until the alias name appears.
 */
function discriminantIsOwnedUnion(checker, tsNode, depth = 0) {
  if (!tsNode || depth > 4) return false;
  if (isRepoDeclaredAlias(checker.getTypeAtLocation(tsNode))) return true;

  for (const declaration of checker.getSymbolAtLocation(tsNode)?.declarations ??
    []) {
    const typeNode = declaration.type;
    for (const part of typeNode?.types ?? (typeNode ? [typeNode] : [])) {
      if (isRepoDeclaredAlias(checker.getTypeAtLocation(part))) return true;
    }
    if (
      declaration.initializer &&
      discriminantIsOwnedUnion(checker, declaration.initializer, depth + 1)
    ) {
      return true;
    }
  }
  // `a?.b` and `a.b`: the alias lives on the property, not the expression.
  return tsNode.name
    ? discriminantIsOwnedUnion(checker, tsNode.name, depth + 1)
    : false;
}

const localRules = {
  rules: {
    'exhaustive-switch-over-owned-union': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Require switches over TeXRA-declared union types to name every member.',
        },
        messages: {
          nonExhaustive:
            'Switch over the TeXRA-declared union {{union}} leaves {{missing}} to a catch-all `default`. Name every member and reduce `default` to a `satisfies never` guard, so adding a member fails to compile here instead of changing behavior silently.',
        },
        schema: [],
      },
      create(context) {
        const services = context.sourceCode.parserServices;
        const checker = services?.program?.getTypeChecker();
        if (!checker || !services.esTreeNodeToTSNodeMap) return {};

        const nameOf = (type) =>
          type.isLiteral?.() ? String(type.value) : checker.typeToString(type);

        return {
          SwitchStatement(node) {
            const tsNode = services.esTreeNodeToTSNodeMap.get(
              node.discriminant,
            );
            if (!tsNode) return;
            const type = checker.getTypeAtLocation(tsNode);
            if (!type?.isUnion?.()) return;
            if (!discriminantIsOwnedUnion(checker, tsNode)) return;

            // Only a union of literals (optionally with undefined / null) has
            // an enumerable `case` form; anything else has nothing to compare.
            const members = new Set();
            for (const member of type.types) {
              const name = nameOf(member);
              if (
                !member.isLiteral?.() &&
                name !== 'undefined' &&
                name !== 'null'
              ) {
                return;
              }
              members.add(name);
            }

            for (const switchCase of node.cases) {
              if (!switchCase.test) continue;
              const testNode = services.esTreeNodeToTSNodeMap.get(
                switchCase.test,
              );
              if (testNode)
                members.delete(nameOf(checker.getTypeAtLocation(testNode)));
            }

            if (members.size === 0) return;
            context.report({
              node: node.discriminant,
              messageId: 'nonExhaustive',
              data: {
                union:
                  type.aliasSymbol?.getName() ?? checker.typeToString(type),
                missing: [...members].join(', '),
              },
            });
          },
        };
      },
    },
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

  {
    files: ['packages/agent/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Configuration for TypeScript files
  {
    files: [
      'src/**/*.ts',
      'packages/agent/src/**/*.ts',
      'packages/extension/src/**/*.ts',
      'packages/desktop/src/**/*.ts',
      'packages/cli/src/**/*.ts',
      'packages/cli/src/**/*.tsx',
      'packages/cli/scripts/**/*.ts',
      'packages/cli/scripts/**/*.tsx',
      'packages/trace-viewer/src/**/*.ts',
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './tsconfig.test-kernel.json',
          './tsconfig.build.json',
          './packages/desktop/tsconfig.main.json',
          './packages/desktop/tsconfig.preload.json',
          './packages/desktop/tsconfig.renderer.json',
          './packages/cli/tsconfig.json',
          './packages/cli/tsconfig.scripts.json',
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

      // #9698: a `default` must not stand in for members of a union we own.
      'local/exhaustive-switch-over-owned-union': 'error',

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
    files: ['src/**/*.{ts,tsx}', 'packages/agent/src/**/*.{ts,tsx}'],
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
    files: ['src/agent/core/**/*.{ts,tsx}'],
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
    files: ['src/auth/**/*.{ts,tsx}'],
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
