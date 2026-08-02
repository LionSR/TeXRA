import { describe, expect, it } from 'vitest';

import { resolveProviderKeyRows } from '@settingsView/frontend/components/profile/providerKeyRows';
import {
  API_KEY_PROVIDER_IDS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
  SERVER_SIDE_PROVIDER_IDS,
} from '@shared/constants/providers';
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';

describe('settings provider key rows', () => {
  it('keeps every API-key provider covered by display labels and key URLs', () => {
    for (const provider of API_KEY_PROVIDER_IDS) {
      expect(PROVIDER_DISPLAY_NAMES[provider]).toEqual(expect.any(String));
      expect(PROVIDER_URLS[provider]).toEqual(expect.stringMatching(/^https:/));
    }
  });

  it('keeps server-side provider keys available in the direct-key defaults', () => {
    const apiKeyProviders = new Set<string>(API_KEY_PROVIDER_IDS);

    for (const provider of SERVER_SIDE_PROVIDER_IDS) {
      expect(apiKeyProviders.has(provider)).toBe(true);
    }
  });

  it('provides API-key rows before profile state has loaded', () => {
    const rows = resolveProviderKeyRows([]);

    expect(rows.map((row) => row.provider)).toEqual([...API_KEY_PROVIDER_IDS]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'deepseek',
          displayName: 'DeepSeek',
          status: 'not-set',
          keyUrl: 'https://platform.deepseek.com/api_keys',
        }),
        expect.objectContaining({
          provider: 'openRouter',
          displayName: 'OpenRouter',
          status: 'not-set',
          keyUrl: 'https://openrouter.ai/keys',
        }),
      ]),
    );
  });

  it('uses host-reported status rows once they arrive', () => {
    const loadedRows: ProviderKeyStatus[] = [
      {
        provider: 'google',
        displayName: 'Google',
        status: 'env',
        keyUrl: 'https://aistudio.google.com/app/apikey',
        streaming: false,
        customEndpoint: 'https://example.invalid',
        supportsCustomEndpoint: true,
        providerSettings: [],
      },
    ];

    expect(resolveProviderKeyRows(loadedRows)).toBe(loadedRows);
  });
});
