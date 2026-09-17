// Suites for src/utils/config (configUtils + platformSettings + providerConfig).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@platform/platform';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
import { getConfig } from '@utils/config/configUtils';
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

describe('getConfig', () => {
  it('reads a cataloged key through the provider and falls back only off-catalog', async () => {
    // The catalog default is the provider's own resolution step
    // (`ConfigProvider.get`); `defaultValue` is for keys the catalog does not
    // own, which is the only thing this reader still contributes.
    await installPlatform({});

    expect(
      getConfig<boolean>('texra.model.useGoogleInteractionsServerState'),
    ).toBe(true);
    expect(getConfig('not.a.catalog.key', 'fallback')).toBe('fallback');
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
