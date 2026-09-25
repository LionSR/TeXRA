/**
 * Settings navigation presentation layer: one flat strip of pages, with their
 * labels and icons. Panels are addressed by name — the same panel name that
 * travels over IPC as `SET_TAB.tab`.
 */

import {
  SETTINGS_TAB_ORDER,
  type SettingsTabPanelName,
} from '@shared/settingsView/settingsViewMessages';
import type { TeXRAIconName } from '@ui/wa/iconNames';

export interface SettingsNavEntry {
  /** Panel name — the addressing key the nav and e2e selectors share. */
  readonly panel: SettingsTabPanelName;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly description: string;
}

/**
 * Per-panel nav metadata. `Record<SettingsTabPanelName, …>` makes an appended
 * tab a compile error until it has a label and icon.
 */
const SETTINGS_TAB_METADATA: Record<
  SettingsTabPanelName,
  Omit<SettingsNavEntry, 'panel'>
> = {
  models: {
    icon: 'server',
    label: 'Models',
    description:
      'Connect a subscription or API key, then choose which models appear.',
  },
  agents: {
    icon: 'robot',
    label: 'Agents',
    description: 'Choose the agents, teams, and skills your tasks can use.',
  },
  tools: {
    icon: 'screwdriver-wrench',
    label: 'Tools',
    description:
      'Decide when agents ask first, and check the tools and integrations they use.',
  },
  latex: {
    icon: 'file-code',
    label: 'LaTeX',
    description:
      'Check dependencies and tune compile, diff, and formatting behavior.',
  },
  memory: {
    icon: 'database',
    label: 'Memory',
    description: 'Control and inspect the notes TeXRA keeps across tasks.',
  },
  general: {
    icon: 'gear',
    label: 'General',
    description: 'TeXRA account, privacy, and Git commit attribution.',
  },
  shortcuts: {
    icon: 'code',
    label: 'Shortcuts',
    description: 'Customize desktop commands and resolve key conflicts.',
  },
};

/** Navigation pages in display order. */
export const SETTINGS_NAV_ENTRIES: readonly SettingsNavEntry[] =
  SETTINGS_TAB_ORDER.map((panel) => ({
    panel,
    ...SETTINGS_TAB_METADATA[panel],
  }));
