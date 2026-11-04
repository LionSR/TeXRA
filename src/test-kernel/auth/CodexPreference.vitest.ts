// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

// Local imports
import { SubscriptionPreference } from '@texra-ai/harness/host';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { FakeHost } from '@test/support/testKernel';

const CODEX_PREFER_SUBSCRIPTION_KEY = 'chatgptCodex.preferSubscription';

layer(FakeHost.layer({ config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false } }))(
  'Codex subscription preference (packages/harness/src/model/subscriptionAccess.ts)',
  (it) => {
    it.effect(
      'writes workspace preference when workspace config already controls it',
      () =>
        Effect.gen(function* () {
          yield* SubscriptionPreference.set(
            'chatgpt',
            testWorkspaceRoots(),
            true,
          );

          expect(
            SubscriptionPreference.get('chatgpt', testWorkspaceRoots()),
          ).toBe(true);
          expect(
            testWorkspaceRoots().config.inspect(CODEX_PREFER_SUBSCRIPTION_KEY),
          ).toMatchObject({
            workspaceValue: true,
          });
        }),
    );
  },
);
