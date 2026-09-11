// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { SupabaseClient } from '@auth/SupabaseClient';
import * as codexAuth from '@auth/codex';
import * as providerCapabilities from '@model/providerCapabilities';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  __resetSetupPlatformForTests,
  getChatGptSubscriptionStatus,
  getSetupAuthStatus,
  getSetupPlatform,
  setSetupPlatform,
  setupSecrets,
  texraScopedConfig,
} from '@tools/setup/platform';

setupPlatform({
  config: { 'texra.bib.defaultPath': 'references.bib' },
  secrets: { 'apiKey.openai': 'sk-stored-key' },
  secretsEnv: { GITHUB_TOKEN: 'github-env-token' },
});

afterEach(() => {
  vi.restoreAllMocks();
  SupabaseClient.resetForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  __resetSetupPlatformForTests();
  setSetupPlatform({ host: 'extension', signIn: async () => false });
});

describe('shared setup capabilities', () => {
  it('keeps the configuration boundary at texra.* keys', () => {
    expect(() => texraScopedConfig.get('editor.fontSize')).toThrow(
      'Setup config adapter is scoped to texra.* keys',
    );
  });

  it.effect('recognizes a stored key even when its value cannot be read', () =>
    Effect.gen(function* () {
      vi.spyOn(platform().secrets, 'getStored').mockResolvedValue(undefined);
      vi.spyOn(platform().secrets, 'listStoredKeys').mockResolvedValue([
        'apiKey.openai',
      ]);

      expect(yield* setupSecrets.storedApiKeyExists('openai')).toBe(true);
    }),
  );

  it.effect('keeps API-key-only setup usable without reporting sign-in', () =>
    Effect.gen(function* () {
      expect(yield* setupSecrets.anyUsableCredentialExists()).toBe(true);
      expect(yield* getSetupAuthStatus()).toEqual({
        authenticated: false,
      });
    }),
  );

  it.effect(
    'does not expose ChatGPT account identifiers through setup tools',
    () =>
      Effect.gen(function* () {
        vi.spyOn(codexAuth, 'getCodexStatus').mockResolvedValue({
          signedIn: true,
          email: 'researcher@example.com',
          accountId: 'account-private-id',
        });

        const status = yield* getChatGptSubscriptionStatus();

        expect(status.signedIn).toBe(true);
        expect(status).not.toHaveProperty('account');
        expect(JSON.stringify(status)).not.toContain('researcher@example.com');
        expect(JSON.stringify(status)).not.toContain('account-private-id');
      }),
  );

  it.effect(
    'reports ChatGPT as disabled when runtime routing cannot use it',
    () =>
      Effect.gen(function* () {
        vi.spyOn(codexAuth, 'getCodexStatus').mockResolvedValue({
          signedIn: true,
          email: 'researcher@example.com',
        });
        vi.spyOn(
          providerCapabilities,
          'isCodexSubscriptionActive',
        ).mockResolvedValue(false);

        expect(yield* getChatGptSubscriptionStatus()).toEqual({
          signedIn: true,
          enabled: false,
        });
      }),
  );
});
