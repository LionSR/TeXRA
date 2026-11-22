// Settings scenes: the real settings view, fed the messages its host posts.
// The Plugins page lists one fixture row of each kind; General › Approval
// holds the approval policy the Tools page used to.
import { html, type TemplateResult } from 'lit';

import '@ui/settings/SettingsApp';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import type { PluginRow } from '@texra/shared/settingsView/settingsViewMessages';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';

const ROWS: PluginRow[] = [
  {
    kind: 'texra',
    item: {
      id: 'lean4',
      name: 'Lean 4 Proof Assistant',
      description:
        'Interact with Lean 4 projects: check diagnostics, inspect terms, and manage files.',
      tools: [
        { name: 'lean_diagnostics' },
        { name: 'lean_file' },
        { name: 'lean_project' },
        { name: 'lean_inspect' },
      ],
      setup: { status: 'available', installActions: [] },
      switch: 'always-on',
    },
  },
  {
    kind: 'texra',
    item: {
      id: 'zotero',
      name: 'Zotero Integration',
      description:
        'Search, add items to, and export citations from your Zotero library.',
      tools: [
        { name: 'zotero_collections' },
        { name: 'zotero_search' },
        { name: 'zotero_add' },
      ],
      setup: {
        status: 'not-found',
        statusLabel: 'Needs Zotero running',
        installActions: [
          {
            kind: 'guide',
            text: 'Requires Zotero with the Better BibTeX plugin installed.',
          },
          {
            kind: 'url',
            url: 'https://retorque.re/zotero-better-bibtex/installation/',
          },
        ],
      },
      switch: 'off',
    },
  },
  {
    kind: 'installed',
    plugin: {
      name: 'lean-mathlib',
      source: 'github.com/acme/lean-mathlib',
      commit: '3f2a9c1d7e4b5a6f',
      version: 'v1.2',
      enabled: true,
      trusted: true,
      code: [],
      skillCount: 2,
      commandCount: 0,
      agentCount: 0,
      programs: [],
      mcpServers: ['mathlib-search'],
    },
  },
  {
    kind: 'mcp',
    name: 'arxiv-mcp',
    command: 'npx -y arxiv-mcp-server',
  },
];

/** The settings view on one page, its data posted as the host would. */
function settingsAt(tab: SettingsTarget): TemplateResult {
  queueMicrotask(() => {
    window.postMessage({ command: SETTINGS_VIEW_COMMANDS.SET_TAB, tab }, '*');
    window.postMessage(
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_HOST_STATE,
        patch: { plugins: { rows: ROWS, mcpWarnings: [] } },
      },
      '*',
    );
  });
  return html`<div
    id="frame"
    style="width: 900px; height: 1100px; overflow: hidden; background: var(--wa-color-surface-default)"
  >
    <settings-app></settings-app>
  </div>`;
}

export const settingsScenes: Record<string, () => TemplateResult> = {
  'settings-plugins': () => settingsAt('plugins'),
  'settings-approval': () => settingsAt('general/approval'),
};
