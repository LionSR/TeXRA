// Suites for src/utils/config (configUtils + platformSettings + providerConfig).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as logger from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import { platform } from '@platform/platform';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { getConfig, getValidatedConfig } from '@utils/config/configUtils';
import {
  getProviderEndpoint,
  getProviderKeyUrl,
  getUseOpenRouter,
} from '@utils/config/providerConfig';
import { readPlatformSetting } from '@utils/config/platformSettings';

// ---------------------------------------------------------------------------
// ConfigUtils
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

const APPROACH_SCHEMA = z.enum(['quick', 'thorough']);
const SETTING_PATH = 'agentReview.approach';

function readApproach(): 'quick' | 'thorough' {
  return getValidatedConfig(SETTING_PATH, APPROACH_SCHEMA, 'quick');
}

describe('getConfig', () => {
  it('resolves catalog defaults for caller-supplied config providers', async () => {
    const callerDefaultConfig: ConfigProvider = {
      get<T>(_key: string, defaultValue?: T): T {
        return defaultValue as T;
      },
      async update<T>(_key: string, _value: T): Promise<void> {},
      inspect: () => undefined,
      isExplicitlySet: () => false,
    };
    await installPlatform({}, { config: callerDefaultConfig });

    expect(
      getConfig<boolean>('texra.model.useGoogleInteractionsServerState'),
    ).toBe(true);
    expect(getConfig('not.a.catalog.key', 'fallback')).toBe('fallback');
  });
});

describe('getValidatedConfig', () => {
  it('returns the stored value when it matches the schema', async () => {
    await installPlatform({ config: { [SETTING_PATH]: 'thorough' } });

    expect(readApproach()).toBe('thorough');
  });

  it('falls back to the default without warning when the setting is unset', async () => {
    await installPlatform({});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    expect(readApproach()).toBe('quick');
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

    expect(readApproach()).toBe('quick');
    expect(warnSpy).toHaveBeenCalledWith(
      'configUtils',
      expect.stringContaining(SETTING_PATH),
    );
  });
});

// ---------------------------------------------------------------------------
// PlatformSettings
// ---------------------------------------------------------------------------

describe('readPlatformSetting', () => {
  it('resolves the default from the catalog schema when the key is unset', async () => {
    await installPlatform({});
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
    // A globalState-slot key resolves the same way.
    expect(readPlatformSetting(GlobalStateKey.WEBSOCKET_OPENAI)).toBe(false);
  });

  it('snaps a stored value that fails the schema back to the catalog default', async () => {
    await installPlatform({
      workspaceState: {
        [WorkspaceStateKey.LATEX_FORMATTER]: 'not-a-formatter',
      },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      LATEX_CONFIG_DEFAULTS.latexFormatter,
    );
  });

  it('throws for a key with no catalog entry', async () => {
    await installPlatform({});
    expect(() => readPlatformSetting('texra.not.a.catalog.key')).toThrow(
      /no setting catalog entry/i,
    );
  });
});

// ---------------------------------------------------------------------------
// ProviderConfig (#7873 — converge on readPlatformSetting for catalog keys)
// ---------------------------------------------------------------------------

describe('getProviderEndpoint', () => {
  it('returns the stored globalState value', async () => {
    await installPlatform({
      globalState: {
        [GlobalStateKey.ENDPOINT_OPENAI]: 'https://example.test/v1',
      },
    });
    expect(getProviderEndpoint('openai')).toBe('https://example.test/v1');
  });

  it('snaps an invalid stored value back to the catalog default instead of leaking it through', async () => {
    // Regression for #7873: the pre-fix local `read()` helper cast the raw
    // stored value to `string` without validating it, so a corrupted
    // non-string value flowed straight through. `readPlatformSetting()`
    // validates against the entry's schema first.
    await installPlatform({
      globalState: { [GlobalStateKey.ENDPOINT_OPENAI]: 42 },
    });
    expect(getProviderEndpoint('openai')).toBe('');
  });
});
