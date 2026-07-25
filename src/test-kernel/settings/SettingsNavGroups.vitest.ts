// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - nav presentation layer + tab wire format
import { SETTINGS_NAV_GROUPS } from '@settingsView/frontend/settingsNav';
import {
  SETTINGS_TAB,
  SETTINGS_TAB_ORDER,
  SETTINGS_TAB_PANEL_NAMES,
} from '@shared/schemas';

const navEntries = SETTINGS_NAV_GROUPS.flatMap((group) => group.entries);

describe('settings nav groups', () => {
  it('renders a row for every tab exactly once', () => {
    const names = navEntries.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...SETTINGS_TAB_ORDER].sort());
  });

  // This is the index-compatibility check the nav rests on: a row carries only
  // a panel name, and `SettingsApp.handleTabShow` turns that name back into the
  // wire index with `SETTINGS_TAB_PANEL_NAMES.indexOf(...)`. If a row's panel
  // name ever resolved to a different index than `SETTINGS_TAB` assigns, the
  // nav would silently open the wrong panel while every hardcoded index table
  // still matched.
  it('resolves each nav row to its own panel index', () => {
    for (const entry of navEntries) {
      expect(SETTINGS_TAB_PANEL_NAMES.indexOf(entry.panel)).toBe(
        SETTINGS_TAB[entry.name],
      );
    }
  });

  it('labels every row and group heading', () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      expect(group.label.trim()).not.toBe('');
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.label.trim()).not.toBe('');
        expect(entry.icon.trim()).not.toBe('');
      }
    }
  });
});
