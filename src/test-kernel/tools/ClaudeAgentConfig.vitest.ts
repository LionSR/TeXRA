// Third-party imports
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

// Local imports - model
import { apiKeySecretName, invalidateApiKeyCache } from '@model/apiProviders';
import type { ExecResult } from '@shared/schemas/opResults';

let secretStore: Map<string, string>;
let cleanupDirs: string[];
let executeCommandSyncMock: Mock<
  (command: readonly [string, ...string[]], options?: object) => ExecResult
>;
let homedirMock: string;

const EXEC_RESULT_NOT_FOUND: ExecResult = {
  success: false,
  stdout: null,
  stderr: null,
  timedOut: false,
  exitCode: 1,
};
const EXEC_RESULT_FOUND: ExecResult = {
  success: true,
  stdout: null,
  stderr: null,
  timedOut: false,
  exitCode: 0,
};

async function loadBuildClaudeAgentEnv(): Promise<
  typeof import('@tools/claudeAgentConfig').buildClaudeAgentEnv
> {
  vi.doMock('@utils/system/execUtils', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('@utils/system/execUtils')>();
    return {
      ...actual,
      executeCommandSync: executeCommandSyncMock,
    };
  });

  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return {
      ...actual,
      homedir: () => homedirMock,
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
    homedirMock = os.homedir();
    executeCommandSyncMock = vi.fn(() => EXEC_RESULT_NOT_FOUND);
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
    vi.doUnmock('@utils/system/execUtils');
    vi.doUnmock('os');
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

  it('leaves ANTHROPIC_API_KEY absent when no credential exists', async () => {
    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('texra');
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
    // OAuth must win even over an explicit env API key; otherwise the CLI
    // prefers ANTHROPIC_API_KEY and ignores the login session.
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', ' oauth-token ');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('ignores a whitespace-only OAuth token when no OAuth credential exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '   ');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('from-env');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
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

  it('expands a tilde CLAUDE_CONFIG_DIR before checking for a login session file', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'texra-home-'));
    const sessionDir = path.join(homeDir, '.claude');
    mkdirSync(sessionDir);
    writeFileSync(path.join(sessionDir, '.credentials.json'), '{}');
    cleanupDirs.push(homeDir);
    homedirMock = homeDir;
    vi.stubEnv('CLAUDE_CONFIG_DIR', '~/.claude');
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips ANTHROPIC_API_KEY when a config-dir keychain OAuth session exists', async () => {
    const configDir = path.join(os.tmpdir(), 'texra-test-claude-profile');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');
    executeCommandSyncMock.mockImplementation((command) => {
      if (
        Array.isArray(command) &&
        command.includes(`${path.resolve(configDir)}-access-token`)
      ) {
        return EXEC_RESULT_FOUND;
      }
      return EXEC_RESULT_NOT_FOUND;
    });

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv({ platform: 'darwin' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('ignores the global keychain entry when a custom config dir is active', async () => {
    const configDir = path.join(os.tmpdir(), 'texra-test-custom-claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    secretStore.set(apiKeySecretName('anthropic'), 'from-secret');
    executeCommandSyncMock.mockImplementation((command) => {
      if (
        Array.isArray(command) &&
        command.includes('Claude Code-credentials')
      ) {
        return EXEC_RESULT_FOUND;
      }
      return EXEC_RESULT_NOT_FOUND;
    });

    const buildClaudeAgentEnv = await loadBuildClaudeAgentEnv();
    const env = await buildClaudeAgentEnv({ platform: 'darwin' });
    expect(env.ANTHROPIC_API_KEY).toBe('from-env');
    expect(
      executeCommandSyncMock.mock.calls.some(
        ([command]) =>
          Array.isArray(command) && command.includes('Claude Code-credentials'),
      ),
    ).toBe(false);
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
