// Suites for src/utils/config (configUtils + platformSettings + providerConfig).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { getValidatedConfig } from '@utils/config/configUtils';
import {
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
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

  it('returns the stored value when present and valid', async () => {
    await installPlatform({
      workspaceState: { [WorkspaceStateKey.LATEX_FORMATTER]: 'tex-fmt' },
    });
    expect(readPlatformSetting(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'tex-fmt',
    );
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
      /no state-setting catalog entry/i,
    );
  });
});

// ---------------------------------------------------------------------------
// ProviderConfig (#7873 — converge on readPlatformSetting for catalog keys)
// ---------------------------------------------------------------------------

describe('getUseOpenRouter', () => {
  it('resolves the catalog default (false) when unset', async () => {
    await installPlatform({});
    expect(getUseOpenRouter()).toBe(false);
  });

  it('returns the stored globalState value', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.USE_OPENROUTER]: true },
    });
    expect(getUseOpenRouter()).toBe(true);
  });

  it('snaps an invalid stored value back to the catalog default instead of leaking it through', async () => {
    // Regression for #7873: the pre-fix `tryGlobalState()?.get(key, false)`
    // read cast the raw stored value to `boolean` without validating it, so a
    // corrupted/non-boolean value flowed straight through. The catalog-driven
    // `readPlatformSetting()` runs the entry's schema (`.catch(default)`)
    // first, so a value that fails validation resolves to the default.
    await installPlatform({
      globalState: { [GlobalStateKey.USE_OPENROUTER]: 'not-a-boolean' },
    });
    expect(getUseOpenRouter()).toBe(false);
  });

  it('never falls back to the legacy VS Code config key', async () => {
    // The `?? getConfig('texra.model.useOpenRouter', false)` fallback this
    // function used to carry was dead code: `StateStore.get(key, false)`
    // always resolves to `false` once the platform is initialized, so the
    // config fallback could never fire in practice. Prove a legacy config
    // value is ignored now that the fallback is gone.
    await installPlatform({
      config: { 'texra.model.useOpenRouter': true },
    });
    expect(getUseOpenRouter()).toBe(false);
  });
});

describe('getProviderEndpoint', () => {
  it('resolves the catalog default (empty string) when unset', async () => {
    await installPlatform({});
    expect(getProviderEndpoint('openai')).toBe('');
  });

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

  it('returns empty string for a provider with no endpoint key', () => {
    expect(getProviderEndpoint('not-a-real-provider')).toBe('');
  });
});

describe('OpenRouter streaming', () => {
  it('uses the same setting for API-key and model-dispatch spellings', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.STREAMING_OPENROUTER]: false },
    });

    expect(getProviderStreaming('openRouter')).toBe(false);
    await platform().globalState.update(
      GlobalStateKey.STREAMING_OPENROUTER,
      true,
    );
    expect(getProviderStreaming('openrouter')).toBe(true);
  });
});

describe('getProviderKeyUrl', () => {
  it('owns the provider default and applies the configured region', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });

    expect(getProviderKeyUrl('moonshot')).toBe(
      'https://platform.moonshot.ai/console',
    );
  });

  it('returns the registry default when the default region is active', async () => {
    await installPlatform({});

    expect(getProviderKeyUrl('moonshot')).toBe(
      'https://platform.moonshot.cn/console',
    );
    expect(getProviderKeyUrl('openai')).toBe(
      'https://platform.openai.com/api-keys',
    );
    expect(getProviderKeyUrl('not-a-provider')).toBeUndefined();
  });
});
