import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { xaiCoordinator } from '@texra-ai/llm/node';

describe('xAI subscription session coordinator', () => {
  it.effect('fails an unreadable stored session as fatal, not signed out', () =>
    Effect.gen(function* () {
      // A stored session missing its required fields.
      const coordinator = xaiCoordinator({
        get: () => Effect.succeed(JSON.stringify({ accessToken: 'only' })),
        set: () => Effect.void,
        delete: () => Effect.void,
      });
      const failure = yield* Effect.flip(coordinator.getStatus());
      expect(failure).toMatchObject({
        _tag: 'SubscriptionOAuthError',
        kind: 'fatal',
      });
    }),
  );
});
