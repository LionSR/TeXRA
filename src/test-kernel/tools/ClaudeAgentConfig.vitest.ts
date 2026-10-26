import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigProvider, Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { buildClaudeAgentEnv } from '@texra/tools/claudeAgentConfig';

let secretStore: Map<string, string>;
/** The one keychain account whose probe finds a credential, if any. */
let keychainAccount: string | undefined;

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
    keychainAccount = undefined;
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
});
