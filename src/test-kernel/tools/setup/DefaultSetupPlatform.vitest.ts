// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports
import * as codexAuth from '@texra-ai/llm/node';
import {
  fakeProcessServices,
  installedHost,
  setupPlatform,
} from '@test/support/setupPlatform';
import { getChatGptSubscriptionStatus } from '@texra/tools/setup/platform';

setupPlatform({}, { setup: {} });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shared setup capabilities', () => {
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

        const status = yield* getChatGptSubscriptionStatus(
          installedHost().roots,
        );

        expect(status.signedIn).toBe(true);
        expect(status).not.toHaveProperty('account');
        expect(JSON.stringify(status)).not.toContain('researcher@example.com');
        expect(JSON.stringify(status)).not.toContain('account-private-id');
      }).pipe(Effect.provide(fakeProcessServices())),
  );
});
