/**
 * Settings navigation presentation layer: one strip of pages and, for a page
 * with two or more sections, a second strip of section sub-tabs. Pages and
 * sections are addressed by name — the names that travel over IPC as
 * `SET_TAB.tab` (`page` or `page/section`).
 */

import {
  SETTINGS_PAGE_SECTIONS,
  SETTINGS_TAB_ORDER,
  type SettingsSectionName,
  type SettingsTabPanelName,
} from '@shared/settingsView/settingsViewMessages';
import type { TeXRAIconName } from '@ui/wa/iconNames';

interface SettingsSectionEntry {
  readonly section: SettingsSectionName;
  readonly label: string;
}

export interface SettingsNavEntry {
  /** Panel name — the addressing key the nav and e2e selectors share. */
  readonly panel: SettingsTabPanelName;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly description: string;
  /** Sub-tabs in display order; empty for a single-section page. */
  readonly sections: readonly SettingsSectionEntry[];
}

/**
 * Per-panel nav metadata. The mapped type makes an appended tab, or an
 * appended section, a compile error until it has a label.
 */
const SETTINGS_TAB_METADATA: {
  [P in SettingsTabPanelName]: Omit<SettingsNavEntry, 'panel' | 'sections'> & {
    readonly sections: Readonly<Record<SettingsSectionName<P>, string>>;
  };
} = {
  models: {
    icon: 'server',
    label: 'Models',
    description:
      'Connect a subscription or API key, then choose which models appear.',
    sections: {
      keys: 'API keys',
      subscriptions: 'Subscriptions',
      models: 'Models',
    },
  },
  agents: {
    icon: 'robot',
    label: 'Agents',
    description: 'Choose the agents, teams, and skills your tasks can use.',
    sections: {
      library: 'Library',
      teams: 'Teams',
      skills: 'Skills',
      advanced: 'Advanced',
    },
  },
  tools: {
    icon: 'screwdriver-wrench',
    label: 'Tools',
    description:
      'Decide when agents ask first, and check the tools and integrations they use.',
    sections: {
      approval: 'Approval',
      tools: 'Tools',
      integrations: 'Integrations',
    },
  },
  latex: {
    icon: 'file-code',
    label: 'LaTeX',
    description:
      'Check dependencies and tune compile, diff, and formatting behavior.',
    sections: {
      dependencies: 'Dependencies',
      compile: 'Compile & diff',
      formatting: 'Formatting',
      vscode: 'VS Code settings',
    },
  },
  memory: {
    icon: 'database',
    label: 'Memory',
    description: 'Control and inspect the notes TeXRA keeps across tasks.',
    sections: {},
  },
  general: {
    icon: 'gear',
    label: 'General',
    description: 'TeXRA account, privacy, and Git commit attribution.',
    sections: { account: 'Account', git: 'Git' },
  },
  shortcuts: {
    icon: 'code',
    label: 'Shortcuts',
    description: 'Customize desktop commands and resolve key conflicts.',
    sections: {},
  },
};

/** Navigation pages in display order, each with its sub-tabs in order. */
export const SETTINGS_NAV_ENTRIES: readonly SettingsNavEntry[] =
  SETTINGS_TAB_ORDER.map((panel) => {
    const { sections, ...meta } = SETTINGS_TAB_METADATA[panel];
    const labels: Readonly<Record<string, string>> = sections;
    return {
      panel,
      ...meta,
      sections: SETTINGS_PAGE_SECTIONS[panel].map((section) => ({
        section,
        label: labels[section],
      })),
    };
  });
