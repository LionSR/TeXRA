// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import * as codexAuth from '@auth/codex';
import { hasUsableSetupCredential } from '@model/setupCredentialAccess';
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
    env: { GITHUB_TOKEN: 'github-env-token' },
  },
  { setup: { host: 'extension', signIn: () => Effect.succeed(false) } },
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('shared setup capabilities', () => {
  it.effect('keeps API-key-only setup usable without reporting sign-in', () =>
    Effect.gen(function* () {
      expect(
        yield* hasUsableSetupCredential(hostStores(), hostStores().secrets),
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
        vi.spyOn(codexAuth, 'getCodexStatus').mockReturnValue(
          Effect.succeed({
            signedIn: true,
            email: 'researcher@example.com',
            accountId: 'account-private-id',
          }),
        );

        const status = yield* getChatGptSubscriptionStatus(hostStores());

        expect(status.signedIn).toBe(true);
        expect(status).not.toHaveProperty('account');
        expect(JSON.stringify(status)).not.toContain('researcher@example.com');
        expect(JSON.stringify(status)).not.toContain('account-private-id');
      }).pipe(Effect.provide(fakeProcessServices())),
  );
});
