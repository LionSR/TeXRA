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
  it('renders every navigation tab exactly once', () => {
    const names = navEntries.map((entry) => entry.name);

    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...SETTINGS_TAB_ORDER].sort());
  });

  // This is the index-compatibility check the nav rests on: a tab carries only
  // a panel name, and `SettingsApp.handleTabShow` turns that name back into the
  // wire index with `SETTINGS_TAB_PANEL_NAMES.indexOf(...)`. If a tab's panel
  // name ever resolved to a different index than `SETTINGS_TAB` assigns, the
  // navigation would silently open the wrong panel while every hardcoded index
  // table still matched.
  it('resolves each navigation tab to its own panel index', () => {
    for (const entry of navEntries) {
      expect(SETTINGS_TAB_PANEL_NAMES.indexOf(entry.panel)).toBe(
        SETTINGS_TAB[entry.name],
      );
    }
  });

  it('labels every tab and group heading', () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      expect(group.label.trim()).not.toBe('');
      expect(group.entries.length).toBeGreaterThan(0);
      for (const entry of group.entries) {
        expect(entry.label.trim()).not.toBe('');
        expect(entry.icon.trim()).not.toBe('');
        expect(entry.description.trim()).not.toBe('');
      }
    }
  });

  it('keeps category icons distinct from page icons', () => {
    const categoryIcons = SETTINGS_NAV_GROUPS.map((group) => group.icon);

    expect(new Set(categoryIcons).size).toBe(categoryIcons.length);
    for (const group of SETTINGS_NAV_GROUPS) {
      expect(group.entries.map((entry) => entry.icon)).not.toContain(
        group.icon,
      );
    }
  });
});
