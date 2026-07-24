// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports - shared schemas
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

type ModelsTabElement = HTMLElement & {
  providerKeyStatuses: ProviderKeyStatus[];
  updateComplete: Promise<boolean>;
};

type ApiAccessSectionElement = HTMLElement & {
  personalApiKeySet: boolean;
};

describe('model access credential classification', () => {
  useLitComponentTestDom(() => import('@settingsView/frontend/tabs/ModelsTab'));

  it('keeps a Kimi Code membership key separate from personal API keys', async () => {
    const tab = document.createElement('models-tab') as ModelsTabElement;
    tab.providerKeyStatuses = [
      {
        provider: 'kimiCode',
        displayName: 'Kimi Code',
        status: 'set',
        keyUrl: 'https://www.kimi.com/code/console',
        streaming: true,
        customEndpoint: '',
        supportsCustomEndpoint: false,
        vscodeSettings: [],
      },
    ];
    document.body.append(tab);
    await tab.updateComplete;

    const accessSection =
      tab.shadowRoot?.querySelector<ApiAccessSectionElement>(
        'api-access-section',
      );
    expect(accessSection?.personalApiKeySet).toBe(false);

    tab.providerKeyStatuses = [
      ...tab.providerKeyStatuses,
      {
        provider: 'openai',
        displayName: 'OpenAI',
        status: 'env',
        keyUrl: 'https://platform.openai.com/api-keys',
        streaming: true,
        customEndpoint: '',
        supportsCustomEndpoint: true,
        vscodeSettings: [],
      },
    ];
    await tab.updateComplete;

    expect(accessSection?.personalApiKeySet).toBe(true);
  });
});
