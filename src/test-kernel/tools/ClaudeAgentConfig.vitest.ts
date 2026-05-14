// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - model
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';

let secretStore: Map<string, string>;

async function loadBuildClaudeAgentEnv(): Promise<
  typeof import('@tools/claudeAgentConfig').buildClaudeAgentEnv
> {
  vi.doMock('@platform/platform', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@platform/platform')>();
    return {
      ...actual,
      platform: () => ({
        secrets: {
          async get(key: string) {
            return secretStore.get(key);
          },
        },
      }),
    };
  });

  return (await import('@tools/claudeAgentConfig')).buildClaudeAgentEnv;
}

describe('Claude Agent configuration', () => {
  beforeEach(() => {
    secretStore = new Map();
    vi.resetModules();
    invalidateApiKeyCache();
  });

  afterEach(() => {
    vi.doUnmock('@platform/platform');
    invalidateApiKeyCache();
    vi.unstubAllEnvs();
  });

  it('prefers the managed Anthropic key over the inherited process env', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    await expect(buildClaudeAgentEnv()).resolves.toMatchObject({
      ANTHROPIC_API_KEY: 'from-secret',
    });
  });
});
