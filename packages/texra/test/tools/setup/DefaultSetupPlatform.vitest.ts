// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

// Local imports
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { getChatGptSubscriptionStatus } from '@texra/tools/setup/platform';

/** The process over a host that passes a setup platform and holds a
 *  ChatGPT session naming its account. */
const perTest = Layer.provideMerge(
  SessionGraph.layer,
  FakeHost.layer(
    {
      secrets: {
        'auth.chatgpt': JSON.stringify({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAtMs: 0,
          email: 'researcher@example.com',
          accountId: 'account-private-id',
        }),
      },
    },
    { setup: {} },
  ),
);

layer(perTest, { buildPerTest: true })('shared setup capabilities', (it) => {
  it.effect(
    'does not expose ChatGPT account identifiers through setup tools',
    () =>
      Effect.gen(function* () {
        const status = yield* getChatGptSubscriptionStatus(
          (yield* FakeHost).roots,
        );

        expect(status.signedIn).toBe(true);
        expect(status).not.toHaveProperty('account');
        expect(JSON.stringify(status)).not.toContain('researcher@example.com');
        expect(JSON.stringify(status)).not.toContain('account-private-id');
      }),
  );
});
