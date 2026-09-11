import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAliasEntries } from './scripts/aliasUtils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Every package tsconfig extends the root, so the root `paths` map is the
// only alias map. Longest target first, so a nested alias wins over its parent.
const ALIAS_ENTRIES = loadAliasEntries(__dirname).toSorted(
  (left, right) => right.absolutePath.length - left.absolutePath.length,
);

const INTERNAL_ALIAS_NAMES = [
  ...new Set(
    ALIAS_ENTRIES.map(({ alias }) => alias).filter((alias) =>
      alias.startsWith('@'),
    ),
  ),
].toSorted();

const INTERNAL_ALIAS_PATH_GROUPS = INTERNAL_ALIAS_NAMES.flatMap((alias) => [
  {
    pattern: alias,
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
  // The package's composition root is `composeProcess`, which the Promise
  // entry and the Effect subpath's `Runtime.layer` both call.
  path.join(__dirname, 'packages/agent/src/effect/runtime.ts'),
  // The test suite's composition root: the sole place vitest suites swap the
  // fake platform, replacing the per-suite `await import('@platform/platform')`
  // dance every suite used to hand-roll to dodge this same rule.
  path.join(__dirname, 'src/test-kernel/support/setupPlatform.ts'),
]);

// The `@utils/*` modules the webview frontends may import at runtime. Each is
// held to the browser (no Node built-ins) and may import only the others, so
// the set stays closed under its own imports.
const BROWSER_SAFE_UTILS = [
  '@utils/core',
  '@utils/core/keyedMutex',
  '@utils/errors/errorMessage',
  '@utils/files/pastedImageName',
  '@utils/text/stringUtils',
];
const BROWSER_SAFE_UTILS_MESSAGE = `Browser-reachable code may import at runtime only the browser-safe utils (${BROWSER_SAFE_UTILS.join(', ')}); adding one means holding it to the browser too.`;
// A regex rather than a gitignore group: `@utils/**` would exclude the
// intermediate `@utils/text/` directory, and negation cannot re-include a
// file under an excluded directory.
const BROWSER_SAFE_UTILS_REGEX = `^@utils/(?!(?:${BROWSER_SAFE_UTILS.map((mod) => mod.slice('@utils/'.length)).join('|')})$)`;

// The CLI reads process input only through its runtime context and writes to
// the terminal only at its I/O boundary files.
const CLI_PROCESS_INPUT_RESTRICTIONS = ['argv', 'env', 'cwd'].map(
  (property) => ({
    object: 'process',
    property,
    message: `Read process.${property} through packages/cli/src/runtime/cliContext.ts.`,
  }),
);
const CLI_PROCESS_OUTPUT_RESTRICTIONS = [
  ...['log', 'error', 'warn'].map((property) => ({
    object: 'console',
    property,
  })),
  ...['exitCode', 'stdout', 'stderr'].map((property) => ({
    object: 'process',
    property,
  })),
].map((restriction) => ({
  ...restriction,
  message: `${restriction.object}.${restriction.property} stays at the CLI I/O boundary; write through packages/cli/src/runtime/logSinks.ts.`,
}));
const CLI_PROCESS_INPUT_BOUNDARY = ['packages/cli/src/runtime/cliContext.ts'];
const CLI_PROCESS_OUTPUT_BOUNDARY = [
  'packages/cli/src/bin/texra.ts',
  'packages/cli/src/runtime/logSinks.ts',
  // Ink mounts onto the real process streams in these launchers; the rest of
  // the TUI goes through logSinks.
  'packages/cli/src/orchestration/runOrchestrationTui.tsx',
  'packages/cli/src/init/runInitWizard.tsx',
  'packages/cli/src/onboarding/runOnboarding.tsx',
  'packages/cli/src/commands/loginProviderPicker.tsx',
  'packages/cli/src/config/runConfigTui.tsx',
];
// The chat TUI also hands Ink the real `process.stdin`, so it is both.
const CLI_PROCESS_IO_BOUNDARY = ['packages/cli/src/chat/tui/runChatTui.tsx'];

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
  'src/common',
  'src/utils',
  'src/logger',
  'packages/agent/src',
  'packages/llm/src',
  'packages/desktop/src',
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((dir) => path.join(__dirname, dir));

const HOST_LAYER_RESTRICTED_IMPORT_PATHS = [
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
      '@cli/**',
      '@desktop/**',
      '@test/**',
    ],
    message:
      'Production src code must not import extension, CLI, or desktop host layers or the test kernel; route host access through platform or host adapters.',
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
  const matchingAlias = ALIAS_ENTRIES.find((aliasEntry) => {
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
            'Disallow initPlatform and initProcessWorkspaceRoots imports outside composition roots.',
        },
        messages: {
          forbidden:
            'initPlatform and initProcessWorkspaceRoots may only be imported by composition roots; use platform() / workspaceRoots() elsewhere.',
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
                (specifier.imported.name === 'initPlatform' ||
                  specifier.imported.name === 'initProcessWorkspaceRoots')
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
    ignores: ['dist/', '**/*.d.{ts,mts}'],
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
      'src/**/*.{ts,mts}',
      'packages/agent/src/**/*.{ts,mts}',
      'packages/llm/src/**/*.{ts,mts}',
      'packages/extension/src/**/*.{ts,mts}',
      'packages/desktop/src/**/*.{ts,mts}',
      'packages/desktop/design-harness/**/*.{ts,mts}',
      'packages/desktop/tests/e2e/**/*.{ts,mts}',
      'packages/cli/src/**/*.{ts,mts}',
      'packages/cli/src/**/*.tsx',
      'packages/cli/scripts/**/*.{ts,mts}',
      'packages/cli/scripts/**/*.tsx',
      'packages/trace-viewer/src/**/*.{ts,mts}',
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
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
      import: importPlugin,
      local: localRules,
      unicorn,
    },
    rules: {
      'local/no-platform-init-outside-composition-root': 'error',

      // --- Unicorn modernization rules (ES2023+) ---
      'unicorn/prefer-string-replace-all': 'error',
      'unicorn/prefer-at': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-includes': 'error',
      'unicorn/prefer-array-find': 'error',
      'unicorn/no-array-push-push': 'error',
      'unicorn/prefer-spread': 'error',

      // #9698: a `default` must not stand in for members of a union we own.
      'local/exhaustive-switch-over-owned-union': 'error',

      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'import',
          format: ['camelCase', 'PascalCase'],
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-throw-literal': 'error',
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
          pathGroups: INTERNAL_ALIAS_PATH_GROUPS,
          distinctGroup: false,
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'ignore',
        },
      ],

      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'local/no-vscode-import-in-free-zones': 'error',
      'prefer-const': 'error',

      // No temporary adapters (owner ruling 2026-09-06, Effect 4 migration
      // execution rule 3): the marker that would date one fails outright.
      'no-warning-comments': [
        'error',
        { terms: ['@adapter-until'], location: 'anywhere' },
      ],
    },
  },

  // Tests run separately so their application-wide program is not retained
  // alongside the production programs. Both passes keep the same rules.
  {
    files: ['src/test-kernel/**/*.{ts,mts}'],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.test-kernel.json'] },
    },
  },

  // CLI scripts run in a fresh lint process so their program does not coexist
  // with the workspace and host programs. Select it directly rather than
  // creating every earlier project while searching for the script's owner.
  {
    files: ['packages/cli/scripts/**/*.{ts,tsx,mts}'],
    languageOptions: {
      parserOptions: { project: ['./packages/cli/tsconfig.scripts.json'] },
    },
  },

  // The native model package owns a standalone TypeScript program and lint process.
  {
    files: ['packages/llm/src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: ['./packages/llm/tsconfig.json'] },
    },
  },

  // Tooling owns a separate TypeScript program. The lint command runs this
  // group in a fresh process so the other projects are released first.
  {
    files: [
      'packages/desktop/design-harness/**/*.{ts,mts}',
      'packages/desktop/tests/e2e/**/*.{ts,mts}',
    ],
    languageOptions: {
      parserOptions: {
        project: ['./packages/desktop/tsconfig.tooling.json'],
      },
    },
  },

  {
    files: ['src/replacement/**/*.{ts,tsx,mts}'],
    rules: {
      'no-useless-escape': 'error',
    },
  },

  // Production core code must not reach back into host-owned layers; import
  // declarations are forbidden.
  {
    files: [
      'src/**/*.{ts,tsx,mts}',
      'packages/agent/src/**/*.{ts,tsx,mts}',
      'packages/llm/src/**/*.{ts,tsx,mts}',
    ],
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
    files: ['src/agent/core/**/*.{ts,tsx,mts}'],
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

  // The session graph takes its session as an explicit argument and its roots
  // from context (`WorkspaceRoots`), never from the async-local `currentSession()` or the
  // process default: Effect's scheduler drains many fibers' continuations in
  // one turn, so async-local state bleeds across fibers (PRD
  // one-fold-three-renderers, 7.3).
  {
    files: ['src/controllers/session/**/*.{ts,tsx,mts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: [
            ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
            {
              group: ['@agent/runtime', '@agent/runtime/SessionHandle'],
              importNames: ['currentSession', 'defaultSession'],
              message:
                'Session code takes its session as an explicit argument and its roots from context (WorkspaceRoots), never from currentSession() or defaultSession().',
            },
          ],
        },
      ],
    },
  },

  // Authentication owns credentials, sessions, and preferences. Model policy
  // may consume that state, but auth must not depend back on the model layer.
  {
    files: ['src/auth/**/*.{ts,tsx,mts}'],
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
      'packages/extension/src/{webview,progressView,settingsView}/frontend/**/*.{ts,tsx,mts}',
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
            {
              regex: BROWSER_SAFE_UTILS_REGEX,
              allowTypeImports: true,
              message: BROWSER_SAFE_UTILS_MESSAGE,
            },
          ],
        },
      ],
    },
  },

  // The browser-safe utils: no Node built-ins, and runtime imports of other
  // repo modules only from the set itself, by alias, so the allowlist sees
  // every edge and the frontends' reachable closure stays these five files.
  {
    files: BROWSER_SAFE_UTILS.map(
      (mod) => `${mod.replace('@utils', 'src/utils')}{.ts,/index.ts}`,
    ),
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: [
            ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
            {
              group: INTERNAL_ALIAS_NAMES.filter(
                (alias) => alias !== '@utils',
              ).flatMap((alias) => [alias, `${alias}/**`]),
              allowTypeImports: true,
              message: BROWSER_SAFE_UTILS_MESSAGE,
            },
            {
              regex: BROWSER_SAFE_UTILS_REGEX,
              allowTypeImports: true,
              message: BROWSER_SAFE_UTILS_MESSAGE,
            },
            {
              regex: '^\\.',
              message:
                'Browser-safe utils import each other by @utils alias, so the allowlist sees every edge.',
            },
          ],
        },
      ],
    },
  },

  // The CLI is neither a VS Code nor an Electron host, and it touches process
  // I/O only at its boundary files. Flat config replaces a rule's options
  // per matching block, so each boundary block restates what stays banned.
  {
    files: ['packages/cli/src/**/*.{ts,tsx,mts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['vscode', 'electron'].map((name) => ({
            name,
            message: 'The CLI host must not import VS Code or Electron.',
          })),
          patterns: [
            {
              group: ['vscode/**', 'electron/**'],
              message: 'The CLI host must not import VS Code or Electron.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        ...CLI_PROCESS_INPUT_RESTRICTIONS,
        ...CLI_PROCESS_OUTPUT_RESTRICTIONS,
      ],
    },
  },
  {
    files: CLI_PROCESS_INPUT_BOUNDARY,
    rules: {
      // The context also reads `process.stdout.isTTY` / `process.stderr.isTTY`
      // to classify the terminal, so the stream objects stay open to it.
      'no-restricted-properties': [
        'error',
        ...CLI_PROCESS_OUTPUT_RESTRICTIONS.filter(
          ({ object, property }) =>
            object !== 'process' || property === 'exitCode',
        ),
      ],
    },
  },
  {
    files: CLI_PROCESS_OUTPUT_BOUNDARY,
    rules: {
      'no-restricted-properties': ['error', ...CLI_PROCESS_INPUT_RESTRICTIONS],
    },
  },
  {
    files: CLI_PROCESS_IO_BOUNDARY,
    rules: { 'no-restricted-properties': 'off' },
  },
  // The fetch silencer swaps `console.error` for a filter around one call and
  // restores it; it intercepts a library's logging rather than writing output.
  {
    files: ['packages/cli/src/commands/_helpers/fetchSilencer.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...CLI_PROCESS_INPUT_RESTRICTIONS,
        ...CLI_PROCESS_OUTPUT_RESTRICTIONS.filter(
          ({ object, property }) =>
            object !== 'console' || property !== 'error',
        ),
      ],
    },
  },

  // `<wa-icon>` is constructed in exactly one place (`waIcon()`), so the
  // Font Awesome / Web Awesome icon set stays the single icon standard
  // instead of accumulating parallel hand-rolled `<wa-icon>` templates.
  {
    files: ['src/**/*.{ts,tsx,mts}', 'packages/**/*.{ts,tsx,mts}'],
    ignores: ['src/shared/wa/webAwesomeIcons.ts', '**/*.vitest.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/<wa-icon[\\s>\\/]/]',
          message:
            'Build <wa-icon> markup via waIcon() from @shared/wa/webAwesomeIcons instead of a hand-rolled template.',
        },
      ],
    },
  },
);
