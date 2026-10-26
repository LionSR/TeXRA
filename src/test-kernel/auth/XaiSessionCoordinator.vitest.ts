import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { xaiCoordinator } from '@texra-ai/llm/node';
import type { CredentialStore } from '@texra-ai/llm';

/** A secret store holding `stored` under every key; writes are dropped. */
function storeHolding(stored?: string): CredentialStore {
  return {
    get: () => Effect.succeed(stored),
    set: () => Effect.void,
    delete: () => Effect.void,
  };
}

describe('xAI subscription session coordinator', () => {
  it.effect('fails an unreadable stored session as fatal, not signed out', () =>
    Effect.gen(function* () {
      const coordinator = xaiCoordinator(
        storeHolding(JSON.stringify({ accessToken: 'only' })),
      );
      const failure = yield* Effect.flip(coordinator.getStatus());
      expect(failure).toMatchObject({
        _tag: 'SubscriptionOAuthError',
        kind: 'fatal',
      });
    }),
  );
});
