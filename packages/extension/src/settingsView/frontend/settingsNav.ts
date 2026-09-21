/**
 * Settings top-navigation presentation layer: nav grouping, nav order, labels,
 * and icons. Panels are addressed by name — the same panel name that travels
 * over IPC as `SET_TAB.tab`.
 */

import {
  SETTINGS_TAB_GROUPS,
  type SettingsTabPanelName,
} from '@shared/settingsView/settingsViewMessages';
import type { TeXRAIconName } from '@ui/wa/iconNames';

export interface SettingsNavEntry {
  /** `wa-tab-panel` name — the addressing key the nav and e2e selectors share. */
  readonly panel: SettingsTabPanelName;
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
 * Per-panel nav metadata. `Record<SettingsTabPanelName, …>` makes an appended
 * tab a compile error until it has a label and icon.
 */
const SETTINGS_TAB_METADATA: Record<
  SettingsTabPanelName,
  {
    readonly icon: TeXRAIconName;
    readonly label: string;
    readonly description: string;
  }
> = {
  memory: {
    icon: 'database',
    label: 'Memory',
    description: 'Control and inspect the notes TeXRA keeps across tasks.',
  },
  models: {
    icon: 'server',
    label: 'Providers & Models',
    description: 'Choose model access, credentials, and defaults.',
  },
  agents: {
    icon: 'robot',
    label: 'Agents',
    description:
      'Configure the agents and agent sets available to tasks, plus session reliability.',
  },
  'multi-agent': {
    icon: 'users',
    label: 'Teams',
    description:
      'Build coordinated agent teams and choose orchestration behavior.',
  },
  tools: {
    icon: 'screwdriver-wrench',
    label: 'Tools',
    description:
      'Review tool availability, permissions, and desktop diagnostics.',
  },
  skills: {
    icon: 'wand-magic-sparkles',
    label: 'Skills',
    description: 'Choose which reusable instructions agents can load.',
  },
  'ai-agents': {
    icon: 'link',
    label: 'Integrations',
    description:
      'Connect coding agents, services, reference managers, and other tools.',
  },
  git: {
    icon: 'code-branch',
    label: 'Git',
    description: 'Configure agent commit identity and GitHub activity access.',
  },
  latex: {
    icon: 'file-code',
    label: 'LaTeX',
    description:
      'Check dependencies and tune compile, diff, and formatting behavior.',
  },
  goal: {
    icon: 'compass',
    label: 'Goals',
    description: 'Monitor autonomous goals and return to their active tasks.',
  },
  account: {
    icon: 'circle-user',
    label: 'Account & Usage',
    description: 'Manage sign-in and current model usage.',
  },
  subscriptions: {
    icon: 'gem',
    label: 'Subscriptions',
    description: 'Manage ChatGPT, Kimi Code, and Copilot model access.',
  },
  shortcuts: {
    icon: 'code',
    label: 'Shortcuts',
    description: 'Customize desktop commands and resolve key conflicts.',
  },
};

const SETTINGS_GROUP_ICONS: Record<
  (typeof SETTINGS_TAB_GROUPS)[number]['label'],
  TeXRAIconName
> = {
  Account: 'key',
  Models: 'brain',
  Agents: 'diagram-project',
  Capabilities: 'bolt',
  Workspace: 'folder-tree',
  'Data & Activity': 'chart-line',
};

/** Grouped navigation tabs in display order, resolved to panel names. */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] =
  SETTINGS_TAB_GROUPS.map((group) => ({
    label: group.label,
    icon: SETTINGS_GROUP_ICONS[group.label],
    entries: group.tabs.map((panel) => ({
      panel,
      ...SETTINGS_TAB_METADATA[panel],
    })),
  }));
