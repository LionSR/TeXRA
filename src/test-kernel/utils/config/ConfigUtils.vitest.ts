// Suites for src/utils/config (configUtils + platformSettings).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installPlatform } from '@test/support/setupPlatform';
import * as logger from '@logger/logUtils';
import { getValidatedConfig } from '@utils/config/configUtils';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latex';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { readPlatformSetting } from '@utils/config/platformSettings';

// ---------------------------------------------------------------------------
// ConfigUtils
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// PlatformSettings
// ---------------------------------------------------------------------------

function initWith(options: {
  workspaceState?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
}): Promise<void> {
  return installPlatform(options);
}

describe('readPlatformSetting', () => {
  it('resolves the default from the catalog schema when the key is unset', async () => {
    await initWith({});
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
    // A globalState-slot key resolves the same way.
    expect(readPlatformSetting(GlobalStateKey.WEBSOCKET_OPENAI)).toBe(false);
  });

  it('returns the stored value when present and valid', async () => {
    await initWith({
      workspaceState: { [WorkspaceStateKey.LATEX_FORMATTER]: 'tex-fmt' },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'tex-fmt',
    );
  });

  it('snaps a stored value that fails the schema back to the catalog default', async () => {
    await initWith({
      workspaceState: {
        [WorkspaceStateKey.LATEX_FORMATTER]: 'not-a-formatter',
      },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
  });

  it('throws for a key with no catalog entry', async () => {
    await initWith({});
    expect(() => readPlatformSetting('texra.not.a.catalog.key')).toThrow(
      /no state-setting catalog entry/i,
    );
  });
});
