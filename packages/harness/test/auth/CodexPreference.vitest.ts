// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

// Local imports
import { SubscriptionPreference } from '@texra-ai/harness/host';
import { FakeHost } from '@test/support/testKernel';

const CODEX_PREFER_SUBSCRIPTION_KEY = 'chatgptCodex.preferSubscription';

layer(FakeHost.layer({ config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false } }))(
  'Codex subscription preference (packages/harness/src/model/subscriptionAccess.ts)',
  (it) => {
    it.effect(
      'writes workspace preference when workspace config already controls it',
      () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          yield* SubscriptionPreference.set('chatgpt', roots, true);

          expect(SubscriptionPreference.get('chatgpt', roots)).toBe(true);
          expect(
            roots.config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY),
          ).toMatchObject({
            workspaceValue: true,
          });
        }),
    );
  },
);
