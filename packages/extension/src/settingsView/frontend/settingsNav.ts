/**
 * Settings navigation: grouped pages in the desktop sidebar, a page strip
 * in the extension, and section tabs beside the current page's content.
 * Pages and sections retain their IPC addresses (`page` or `page/section`).
 */

import type { TeXRAIconName } from '@shared/iconNames';
import {
  SETTINGS_PAGE_SECTIONS,
  SETTINGS_TAB_ORDER,
  type SettingsSectionName,
  type SettingsTabPanelName,
} from '@texra/shared/settingsView/settingsViewMessages';
import { PLUGINS_PAGE } from '@ui/copy/plugins';

interface SettingsSectionEntry {
  readonly section: SettingsSectionName;
  readonly label: string;
}

export interface SettingsNavEntry {
  /** Panel name — the addressing key the nav and e2e selectors share. */
  readonly panel: SettingsTabPanelName;
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly group: 'Preferences' | 'AI' | 'Tools';
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
    group: 'AI',
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
    group: 'AI',
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
  plugins: {
    group: 'Tools',
    icon: 'cube',
    label: 'Plugins',
    description: PLUGINS_PAGE.description,
    sections: {},
  },
  latex: {
    group: 'Tools',
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
    group: 'AI',
    icon: 'database',
    label: 'Memory',
    description: 'Control and inspect the notes TeXRA keeps across tasks.',
    sections: {},
  },
  general: {
    group: 'Preferences',
    icon: 'gear',
    label: 'General',
    description: 'Application behavior, privacy, and Git preferences.',
    sections: {
      appearance: 'Appearance',
      approval: 'Approval',
      privacy: 'Privacy',
      git: 'Git',
    },
  },
  shortcuts: {
    group: 'Preferences',
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
