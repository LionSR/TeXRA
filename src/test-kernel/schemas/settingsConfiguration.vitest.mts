import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXRA_SETTINGS,
  flattenTexraSettings,
  TEXRA_SETTING_PATHS,
  TexraSettingsSchema,
} from '@shared/schemas/settingsConfiguration';

describe('TexraSettingsSchema (composed from Core + VS Code extension)', () => {
  it('parses an empty object to the full default tree', () => {
    const parsed = TexraSettingsSchema.parse({});

    expect(parsed.model.compactionThresholdPercent).toBe(75);
    expect(parsed.toolUse.persistence.ttlHours).toBe(336);
    expect(parsed.auth.enableVSCodeGitHub).toBe(false);
    expect(parsed.apiKeys.set).toBeNull();
    expect(parsed.apiKeys.remove).toBeNull();
    expect(parsed.files.included.editedExtensions).toEqual(['.txt', '.tex']);
  });

  it('exposes every TEXRA_SETTING_PATH on the parsed tree', () => {
    const parsed = TexraSettingsSchema.parse({});
    for (const path of TEXRA_SETTING_PATHS) {
      let value: unknown = parsed;
      for (const segment of path.split('.')) {
        value = (value as Record<string, unknown>)[segment];
      }
      expect(value, `path ${path} should resolve on parsed defaults`).not.toBe(
        undefined,
      );
    }
  });

  it('flattens the defaults to one entry per setting path', () => {
    const flat = flattenTexraSettings();
    expect(Object.keys(flat)).toHaveLength(TEXRA_SETTING_PATHS.length);
    expect(flat['texra.auth.enableVSCodeGitHub']).toBe(false);
    expect(flat['texra.apiKeys.set']).toBeNull();
    expect(flat['texra.model.retry.backoffMs']).toBe(1000);
  });

  it('keeps DEFAULT_TEXRA_SETTINGS structurally equal to the parsed defaults', () => {
    const parsed = TexraSettingsSchema.parse({});
    expect(parsed).toEqual(DEFAULT_TEXRA_SETTINGS);
  });
});
