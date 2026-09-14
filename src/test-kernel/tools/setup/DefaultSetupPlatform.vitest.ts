// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import { SupabaseClient } from '@auth/SupabaseClient';
import * as codexAuth from '@auth/codex';
import * as providerCapabilities from '@model/providerCapabilities';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
import { workspaceRoots } from '@platform/workspaceRoots';
import {
  fakeProcessServices,
  hostStores,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  getChatGptSubscriptionStatus,
  getSetupAuthStatus,
} from '@tools/setup/platform';

setupPlatform(
  {
    config: { 'texra.bib.defaultPath': 'references.bib' },
    secrets: { 'apiKey.openai': 'sk-stored-key' },
    secretsEnv: { GITHUB_TOKEN: 'github-env-token' },
  },
  { setup: { host: 'extension', signIn: async () => false } },
);

afterEach(() => {
  vi.restoreAllMocks();
  SupabaseClient.resetForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('shared setup capabilities', () => {
  it.effect('keeps API-key-only setup usable without reporting sign-in', () =>
    Effect.gen(function* () {
      expect(
        yield* Effect.promise(() =>
          hasUsableSetupCredential(hostStores().secrets, () => {}),
        ),
      ).toBe(true);
      expect(yield* getSetupAuthStatus()).toEqual({
        authenticated: false,
      });
    }).pipe(Effect.provide(fakeProcessServices())),
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
      }).pipe(Effect.provide(fakeProcessServices())),
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
      }).pipe(Effect.provide(fakeProcessServices())),
  );
});
