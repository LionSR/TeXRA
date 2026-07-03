import { describe, expect, it } from 'vitest';

import {
  SETTINGS_TAB,
  SETTINGS_TAB_ORDER,
  SETTINGS_TAB_PANEL_BY_NAME,
  SETTINGS_TAB_PANEL_NAMES,
  toSettingsTabPanelName,
} from '@shared/schemas';

describe('settings view tab definitions', () => {
  it('derives tab indices and panel names from the ordered tab list', () => {
    expect(SETTINGS_TAB).toEqual(
      Object.fromEntries(
        SETTINGS_TAB_ORDER.map((name, index) => [name, index]),
      ),
    );

    expect(SETTINGS_TAB_PANEL_NAMES).toEqual(
      SETTINGS_TAB_ORDER.map(toSettingsTabPanelName),
    );

    expect(SETTINGS_TAB_PANEL_BY_NAME).toEqual(
      Object.fromEntries(
        SETTINGS_TAB_ORDER.map((name) => [name, toSettingsTabPanelName(name)]),
      ),
    );
  });

  it('keeps panel names unique', () => {
    expect(new Set(SETTINGS_TAB_PANEL_NAMES).size).toBe(
      SETTINGS_TAB_PANEL_NAMES.length,
    );
  });
});
