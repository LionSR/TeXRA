import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { apiKeySecretName, type ApiKeyProviderId } from '@texra-ai/llm';
import { Secrets } from '@platform/secrets';
import type { RunId } from '@shared/schemas';
import { FakeSecrets } from '@test/support/FakePlatform';
import { ProgressApiKeyRetryController } from '@texra/controllers/progressView/ProgressApiKeyRetryController';

describe('ProgressApiKeyRetryController', () => {
  it.effect(
    'does not retry when a depleted provider key was not changed',
    () => {
      const secrets = new FakeSecrets({
        [apiKeySecretName('anthropic')]: 'old-key',
      });
      return Effect.gen(function* () {
        const prompts: ApiKeyProviderId[] = [];
        const retries: string[] = [];
        const controller = new ProgressApiKeyRetryController({
          // The person re-enters the same key: the store hands out sealed
          // values, which compare by value, so it reads unchanged.
          promptForApiKey: (provider) =>
            Effect.andThen(
              Effect.sync(() => prompts.push(provider)),
              secrets.set(apiKeySecretName('anthropic'), 'old-key'),
            ).pipe(Effect.orDie),
          isRetryPending: () => true,
          triggerRetry: (stream) =>
            Effect.sync(() => {
              retries.push(stream);
            }),
        });

        yield* controller.useOwnApiKey({
          stream: 'stream-a' as RunId,
          requestId: 'retry-a',
          provider: 'anthropic',
          requireNewKey: true,
        });

        expect(prompts).toStrictEqual(['anthropic']);
        expect(retries).toStrictEqual([]);
      }).pipe(Effect.provide(Secrets.layer(secrets)));
    },
  );
});
