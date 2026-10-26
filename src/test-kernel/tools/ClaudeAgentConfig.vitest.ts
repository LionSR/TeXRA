import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigProvider, Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { buildClaudeAgentEnv } from '@texra/tools/claudeAgentConfig';
import type * as ChildProcess from 'effect/process/ChildProcess';

const home = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir ?? actual.homedir() };
});

let secretStore: Map<string, string>;
let cleanupDirs: string[];
/** The one keychain account whose probe finds a credential, if any. */
let keychainAccount: string | undefined;
/** Every command the env build asked the spawner for. */
let spawnCalls: ChildProcess.StandardCommand[];

/** The suite's secret store as the `Secrets` service the env builder reads. */
const fakeSecrets: PlatformSecrets = {
  get: (key) => Effect.sync(() => secretStore.get(key)),
  set: (key, value) =>
    Effect.sync(() => {
      secretStore.set(key, value);
    }),
  delete: (key) =>
    Effect.sync(() => {
      secretStore.delete(key);
    }),
  listStoredKeys: () => Effect.sync(() => [...secretStore.keys()]),
};

function buildEnv(
  options?: Parameters<typeof buildClaudeAgentEnv>[0],
): Promise<NodeJS.ProcessEnv> {
  const spawner = scriptedSpawnerLayer((command) => ({
    exitCode:
      keychainAccount !== undefined && command.args.includes(keychainAccount)
        ? 0
        : 1,
  }));
  spawnCalls = spawner.calls;
  return Effect.runPromise(
    buildClaudeAgentEnv(options).pipe(
      Effect.provide(Secrets.layer(fakeSecrets)),
      // The live env provider, so the suite's `vi.stubEnv` still governs the
      // API-key fallback read through `envVar`.
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(process.env)),
      ),
      Effect.provide(spawner.layer),
    ),
  );
}

function seedManagedSecret(): void {
  secretStore.set(apiKeySecretName('anthropic'), 'from-secret');
}

describe('Claude Code CLI configuration', () => {
  beforeEach(() => {
    secretStore = new Map();
    cleanupDirs = [];
    home.dir = undefined;
    keychainAccount = undefined;
    spawnCalls = [];
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
    vi.unstubAllEnvs();
    for (const dir of cleanupDirs)
      rmSync(dir, { recursive: true, force: true });
  });

  it('injects the managed Anthropic secret when no OAuth credential exists', async () => {
    seedManagedSecret();

    const env = await buildEnv();
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'from-secret',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'texra',
    });
  });

  it('strips an inherited and a managed API key when an OAuth token is present', async () => {
    // OAuth must win even over an explicit env API key; otherwise the CLI
    // prefers ANTHROPIC_API_KEY and ignores the login session.
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', ' oauth-token ');
    seedManagedSecret();

    const env = await buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
  });

  it('ignores a whitespace-only OAuth token and prefers the env key over the managed secret', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '   ');
    seedManagedSecret();

    const env = await buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBe('from-env');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('expands a tilde CLAUDE_CONFIG_DIR and strips the API key when a login session file exists', async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), 'texra-home-'));
    const sessionDir = path.join(homeDir, '.claude');
    mkdirSync(sessionDir);
    writeFileSync(path.join(sessionDir, '.credentials.json'), '{}');
    cleanupDirs.push(homeDir);
    home.dir = homeDir;
    vi.stubEnv('CLAUDE_CONFIG_DIR', '~/.claude');
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    seedManagedSecret();

    const env = await buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('strips ANTHROPIC_API_KEY when a config-dir keychain OAuth session exists', async () => {
    const configDir = path.join(os.tmpdir(), 'texra-test-claude-profile');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    seedManagedSecret();
    keychainAccount = `${path.resolve(configDir)}-access-token`;

    const env = await buildEnv({ platform: 'darwin' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('ignores the global keychain entry when a custom config dir is active', async () => {
    const configDir = path.join(os.tmpdir(), 'texra-test-custom-claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-env');
    seedManagedSecret();
    keychainAccount = 'Claude Code-credentials';

    const env = await buildEnv({ platform: 'darwin' });
    expect(env.ANTHROPIC_API_KEY).toBe('from-env');
    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(
      spawnCalls.some(
        (command) =>
          command.command === 'security' &&
          command.args.includes('Claude Code-credentials'),
      ),
    ).toBe(false);
  });
});
