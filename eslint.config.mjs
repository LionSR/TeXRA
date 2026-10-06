import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
import unicorn from 'eslint-plugin-unicorn';
import { existsSync } from 'node:fs';
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
  path.join(__dirname, 'packages/cli/src/runtime/cliProcessRuntime.ts'),
  // The package's composition root is `composeProcess`, which the Promise
  // entry and the Effect subpath's `Sessions.layer` both call.
  path.join(__dirname, 'packages/harness/src/effect/runtime.ts'),
  // The test suite's composition root: the one harness file that installs
  // the process runtime the session graph runs on, over the plugin list its
  // setup module passes (`sessionGraphTestSetup`, `builtinSessionGraphTestSetup`).
  path.join(__dirname, 'src/test-kernel/support/sessionGraphInstall.ts'),
]);

// The `@utils/*` modules the webview frontends may import at runtime. Each is
// held to the browser (no Node built-ins) and may import only the others, so
// the set stays closed under its own imports.
const BROWSER_SAFE_UTILS = [
  '@utils/core',
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
  'packages/cli/src/bin/texraServe.ts',
  'packages/cli/src/runtime/logSinks.ts',
  // Ink mounts onto the real process streams in these launchers; the rest of
  // the TUI goes through logSinks.
  'packages/cli/src/init/runInitWizard.tsx',
  'packages/cli/src/onboarding/runOnboarding.tsx',
  'packages/cli/src/config/runConfigTui.tsx',
];
// The chat TUI also hands Ink the real `process.stdin`, so it is both.
const CLI_PROCESS_IO_BOUNDARY = ['packages/cli/src/chat/tui/runChatTui.tsx'];

const VSCODE_FREE_ZONE_DIRS = [
  'packages/harness/src',
  'packages/texra/src',
  'packages/llm/src',
  'packages/desktop/src',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
].map((dir) => path.join(__dirname, dir));
// A zone that names a missing directory would hold nothing: fail loudly, so
// a move cannot leave the rule silently green.
for (const dir of VSCODE_FREE_ZONE_DIRS) {
  if (!existsSync(dir)) {
    throw new Error(`VSCODE_FREE_ZONE_DIRS names a missing directory: ${dir}`);
  }
}

// The SDK's entry files: the package's public surface and its Effect
// boundary (the host door below), as opposed to the harness modules under it.
const HARNESS_ENTRY_FILES = [
  'packages/harness/src/index.ts',
  'packages/harness/src/node.ts',
  'packages/harness/src/plugins.ts',
  'packages/harness/src/schemas.ts',
];
const HARNESS_ENTRY_GLOBS = [
  ...HARNESS_ENTRY_FILES,
  'packages/harness/src/effect/**/*.{ts,tsx,mts}',
];

// The named runtime entries that may call `Effect.run*` outside a host
// package (the no-restricted-syntax block below); the core-quality ratchet
// reads the same list.
export const EFFECT_RUN_ENTRIES = [
  'packages/extension/src/progressView/frontend/sessionTransport.ts',
  'packages/texra/src/shared/signals.ts',
  'packages/harness/src/platform/processRuntime.ts',
  // Worker entry: no process runtime exists in the worker.
  'packages/harness/src/agent/codeSandbox/worker.ts',
];

// The core the quality bar holds (owner, 2026-10-03: "super high coding
// quality like pi"): the harness side of the package split (PR #13639,
// harness-package-split.md §1) plus the model package. `no-explicit-any` is a
// hard lint error here; the rest is the shrink-only ratchet in
// scripts/check-core-quality.mjs over config/ratchets/core-quality/. M8
// re-keys it to packages/harness and packages/llm.
export const CORE_QUALITY_DIRS = [
  'packages/harness/src/agent',
  'packages/harness/src/shared/session',
  'packages/harness/src/shared/schemas',
  'packages/harness/src/tools',
  'packages/harness/src/controllers/session',
  'packages/harness/src/platform',
  'packages/harness/src/effect',
  ...HARNESS_ENTRY_FILES,
  'packages/llm/src',
];

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

// The harness imports nothing from the app (split design §4): not by an app
// alias, not by a relative path into packages/texra.
const HARNESS_NO_APP_IMPORT_PATTERNS = [
  {
    group: [
      '@texra',
      '@texra/**',
      '@latex/**',
      '@replacement/**',
      '@telemetry/**',
      '@housekeeping/**',
      '@ui/**',
    ],
    message:
      'The harness imports nothing from the app (packages/texra); take the value as an input, or move the module.',
  },
  {
    regex: '(?:^|/)packages/texra/',
    message:
      'The harness imports nothing from the app (packages/texra); take the value as an input, or move the module.',
  },
];

const AGENT_CORE_RESTRICTED_IMPORT_PATTERNS = [
  {
    group: ['@tools', '@tools/**'],
    message:
      'Agent core must not depend on tool implementations; src/tools consumes agent/core, not the reverse — move shared logic to agent/core or @shared.',
  },
  ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
  ...HARNESS_NO_APP_IMPORT_PATTERNS,
];

// `@texra-ai/llm` imports nothing else in the repo: it takes configuration
// and credentials as inputs. No baseline.
const LLM_RESTRICTED_IMPORT_PATTERNS = [
  {
    group: INTERNAL_ALIAS_NAMES.flatMap((alias) => [alias, `${alias}/**`]),
    message:
      '@texra-ai/llm imports nothing else in the repo; take the value as an input.',
  },
  {
    regex: '^@texra-ai/',
    message:
      '@texra-ai/llm imports nothing else in the repo; take the value as an input.',
  },
  {
    // Three levels up from `src/<dir>/` leaves the package.
    regex: '^(?:\\.\\./){3,}',
    message:
      '@texra-ai/llm imports nothing else in the repo; take the value as an input.',
  },
];

// The `.` entry of `@texra-ai/llm` is browser-safe: outside `api/`,
// `oauth/` and `node.ts` no module loads a Node built-in or a vendor SDK.
const LLM_BROWSER_SAFE_RESTRICTED_IMPORT_PATTERNS = [
  ...LLM_RESTRICTED_IMPORT_PATTERNS,
  {
    group: [
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/**',
      '@google/genai',
      '@google/genai/**',
      '@openrouter/sdk',
      '@openrouter/sdk/**',
      'openai',
      'openai/**',
      'ws',
    ],
    message:
      "@texra-ai/llm's browser-safe entry reaches no vendor SDK; protocol code lives in api/ and loads through bindModel.",
  },
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
    // Imports only. `@typescript-eslint/no-unused-vars` ignores `Schema$`
    // names so it does not report a module-level schema kept for
    // `z.infer<typeof X>`, and that pattern applies to imports too: this rule
    // still catches an unused `FooSchema` import.
    'no-unused-imports': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow imports nothing in the file reads.' },
        messages: {
          unused: "'{{name}}' is imported but never used: delete the import.",
        },
        schema: [],
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            for (const variable of context.sourceCode.getDeclaredVariables(
              node,
            )) {
              if (variable.references.length > 0) continue;
              context.report({
                node: variable.defs[0].node,
                messageId: 'unused',
                data: { name: variable.name },
              });
            }
          },
        };
      },
    },
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
    'no-process-runtime-install-outside-composition-root': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow installProcessRuntime imports outside composition roots.',
        },
        messages: {
          forbidden:
            'installProcessRuntime may only be imported by composition roots; elsewhere read process services from the Effect context and take the workspace roots as data from the session, run or tool call that holds them.',
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
            const importsInstall = node.specifiers.some((specifier) => {
              return (
                specifier.type === 'ImportSpecifier' &&
                specifier.imported.type === 'Identifier' &&
                specifier.imported.name === 'installProcessRuntime'
              );
            });

            if (!importsInstall) return;

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
    files: ['packages/harness/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Configuration for TypeScript files
  {
    files: [
      'src/**/*.{ts,mts}',
      'packages/harness/src/**/*.{ts,mts}',
      'packages/texra/src/**/*.{ts,mts}',
      'packages/llm/src/**/*.{ts,mts}',
      'packages/llm/test-live/**/*.{ts,mts}',
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
      'local/no-process-runtime-install-outside-composition-root': 'error',

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
      'no-useless-assignment': 'error',
      'preserve-caught-error': 'off',
      // `Schema$`: a module-level schema kept only for `z.infer<typeof X>`
      // reads as "only used as a type", but it is the value the type comes
      // from, so the repo keeps it on purpose. Unused imports of any name
      // stay with `local/no-unused-imports`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_|Schema$',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
      'local/no-unused-imports': 'error',
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

  // The core holds no `any` (count 0 at 2026-10-03), so it is a lint error
  // rather than a ratchet row.
  {
    files: CORE_QUALITY_DIRS.map((entry) =>
      entry.endsWith('.ts') ? entry : `${entry}/**/*.{ts,tsx,mts}`,
    ),
    ignores: ['**/*.vitest.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
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

  // The live tier is a separate program over the same package: its own
  // tsconfig, so the suites lint under the same rules as the sources they call.
  {
    files: ['packages/llm/test-live/**/*.ts'],
    languageOptions: {
      parserOptions: { project: ['./packages/llm/tsconfig.test-live.json'] },
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
    files: ['packages/texra/src/replacement/**/*.{ts,tsx,mts}'],
    rules: {
      'no-useless-escape': 'error',
    },
  },

  // Production core code must not reach back into host-owned layers; import
  // declarations are forbidden.
  {
    files: [
      'src/**/*.{ts,tsx,mts}',
      'packages/harness/src/**/*.{ts,tsx,mts}',
      'packages/texra/src/**/*.{ts,tsx,mts}',
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

  // The harness imports nothing from the app: the app plugs in as an input
  // (its plugin list, a host's layers), never as an import.
  {
    files: ['packages/harness/src/**/*.{ts,tsx,mts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: HOST_LAYER_RESTRICTED_IMPORT_PATHS,
          patterns: [
            ...HOST_LAYER_RESTRICTED_IMPORT_PATTERNS,
            ...HARNESS_NO_APP_IMPORT_PATTERNS,
          ],
        },
      ],
    },
  },

  // Agent core is the neutral execution layer. It may depend on shared agent
  // contracts, but not on concrete provider-handler implementations.
  {
    files: ['packages/harness/src/agent/core/**/*.{ts,tsx,mts}'],
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

  // The model package imports nothing else in the repo, by alias, by
  // package name or by a relative path out of the package.
  {
    files: ['packages/llm/src/**/*.{ts,tsx,mts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: LLM_RESTRICTED_IMPORT_PATTERNS },
      ],
    },
  },
  {
    files: ['packages/llm/src/**/*.{ts,tsx,mts}'],
    ignores: [
      'packages/llm/src/api/**',
      'packages/llm/src/oauth/**',
      'packages/llm/src/node.ts',
    ],
    rules: {
      'import/no-nodejs-modules': 'error',
      'no-restricted-imports': [
        'error',
        { patterns: LLM_BROWSER_SAFE_RESTRICTED_IMPORT_PATTERNS },
      ],
    },
  },

  // Extension browser frontends may use host-neutral types from backend
  // modules, but runtime values must come from browser-safe shared modules.
  {
    files: [
      'packages/extension/src/{progressView,settingsView}/frontend/**/*.{ts,tsx,mts}',
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
              group: [
                '@texra-ai/harness',
                '@texra-ai/harness/node',
                '@texra-ai/harness/plugins',
              ],
              allowTypeImports: true,
              message:
                'A browser frontend imports only types from this harness entry; take runtime values from @texra-ai/harness/schemas.',
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
      (mod) =>
        `${mod.replace('@utils', 'packages/harness/src/utils')}{.ts,/index.ts}`,
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
    ignores: ['packages/texra/src/ui/wa/webAwesomeIcons.ts', '**/*.vitest.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/<wa-icon[\\s>\\/]/]',
          message:
            'Build <wa-icon> markup via waIcon() from @ui/wa/webAwesomeIcons instead of a hand-rolled template.',
        },
      ],
    },
  },

  // Effect runs belong at a host entry (packages/{extension,desktop,cli}/src, or the SDK entry files and packages/harness/src/effect)
  // or at a webview/runtime composition root that owns its runtime (owner
  // ruling 2026-09-06, Effect 4 migration R1; 2026-09-14 for the named
  // entries, which are exempt whole-file: that the run is on the entry's own
  // runtime is enforced by review). Everywhere else a run is below the
  // boundary: convert the file and its callers so the run moves to a host
  // entry. `new AbortController()` is held to its two permanent residents
  // (rulings ledger, "permanent AbortController residents"). Flat config
  // replaces the `no-restricted-syntax` array for a file, so each file group
  // below lists every selector that applies to it.
  ...(() => {
    const waIcon = {
      selector: 'TemplateElement[value.raw=/<wa-icon[\\s>\\/]/]',
      message:
        'Build <wa-icon> markup via waIcon() from @ui/wa/webAwesomeIcons instead of a hand-rolled template.',
    };
    const runMessage =
      'Effect runs belong at a host entry (packages/{extension,desktop,cli}/src, or the SDK entry files and packages/harness/src/effect) or a named runtime entry in eslint.config.mjs. Convert this file and its callers so the run moves there.';
    // `runMain` is `NodeRuntime.runMain`, the run of a process or worker entry.
    const runNames = '/^run(Promise|PromiseExit|Sync|Fork|Callback|Main)$/';
    const run = [
      {
        selector: `CallExpression[callee.property.name=${runNames}]`,
        message: runMessage,
      },
      {
        selector: `CallExpression[callee.name=${runNames}]`,
        message: runMessage,
      },
    ];
    const abort = {
      selector: "NewExpression[callee.name='AbortController']",
      message:
        'No new AbortController: the two permanent residents are named in eslint.config.mjs (rulings ledger). Use fiber interruption or Effect.abortSignal.',
    };
    const entries = EFFECT_RUN_ENTRIES;
    const residents = [
      'packages/harness/src/agent/runtime/childRunLoop.ts',
      'packages/texra/src/tools/agentCli/claudeAgent.ts',
    ];
    const iconFile = 'packages/texra/src/ui/wa/webAwesomeIcons.ts';
    const block = (files, ignores, ...selectors) => ({
      files,
      ignores,
      rules: { 'no-restricted-syntax': ['error', ...selectors] },
    });
    return [
      // Hosts may run effects; they still may not add an AbortController.
      block(
        [
          'packages/extension/src/**/*.{ts,tsx,mts}',
          'packages/desktop/src/**/*.{ts,tsx,mts}',
          'packages/cli/src/**/*.{ts,tsx,mts}',
          ...HARNESS_ENTRY_GLOBS,
        ],
        ['**/*.vitest.ts', iconFile, ...entries],
        waIcon,
        abort,
      ),
      // Everything else, webview frontends included (later wins over the host
      // block for the frontends).
      block(
        [
          'src/**/*.{ts,tsx,mts}',
          'packages/harness/src/**/*.{ts,tsx,mts}',
          'packages/texra/src/**/*.{ts,tsx,mts}',
          'packages/llm/src/**/*.{ts,tsx,mts}',
          'packages/trace-viewer/src/**/*.{ts,tsx,mts}',
          'packages/extension/src/progressView/frontend/**/*.{ts,tsx,mts}',
          'packages/extension/src/settingsView/frontend/**/*.{ts,tsx,mts}',
        ],
        [
          'src/test-kernel/**',
          '**/*.vitest.ts',
          iconFile,
          ...entries,
          ...residents,
          ...HARNESS_ENTRY_GLOBS,
        ],
        waIcon,
        ...run,
        abort,
      ),
      block(entries, [], waIcon, abort),
      block(residents, [], waIcon, ...run),
      block([iconFile], [], ...run, abort),
    ];
  })(),
);
