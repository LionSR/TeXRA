// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { resolveBaseUrl } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';

const MOONSHOT_ROUTE: Parameters<typeof resolveBaseUrl>[0] = {
  route: 'direct',
  provider: ModelProvider.MOONSHOT,
  useOpenRouter: false,
};

describe('Moonshot base URL region resolution', () => {
  it('defaults to the China endpoint', async () => {
    await installPlatform();
    expect(resolveBaseUrl(MOONSHOT_ROUTE)).toBe('https://api.moonshot.cn/v1');
  });

  it('uses the international endpoint when the China toggle is off', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(resolveBaseUrl(MOONSHOT_ROUTE)).toBe('https://api.moonshot.ai/v1');
  });

  it('lets a pinned custom base URL beat the region switch (Kimi Code)', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(
      resolveBaseUrl({
        route: 'custom',
        url: 'https://api.kimi.com/coding/v1',
      }),
    ).toBe('https://api.kimi.com/coding/v1');
  });
});
