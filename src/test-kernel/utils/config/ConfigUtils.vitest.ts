// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports
import { installPlatform } from '@test/support/setupPlatform';
import * as logger from '@logger/logUtils';
import { getValidatedConfig } from '@utils/config/configUtils';

afterEach(() => {
  vi.restoreAllMocks();
});

const APPROACH_SCHEMA = z.enum(['quick', 'thorough']);
const SETTING_PATH = 'agentReview.approach';

describe('getValidatedConfig', () => {
  it('returns the stored value when it matches the schema', async () => {
    await installPlatform({ config: { [SETTING_PATH]: 'thorough' } });

    expect(getValidatedConfig(SETTING_PATH, APPROACH_SCHEMA, 'quick')).toBe(
      'thorough',
    );
  });

  it('falls back to the default without warning when the setting is unset', async () => {
    await installPlatform({});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(getValidatedConfig(SETTING_PATH, APPROACH_SCHEMA, 'quick')).toBe(
      'quick',
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns and falls back to the default instead of silently dropping an invalid user setting', async () => {
    // Reproduces #7470: a stale/hand-edited settings.json value that no
    // longer fits the schema must not vanish without a trace via
    // `schema.catch(default)` — it's surfaced as a warning before defaulting.
    await installPlatform({
      config: { [SETTING_PATH]: 'not-a-real-approach' },
    });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(getValidatedConfig(SETTING_PATH, APPROACH_SCHEMA, 'quick')).toBe(
      'quick',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'configUtils',
      expect.stringContaining(SETTING_PATH),
    );
  });
});
