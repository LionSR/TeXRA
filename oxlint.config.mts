/**
 * The oxlint configuration, loaded by `npm run lint` and the editor's oxlint
 * language server.
 *
 * Each import or property ban is a named set, listed once in a zone table with
 * the directories and files where it holds. oxlint keeps only the last
 * matching override's options for a rule, so `zoneOverrides` writes one
 * override per listed place carrying every set that holds there, the deepest
 * places last.
 */

// Third-party imports
import { defineConfig } from 'oxlint';
import type { DummyRule, OxlintOverride } from 'oxlint';

// Node imports
import { resolve, sep } from 'node:path';

// Local imports
import { aliases, rootDir } from './scripts/aliases.mjs';

interface ImportBan {
  group?: string[];
  regex?: string;
  allowTypeImports?: boolean;
  message: string;
}

interface PropertyBan {
  object?: string;
  property: string;
  message: string;
}

/** A ban set and where it holds: repository-relative directories or files. */
interface Zone<Ban> {
  bans: Ban[];
  in: string[];
  except?: string[];
}

/** The override globs for a directory or a file. */
const globs = (place: string) => [place, `${place}/**`];

/**
 * The import patterns for the tsconfig aliases that point under one of
 * `dirs`: each alias bare and with a subpath.
 */
function aliasPatterns(dirs: string[]): string[] {
  const roots = dirs.map((dir) => `${resolve(rootDir, dir)}${sep}`);
  return Object.entries(aliases)
    .filter(([, target]) =>
      roots.some((root) => `${target}${sep}`.startsWith(root)),
    )
    .flatMap(([alias]) => [alias, `${alias}/**`]);
}

/**
 * One override per place named in `zones`, ordered by depth so a deeper
 * place's override replaces the one around it. A place where no set holds
 * turns the rule off.
 */
function zoneOverrides<Ban>(
  rule: string,
  zones: Zone<Ban>[],
  options: (bans: Ban[]) => DummyRule,
): OxlintOverride[] {
  const covers = (places: string[] | undefined, path: string) =>
    places?.some((place) => path === place || path.startsWith(`${place}/`)) ??
    false;
  const places = [
    ...new Set(zones.flatMap((zone) => [...zone.in, ...(zone.except ?? [])])),
  ].toSorted((a, b) => a.split('/').length - b.split('/').length);
  return places.map((place) => {
    const bans = zones
      .filter((zone) => covers(zone.in, place) && !covers(zone.except, place))
      .flatMap((zone) => zone.bans);
    return {
      files: globs(place),
      rules: { [rule]: bans.length > 0 ? options(bans) : 'off' },
    };
  });
}

// Import bans

const VSCODE: ImportBan[] = [
  {
    group: ['vscode'],
    message: 'VS Code-free zone: reach the host through a port.',
  },
];

const HOST_LAYER: ImportBan[] = [
  {
    group: aliasPatterns([
      'packages/extension',
      'packages/cli',
      'packages/desktop',
      'src/test-kernel',
    ]),
    message:
      'No host layer or test kernel import: reach the host through a port.',
  },
];

const HARNESS_NO_APP =
  'The harness imports nothing from the app: take the value as an input.';
const APP: ImportBan[] = [
  { group: aliasPatterns(['packages/texra']), message: HARNESS_NO_APP },
  { regex: '(?:^|/)packages/texra/', message: HARNESS_NO_APP },
];

const BROWSER_SAFE_ENTRIES =
  'Browser bundle: use @texra-ai/harness/schemas or /transcript.';
const BROWSER_BUNDLE: ImportBan[] = [
  {
    group: ['@common', '@common/**', '@tools', '@tools/**'],
    allowTypeImports: true,
    message: 'Browser bundle: runtime values come from browser-safe modules.',
  },
  {
    group: ['@utils', '@utils/**'],
    allowTypeImports: true,
    message: BROWSER_SAFE_ENTRIES,
  },
  {
    regex: '^@texra-ai/harness(/host|/node|/plugins)?$',
    message: BROWSER_SAFE_ENTRIES,
  },
];

const VSCODE_OR_ELECTRON: ImportBan[] = [
  {
    group: ['vscode', 'vscode/**', 'electron', 'electron/**'],
    message: 'The CLI host must not import VS Code or Electron.',
  },
];

const LLM_ALONE =
  '@texra-ai/llm imports nothing else in the repo; take the value as an input.';
/**
 * Every tsconfig alias, the workspace's npm scope, and relative paths three
 * or more levels up.
 */
const REPO_MODULES: ImportBan[] = [
  { group: [...aliasPatterns(['.']), '@texra-ai/**'], message: LLM_ALONE },
  { regex: '^(?:\\.\\./){3,}', message: LLM_ALONE },
];

const VENDOR_SDKS: ImportBan[] = [
  {
    group: [
      '@anthropic-ai/sdk',
      '@anthropic-ai/sdk/**',
      '@google/genai',
      '@google/genai/**',
      'openai',
      'openai/**',
      'ws',
    ],
    message:
      'The browser-safe llm entry loads no vendor SDK: protocol code lives in api/.',
  },
];

// Property bans

const RUN_EFFECT: PropertyBan[] = [
  'runPromise',
  'runPromiseExit',
  'runSync',
  'runSyncExit',
  'runFork',
  'runCallback',
  'runMain',
].map((property) => ({
  property,
  message:
    'Run Effects only at a host entry or a runtime entry named in oxlint.config.mts.',
}));

const THEN: PropertyBan[] = [
  {
    property: 'then',
    message: '`.then(` chains in core: compose with Effect instead.',
  },
];

const PROCESS_INPUT: PropertyBan[] = ['argv', 'env', 'cwd'].map((property) => ({
  object: 'process',
  property,
  message: 'Read process input through runtime/cliContext.ts.',
}));

const WRITE_THROUGH_SINKS = 'Write output through runtime/logSinks.ts.';
const OUTPUT: PropertyBan[] = [
  ...['log', 'error', 'warn'].map((property) => ({
    object: 'console',
    property,
    message: WRITE_THROUGH_SINKS,
  })),
  { object: 'process', property: 'exitCode', message: WRITE_THROUGH_SINKS },
];

/** Readers check these streams' TTY flags; writers write to them. */
const STREAMS: PropertyBan[] = ['stdout', 'stderr'].map((property) => ({
  object: 'process',
  property,
  message: WRITE_THROUGH_SINKS,
}));

// Zones

const VSCODE_FREE = [
  'packages/harness/src',
  'packages/texra/src',
  'packages/llm/src',
  'packages/desktop/src',
  'packages/extension/src/settingsView/frontend',
];

/** Code bundled for a webview or a browser page. */
const BROWSER_BUNDLES = [
  'packages/texra/src/ui',
  'packages/extension/src/settingsView/frontend',
  'packages/desktop/src/renderer',
  'packages/trace-viewer/src',
];

/** Banned here: `.then(`, `new Promise` and an asserted object literal. */
const CORE = [
  'packages/harness/src/agent',
  'packages/harness/src/shared/session',
  'packages/harness/src/shared/schemas',
  'packages/harness/src/tools',
  'packages/harness/src/controllers/session',
  'packages/harness/src/platform',
  'packages/harness/src/effect',
  'packages/llm/src',
  'packages/harness/src/index.ts',
  'packages/harness/src/host.ts',
  'packages/harness/src/node.ts',
  'packages/harness/src/plugins.ts',
  'packages/harness/src/schemas.ts',
  'packages/harness/src/transcriptEntry.ts',
];

/** The runtime entries outside the hosts: the files that may run an Effect. */
const RUNTIME_ENTRIES = [
  'packages/harness/src/platform/processRuntime.ts',
  'packages/harness/src/agent/codeSandbox/worker.ts',
  'packages/texra/src/ui/progress/sessionTransport.ts',
  'packages/texra/src/shared/signals.ts',
];

/** The llm protocol code, which may load Node built-ins and vendor SDKs. */
const LLM_PROTOCOLS = [
  'packages/llm/src/api',
  'packages/llm/src/oauth',
  'packages/llm/src/node.ts',
];

/** CLI files that read process input; the rest go through cliContext.ts. */
const CLI_READERS = [
  'packages/cli/src/runtime/cliContext.ts',
  'packages/cli/src/chat/tui/runChatTui.tsx',
];

/** CLI files that write process output; the rest write through logSinks.ts. */
const CLI_WRITERS = [
  'packages/cli/src/bin/texra.ts',
  'packages/cli/src/bin/texraServe.ts',
  'packages/cli/src/runtime/logSinks.ts',
  'packages/cli/src/init/runInitWizard.tsx',
  'packages/cli/src/config/runConfigTui.tsx',
  'packages/cli/src/chat/tui/runChatTui.tsx',
];

const IMPORT_ZONES: Zone<ImportBan>[] = [
  { bans: VSCODE, in: VSCODE_FREE },
  { bans: HOST_LAYER, in: ['packages/harness/src', 'packages/texra/src'] },
  { bans: APP, in: ['packages/harness/src'] },
  { bans: BROWSER_BUNDLE, in: BROWSER_BUNDLES },
  { bans: VSCODE_OR_ELECTRON, in: ['packages/cli/src'] },
  { bans: REPO_MODULES, in: ['packages/llm/src'] },
  { bans: VENDOR_SDKS, in: ['packages/llm/src'], except: LLM_PROTOCOLS },
];

const PROPERTY_ZONES: Zone<PropertyBan>[] = [
  {
    bans: RUN_EFFECT,
    in: [
      'packages/harness/src',
      'packages/texra/src',
      'packages/llm/src',
      'packages/trace-viewer/src',
      'packages/extension/src/settingsView/frontend',
    ],
    except: RUNTIME_ENTRIES,
  },
  { bans: THEN, in: CORE },
  { bans: PROCESS_INPUT, in: ['packages/cli/src'], except: CLI_READERS },
  { bans: OUTPUT, in: ['packages/cli/src'], except: CLI_WRITERS },
  {
    bans: STREAMS,
    in: ['packages/cli/src'],
    except: [...CLI_READERS, ...CLI_WRITERS],
  },
];

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'import', 'promise'],
  categories: {
    correctness: 'error',
  },
  ignorePatterns: [
    'dist/',
    '**/*.d.ts',
    '**/*.d.mts',
    'packages/harness/example/**',
  ],
  rules: {
    'promise/valid-params': 'off',
    'unicorn/no-useless-spread': 'off',
  },
  overrides: [
    {
      files: ['**/*.{ts,tsx,mts}'],
      rules: {
        eqeqeq: ['error', 'always', { null: 'ignore' }],
        'no-throw-literal': 'error',
        'no-unused-vars': [
          'error',
          {
            args: 'after-used',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_|Schema$',
            caughtErrors: 'none',
            ignoreRestSiblings: true,
          },
        ],
        'typescript/no-explicit-any': 'error',
      },
    },
    {
      files: ['src/test-kernel/**', 'packages/*/test/**'],
      rules: {
        'typescript/no-non-null-assertion': 'error',
      },
    },
    {
      files: ['packages/*/src/**'],
      rules: {
        'typescript/no-non-null-assertion': 'error',
        'no-restricted-globals': [
          'error',
          {
            name: 'AbortController',
            message: 'Use fiber interruption or Effect.abortSignal.',
          },
        ],
      },
    },
    {
      files: ['packages/texra/src/tools/agentCli/claudeAgent.ts'],
      rules: {
        'no-restricted-globals': 'off',
      },
    },
    {
      files: CORE.flatMap(globs),
      rules: {
        'promise/avoid-new': 'error',
        'typescript/consistent-type-assertions': [
          'error',
          { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
        ],
      },
    },
    {
      files: ['packages/llm/src/**'],
      excludeFiles: LLM_PROTOCOLS.flatMap(globs),
      rules: {
        'import/no-nodejs-modules': 'error',
      },
    },
    ...zoneOverrides('no-restricted-imports', IMPORT_ZONES, (patterns) => [
      'error',
      { patterns },
    ]),
    ...zoneOverrides('no-restricted-properties', PROPERTY_ZONES, (bans) => [
      'error',
      ...bans,
    ]),
  ],
});
