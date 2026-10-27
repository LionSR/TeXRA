import { it } from '@effect/vitest';
import { Effect, Redacted } from 'effect';
import { describe, expect } from 'vitest';

import type { RunId } from '@shared/schemas';
import { fakeProcessServices } from '@test/support/setupPlatform';
import { ProgressApiKeyRetryController } from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import type { ApiKeyProviderId } from '@texra-ai/llm';

describe('ProgressApiKeyRetryController', () => {
  it.effect('does not retry when a depleted provider key was not changed', () =>
    Effect.gen(function* () {
      const keys = new Map<ApiKeyProviderId, string>([
        ['anthropic', 'old-key'],
      ]);
      const prompts: ApiKeyProviderId[] = [];
      const retries: string[] = [];
      const controller = new ProgressApiKeyRetryController({
        // The port hands out sealed values, which compare by value so a
        // re-entered identical key reads unchanged.
        readKey: (provider) =>
          Effect.sync(() => {
            const key = keys.get(provider);
            return key === undefined ? undefined : Redacted.make(key);
          }),
        hasUsableKey: (provider) =>
          Effect.sync(() => (keys.get(provider)?.trim().length ?? 0) > 0),
        // The person re-enters the same key.
        promptForApiKey: (provider) =>
          Effect.sync(() => {
            prompts.push(provider);
            keys.set('anthropic', 'old-key');
          }),
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
    }).pipe(Effect.provide(fakeProcessServices())),
  );
});
