// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { resolveProxyEndpoint } from '@agent/modelHandlers/support/ProxyConfigResolver';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';

const MOONSHOT_ROUTE: Parameters<typeof resolveProxyEndpoint>[0] = {
  route: 'direct',
  provider: ModelProvider.MOONSHOT,
  useOpenRouter: false,
};

describe('Moonshot base URL region resolution', () => {
  it('defaults to the China endpoint', async () => {
    await installPlatform();
    expect(resolveProxyEndpoint(MOONSHOT_ROUTE).baseUrl).toBe(
      'https://api.moonshot.cn/v1',
    );
  });

  it('uses the international endpoint when the China toggle is off', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(resolveProxyEndpoint(MOONSHOT_ROUTE).baseUrl).toBe(
      'https://api.moonshot.ai/v1',
    );
  });

  it('lets a pinned custom base URL beat the region switch (Kimi Code)', async () => {
    await installPlatform({
      globalState: { [GlobalStateKey.MOONSHOT_USE_CHINA]: false },
    });
    expect(
      resolveProxyEndpoint({
        route: 'custom',
        provider: ModelProvider.MOONSHOT,
        url: 'https://api.kimi.com/coding/v1',
      }).baseUrl,
    ).toBe('https://api.kimi.com/coding/v1');
  });
});
