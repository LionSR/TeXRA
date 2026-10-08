// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import { TEXRA_PLUGIN_CARDS } from '@texra/tools/pluginCards';
import { texraPlugins } from '@texra/tools/registry';
import { harnessBuiltins } from '@tools/builtinPlugins';
import { armsOf, type Plugin } from '@tools/plugins';
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
 * own row kinds (`Plugin.arms`) and its services (a `Plugin`'s
 * `processLayer` and `sessionLayer`). Failure modes guarded:
 *
 * - core (the harness's `shared/`, `agent/`) imports a plugin's arm, so a plugin's
 *   row kind is hard-coded in core again and a new stateful plugin edits
 *   core;
 * - a plugin row is drafted anywhere but its plugin's arm module or the
 *   dispatch that commits a call's facts with its result, or a
 *   plugin reaches the store's append port, so a second append path or a
 *   row no arm checks appears;
 * - a plugin's service is reached outside its own plugin's code, which the
 *   step serves it to, and the one host door (the settings Git tab reading
 *   the GitHub plugin's process services through `ToolCatalog`), so plugin
 *   state is used past its switch and its pin. The table holds each
 *   plugin with its services erased (`PluginContext` in `processRuntime.ts`),
 *   so no `ProcessServices` arm names one.
 */
const PLUGIN_ARM_MODULES = /^packages\/harness\/src\/shared\/plugins\//;
const PLUGIN_ARM_IMPORT = /^@shared\/plugins\//;
const CORE = /^packages\/harness\/src\/(?:shared|agent)\//;
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
      /^packages\/texra\/src\/(?:tools\/(?:github\/|integrationPlugins\.ts$)|controllers\/settingsView\/githubSubscriptions\.ts$)/,
  },
  { tag: 'CodexThreads', users: /^packages\/texra\/src\/tools\/codex\.ts$/ },
  {
    tag: 'ClaudeAgentSessions',
    users: /^packages\/texra\/src\/tools\/claudeAgent\.ts$/,
  },
  // The Lean 4 plugin's port: its tools and probe, and the VS Code host's
  // bridge, which that host passes as the plugin's layer.
  {
    tag: 'LeanLanguageServices',
    users:
      /^packages\/texra\/src\/tools\/(?:lean\/|pluginAvailability\.ts$)|^packages\/extension\/src\/(?:extension\.ts|frontend\/lean\/VscodeIntegration\.ts)$/,
  },
  // The `core` plugin's Comments UI port: its tool.
  { tag: 'InlineComments', users: /^packages\/texra\/src\/tools\/comment\// },
];
/** Where the services are declared, typed and built. */
const SERVICE_HOMES = new Set([
  'packages/texra/src/tools/agentCliSessionStores.ts',
  'packages/texra/src/tools/integrationPlugins.ts',
  'packages/texra/src/tools/registry.ts',
  'packages/harness/src/platform/processRuntime.ts',
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
    // The one generic writer: the dispatch commits a call's facts
    // (`ToolResult.facts`) as rows of its run with its `tool.result`.
    expect({ drafts, appends }).toEqual({
      drafts: ['packages/harness/src/agent/runtime/loop/toolUseDispatch.ts'],
      appends: [],
    });
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

  it('pins the row kinds plugins write', () => {
    // `armsOf` refuses an arm of another plugin's id, or a kind twice.
    expect(Object.keys(armsOf(texraPlugins())).toSorted()).toEqual([
      'documents/accepted',
      'documents/output',
      'external-inquiry/thread',
      'goal/state',
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
