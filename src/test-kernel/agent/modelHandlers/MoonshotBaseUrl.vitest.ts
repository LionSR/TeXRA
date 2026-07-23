// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { resolveBaseUrl } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';

function moonshotConfig(
  overrides: { customBaseUrl?: string } = {},
): Parameters<typeof resolveBaseUrl>[0] {
  if (overrides.customBaseUrl) {
    return { route: 'custom', url: overrides.customBaseUrl };
  }
  return {
    route: 'direct',
    provider: ModelProvider.MOONSHOT,
    useOpenRouter: false,
  };
}

describe('Moonshot base URL region resolution', () => {
  beforeEach(async () => {
    await installPlatform();
  });

  it('defaults to the China endpoint', () => {
    expect(resolveBaseUrl(moonshotConfig())).toBe('https://api.moonshot.cn/v1');
  });

  it('uses the international endpoint when the China toggle is off', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(resolveBaseUrl(moonshotConfig())).toBe('https://api.moonshot.ai/v1');
  });

  it('lets a pinned custom base URL beat the region switch (Kimi Code)', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(
      resolveBaseUrl(
        moonshotConfig({ customBaseUrl: 'https://api.kimi.com/coding/v1' }),
      ),
    ).toBe('https://api.kimi.com/coding/v1');
  });
});
