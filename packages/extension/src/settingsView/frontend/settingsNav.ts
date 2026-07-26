/**
 * Settings top-navigation presentation layer.
 *
 * Deliberately separate from the tab wire format. `SETTINGS_TAB_ORDER` fixes
 * the indices that travel over IPC (`SET_TAB.tabIndex`) and are hand-copied
 * into the desktop e2e index tables, so nav grouping, nav order, labels, and
 * icons live here and address panels by name. Reordering or regrouping the nav
 * therefore cannot change what an existing index means.
 */

import {
  SETTINGS_TAB_GROUPS,
  SETTINGS_TAB_PANEL_BY_NAME,
  type SettingsTabName,
} from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/webAwesomeIcons';

export interface SettingsNavEntry {
  readonly name: SettingsTabName;
  /** `wa-tab-panel` name — the addressing key the nav and e2e selectors share. */
  readonly panel: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly description: string;
}

export interface SettingsNavGroup {
  readonly label: string;
  readonly icon: TeXRAIconName;
  readonly entries: readonly SettingsNavEntry[];
}

/**
 * Per-panel nav metadata. `Record<SettingsTabName, …>` makes an appended tab a
 * compile error until it has a label and icon.
 */
const SETTINGS_TAB_METADATA: Record<
  SettingsTabName,
  {
    readonly icon: TeXRAIconName;
    readonly label: string;
    readonly description: string;
  }
> = {
  MEMORY: {
    icon: 'database',
    label: 'Memory',
    description: 'Control and inspect the notes TeXRA keeps across tasks.',
  },
  HISTORY: {
    icon: 'clock-rotate-left',
    label: 'History',
    description: 'Search, revisit, and manage previous TeXRA activity.',
  },
  MODELS: {
    icon: 'server',
    label: 'Providers & Models',
    description: 'Choose model access, credentials, defaults, and reliability.',
  },
  AGENTS: {
    icon: 'robot',
    label: 'Agents',
    description:
      'Configure the workflow and tool-use agents available to tasks.',
  },
  MULTI_AGENT: {
    icon: 'users',
    label: 'Teams',
    description:
      'Build coordinated agent teams and choose orchestration behavior.',
  },
  TOOLS: {
    icon: 'screwdriver-wrench',
    label: 'Tools',
    description:
      'Review tool availability, permissions, and desktop diagnostics.',
  },
  // Not 'robot': that is AGENTS, and once the nav collapses to icons two tabs
  // sharing a glyph are indistinguishable. External agents are the CLI ones.
  AI_AGENTS: {
    icon: 'terminal',
    label: 'External Agents',
    description: 'Connect external agents, services, and reference tools.',
  },
  GIT: {
    icon: 'code-branch',
    label: 'Git',
    description: 'Configure agent commit identity and GitHub activity access.',
  },
  LATEX: {
    icon: 'file-code',
    label: 'LaTeX',
    description:
      'Check dependencies and tune compile, diff, and formatting behavior.',
  },
  GOAL: {
    icon: 'compass',
    label: 'Goals',
    description: 'Monitor autonomous goals and return to their active tasks.',
  },
  ACCOUNT: {
    icon: 'circle-user',
    label: 'Account & Usage',
    description: 'Manage sign-in, included access, and current model usage.',
  },
  SHORTCUTS: {
    icon: 'code',
    label: 'Shortcuts',
    description: 'Customize desktop commands and resolve key conflicts.',
  },
};

const SETTINGS_GROUP_ICONS: Record<
  (typeof SETTINGS_TAB_GROUPS)[number]['label'],
  TeXRAIconName
> = {
  'Account & Access': 'circle-user',
  Agents: 'robot',
  Capabilities: 'screwdriver-wrench',
  Workspace: 'folder',
  'Data & Activity': 'clock-rotate-left',
};

/** Grouped navigation tabs in display order, resolved to panel names. */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] =
  SETTINGS_TAB_GROUPS.map((group) => ({
    label: group.label,
    icon: SETTINGS_GROUP_ICONS[group.label],
    entries: group.tabs.map((name) => ({
      name,
      panel: SETTINGS_TAB_PANEL_BY_NAME[name],
      ...SETTINGS_TAB_METADATA[name],
    })),
  }));
