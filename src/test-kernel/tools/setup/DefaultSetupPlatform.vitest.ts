// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, expect, vi } from 'vitest';

// Local imports
import * as chatgptAuth from '@texra-ai/llm/node';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { getChatGptSubscriptionStatus } from '@texra/tools/setup/platform';

/** The process over a host that passes a setup platform. */
const perTest = Layer.provideMerge(
  FakeHost.layer({}, { setup: {} }),
  SessionGraph.layer,
);

afterEach(() => {
  vi.restoreAllMocks();
});

layer(perTest, { buildPerTest: true })('shared setup capabilities', (it) => {
  it.effect(
    'does not expose ChatGPT account identifiers through setup tools',
    () =>
      Effect.gen(function* () {
        vi.spyOn(chatgptAuth, 'getChatgptStatus').mockReturnValue(
          Effect.succeed({
            signedIn: true,
            email: 'researcher@example.com',
            accountId: 'account-private-id',
          }),
        );

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
