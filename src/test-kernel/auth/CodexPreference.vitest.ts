// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { SubscriptionPreference } from '@model/subscriptionAccess';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';

const CODEX_PREFER_SUBSCRIPTION_KEY = 'texra.chatgptCodex.preferSubscription';

describe('Codex subscription preference (packages/harness/src/model/subscriptionAccess.ts)', () => {
  it.effect(
    'writes workspace preference when workspace config already controls it',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            config: { [CODEX_PREFER_SUBSCRIPTION_KEY]: false },
          }),
        );

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
});
