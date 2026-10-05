// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import { harnessBuiltins } from '@tools/builtinPlugins';
import { PLUGIN_ARMS } from '@tools/pluginArms';
import { TEXRA_PLUGIN_CARDS } from '@tools/pluginCards';
import type { Plugin } from '@tools/plugins';
import { texraPlugins } from '@tools/registry';
import {
  ALL_HOST_PRODUCTION_ROOTS,
  collectModuleSpecifiers,
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

/**
 * Invariants 1 and 6 of the core concepts, for what a plugin brings: its
 * own row kinds (`PLUGIN_EVENT_ARMS`) and its services (a `Plugin`'s
 * `processLayer` and `sessionLayer`). Failure modes guarded:
 *
 * - core (`src/shared`, `src/agent`) imports a plugin's arm, so a plugin's
 *   row kind is hard-coded in core again and a new stateful plugin edits
 *   core;
 * - a plugin row is drafted anywhere but its plugin's arm module, or a
 *   plugin reaches the store's append port, so a second append path or a
 *   row no arm checks appears;
 * - a plugin's service is reached outside its own plugin's code, which the
 *   step serves it to, and the one host door (the settings Git tab reading
 *   the GitHub plugin's process services through `LiveTools`), so plugin
 *   state is used past its switch and its pin. The table holds each
 *   plugin with its services erased (`PluginContext` in `processRuntime.ts`),
 *   so no `ProcessServices` arm names one.
 */
const PLUGIN_ARM_MODULES = /^src\/shared\/plugins\//;
const PLUGIN_ARM_IMPORT = /^@shared\/plugins\/|^@tools\/pluginArms$/;
const CORE = /^src\/(?:shared|agent)\//;
const APPEND_PORTS =
  /^@(?:controllers\/session\/Database|shared\/session\/database|agent\/runtime\/SessionEvents)$/;
const PLUGIN_ROW = /type:\s*'plugin\.fact'/;

/** Each plugin service and the files that may reach it. */
const PLUGIN_SERVICES: readonly {
  readonly tag: string;
  readonly users: RegExp;
}[] = [
  {
    tag: 'GitHubSubscriptions',
    users:
      /^src\/tools\/(?:github\/|integrationPlugins\.ts$)|^src\/controllers\/settingsView\/githubSubscriptions\.ts$/,
  },
  { tag: 'CodexThreads', users: /^src\/tools\/codex\.ts$/ },
  { tag: 'ClaudeAgentSessions', users: /^src\/tools\/claudeAgent\.ts$/ },
  // The Lean 4 plugin's port: its tools and probe, and the VS Code host's
  // bridge, which that host passes as the plugin's layer.
  {
    tag: 'LeanLanguageServices',
    users:
      /^src\/tools\/(?:lean\/|pluginAvailability\.ts$)|^packages\/extension\/src\/(?:extension\.ts|frontend\/lean\/VscodeIntegration\.ts)$/,
  },
  // The `core` plugin's Comments UI port: its tool.
  { tag: 'InlineComments', users: /^src\/tools\/comment\// },
];
/** Where the services are declared, typed and built. */
const SERVICE_HOMES = new Set([
  'src/tools/agentCliSessionStores.ts',
  'src/tools/integrationPlugins.ts',
  'src/tools/registry.ts',
  'src/platform/processRuntime.ts',
]);

const files = () => ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder);
const source = (file: string) =>
  stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
const specifiers = (file: string) =>
  collectModuleSpecifiers(parseSourceFile(resolve(REPO_ROOT, file)));

describe('plugin boundaries (invariants 1 and 6)', () => {
  it('keeps plugin arms out of core', () => {
    const offenders = files()
      .filter((file) => CORE.test(file) && !PLUGIN_ARM_MODULES.test(file))
      .filter((file) =>
        specifiers(file).some((s) => PLUGIN_ARM_IMPORT.test(s)),
      );
    expect(offenders).toEqual([]);
  });

  it('drafts plugin rows only in arm modules, which reach no append port', () => {
    const drafts = files()
      .filter((file) => !PLUGIN_ARM_MODULES.test(file))
      .filter((file) => PLUGIN_ROW.test(source(file)));
    const appends = files()
      .filter((file) => PLUGIN_ARM_MODULES.test(file))
      .filter((file) => specifiers(file).some((s) => APPEND_PORTS.test(s)));
    expect({ drafts, appends }).toEqual({ drafts: [], appends: [] });
  });

  it('reaches plugin services only from their plugin and the step', () => {
    const offenders = PLUGIN_SERVICES.flatMap(({ tag, users }) =>
      files()
        .filter((file) => !users.test(file) && !SERVICE_HOMES.has(file))
        .filter((file) => new RegExp(`\\b${tag}\\b`).test(source(file)))
        .map((file) => `${file} reaches ${tag}`),
    );
    expect(offenders).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});

/** Each plugin of a list, with the tools it offers the model, in order. */
const roster = (plugins: readonly Plugin[]) =>
  plugins.map(({ id, tools }) => [id, Object.keys(tools ?? {})]);

/**
 * Split design §4: one case pins each list a host or embedder composes the
 * process from. Every TeXRA host passes `texraPlugins` (the extension adds
 * only Copilot's host layer to the `copilot` entry), and the SDK's examples
 * pass the harness's own lists. A plugin or tool that joins or leaves a list
 * changes what every agent on it can be offered, so it is a reviewed change
 * here, not a side effect of an import.
 */
describe('plugin rosters', () => {
  it("pins TeXRA's plugins and their tools, in dashboard order", () => {
    expect(roster(texraPlugins())).toEqual([
      [
        'file-ops',
        ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
      ],
      [
        'latex-extract',
        ['extract_figures', 'extract_tikz_figures', 'extract_bib_entries'],
      ],
      ['latex-diagnostics', ['diagnostics']],
      ['arxiv', ['arxiv_search', 'download_arxiv_source']],
      ['web', ['web_search', 'web_fetch']],
      ['memory-workflow', ['memory', 'executions']],
      ['goal', ['plan']],
      ['wolfram', []],
      [
        'zotero',
        ['zotero_collections', 'zotero_search', 'zotero_add', 'zotero_export'],
      ],
      [
        'lean4',
        ['lean_diagnostics', 'lean_file', 'lean_project', 'lean_inspect'],
      ],
      ['multi-agent', ['agent']],
      ['github-pr-subscription', ['github_subscription']],
      ['external-inquiry', ['inquiry']],
      ['codex', ['codex']],
      ['claude-agent', ['claude_code']],
      [
        'core',
        ['inline_comment', 'open_pdf', 'ask_user_question', 'lean_loogle'],
      ],
      ['codemode', ['script']],
      [
        'setup',
        [
          'probe_environment',
          'verify_setup',
          'unset_api_key',
          'list_api_keys',
          'invoke_command',
          'install_vscode_extension',
          'read_config',
          'update_config',
          'send_to_terminal',
          'apply_team',
        ],
      ],
      ['copilot', []],
      [
        'documents',
        [
          'accept_run_files',
          'document_task',
          'document_context',
          'document_extract',
          'document_compile',
          'document_diff',
          'document_review',
          'document_propose',
        ],
      ],
    ]);
  });

  it('gives every switchable plugin a dashboard card, and every card a plugin', () => {
    // A switch with no card would be off with nothing to turn it on.
    const plugins = texraPlugins();
    const carded = new Set(TEXRA_PLUGIN_CARDS.map(({ id }) => id));
    const listed = new Set(plugins.map(({ id }) => id));
    expect({
      switchedWithoutCard: plugins
        .filter(({ id, toggle }) => toggle !== undefined && !carded.has(id))
        .map(({ id }) => id),
      cardWithoutPlugin: [...carded].filter((id) => !listed.has(id)),
    }).toEqual({ switchedWithoutCard: [], cardWithoutPlugin: [] });
  });

  it('pins the row kinds plugins write, each of a listed plugin', () => {
    const ids = new Set(texraPlugins().map(({ id }) => id));
    expect(
      [...PLUGIN_ARMS.values()].map(({ plugin, kind }) => [
        `${plugin}/${kind}`,
        ids.has(plugin),
      ]),
    ).toEqual([
      ['goal/state', true],
      ['documents/output', true],
      ['external-inquiry/thread', true],
    ]);
  });

  it("pins the harness's built-in lists", () => {
    expect({
      all: roster(harnessBuiltins.all),
      minimal: roster(harnessBuiltins.minimal),
    }).toEqual({
      all: [
        [
          'file-ops',
          ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
        ],
        ['web', ['web_search', 'web_fetch']],
        ['memory-workflow', ['memory', 'executions']],
        ['goal', ['plan']],
        ['multi-agent', ['agent']],
        ['codemode', ['script']],
      ],
      minimal: [
        [
          'file-ops',
          ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
        ],
      ],
    });
  });
});
