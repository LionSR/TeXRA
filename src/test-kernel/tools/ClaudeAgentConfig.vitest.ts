// Third-party imports
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - model
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';

let secretStore: Map<string, string>;
let cleanupDirs: string[];

async function loadBuildClaudeAgentEnv(): Promise<
  typeof import('@tools/claudeAgentConfig').buildClaudeAgentEnv
> {
  vi.doMock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return {
      ...actual,
      execFileSync: vi.fn(() => {
        throw new Error('not found');
      }),
    };
  });

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
    cleanupDirs = [];
    vi.resetModules();
    invalidateApiKeyCache();
    // Deterministic baseline: no OAuth credential present. Point the config dir
    // at a path that cannot contain `.credentials.json` and clear the token so
    // tests don't pick up a real `claude login` session on the host.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    delete process.env.ANTHROPIC_API_KEY;
    vi.stubEnv(
      'CLAUDE_CONFIG_DIR',
      path.join(os.tmpdir(), 'texra-test-no-claude-config'),
    );
  });

  afterEach(() => {
    vi.doUnmock('child_process');
    vi.doUnmock('@platform/platform');
    invalidateApiKeyCache();
    vi.unstubAllEnvs();
    for (const dir of cleanupDirs)
      rmSync(dir, { recursive: true, force: true });
  });

  it('injects the managed Anthropic secret when no OAuth credential exists', async () => {
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

  it('strips an inherited ANTHROPIC_API_KEY when an OAuth token is present', async () => {
    // OAuth must win even over an explicit env API key — otherwise the CLI
    // prefers ANTHROPIC_API_KEY and ignores the login session.
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('strips ANTHROPIC_API_KEY when a `claude login` session file exists', async () => {
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'texra-claude-'));
    writeFileSync(path.join(sessionDir, '.credentials.json'), '{}');
    cleanupDirs.push(sessionDir);
    vi.stubEnv('CLAUDE_CONFIG_DIR', sessionDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('passes an explicit env ANTHROPIC_API_KEY through when no OAuth credential exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    await expect(buildClaudeAgentEnv()).resolves.toMatchObject({
      ANTHROPIC_API_KEY: 'from-env',
    });
  });
});
