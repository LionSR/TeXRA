// Third-party imports
import * as os from 'os';
import * as path from 'path';
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

describe('Claude Code CLI configuration', () => {
  beforeEach(() => {
    secretStore = new Map();
    vi.resetModules();
    invalidateApiKeyCache();
    // Deterministic baseline: no OAuth credential present. Point the config dir
    // at a path that cannot contain `.credentials.json` and clear the token so
    // tests don't pick up a real `claude login` session on the host.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv(
      'CLAUDE_CONFIG_DIR',
      path.join(os.tmpdir(), 'texra-test-no-claude-config'),
    );
  });

  afterEach(() => {
    vi.doUnmock('@platform/platform');
    invalidateApiKeyCache();
    vi.unstubAllEnvs();
  });

  it('injects the managed Anthropic secret when no OAuth credential exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    await expect(buildClaudeAgentEnv()).resolves.toMatchObject({
      ANTHROPIC_API_KEY: 'from-secret',
    });
  });

  it('does not override a CLAUDE_CODE_OAUTH_TOKEN session with the managed secret', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    // The stale Settings key must not shadow the working login session.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('passes an explicit env ANTHROPIC_API_KEY through untouched', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    await expect(buildClaudeAgentEnv()).resolves.toMatchObject({
      ANTHROPIC_API_KEY: 'from-env',
    });
  });
});
