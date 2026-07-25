/**
 * Settings left-nav presentation layer.
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

interface SettingsNavEntry {
  readonly name: SettingsTabName;
  /** `wa-tab-panel` name — the addressing key the nav and e2e selectors share. */
  readonly panel: string;
  readonly icon: TeXRAIconName;
  readonly label: string;
}

export interface SettingsNavGroup {
  readonly label: string;
  readonly entries: readonly SettingsNavEntry[];
}

/**
 * Per-panel nav metadata. `Record<SettingsTabName, …>` makes an appended tab a
 * compile error until it has a label and icon.
 */
const SETTINGS_TAB_METADATA: Record<
  SettingsTabName,
  { readonly icon: TeXRAIconName; readonly label: string }
> = {
  MEMORY: { icon: 'database', label: 'Memory' },
  HISTORY: { icon: 'clock-rotate-left', label: 'History' },
  MODELS: { icon: 'server', label: 'Providers & Models' },
  AGENTS: { icon: 'robot', label: 'Agents' },
  MULTI_AGENT: { icon: 'users', label: 'Teams' },
  TOOLS: { icon: 'screwdriver-wrench', label: 'Tools' },
  // Not 'robot': that is AGENTS, and once the nav collapses to icons two rows
  // sharing a glyph are indistinguishable. External agents are the CLI ones.
  AI_AGENTS: { icon: 'terminal', label: 'External Agents' },
  GIT: { icon: 'code-branch', label: 'Git' },
  LATEX: { icon: 'file-code', label: 'LaTeX' },
  GOAL: { icon: 'compass', label: 'Goals' },
};

/** Grouped nav rows in display order, resolved to panel names. */
export const SETTINGS_NAV_GROUPS: readonly SettingsNavGroup[] =
  SETTINGS_TAB_GROUPS.map((group) => ({
    label: group.label,
    entries: group.tabs.map((name) => ({
      name,
      panel: SETTINGS_TAB_PANEL_BY_NAME[name],
      ...SETTINGS_TAB_METADATA[name],
    })),
  }));
