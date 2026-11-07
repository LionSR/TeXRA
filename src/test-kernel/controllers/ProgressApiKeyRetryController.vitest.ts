import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { apiKeySecretName, type ApiKeyProviderId } from '@texra-ai/llm';
import type { Session } from '@texra-ai/harness';
import { Secrets } from '@texra-ai/harness/plugins';
import { RunIdSchema, type RuntimeCommand } from '@texra-ai/harness/schemas';
import { FakeSecrets } from '@test/support/FakePlatform';
import { ProgressApiKeyRetryController } from '@texra/controllers/progressView/ProgressApiKeyRetryController';
import { SessionGraph } from '@test/support/testKernel';

layer(SessionGraph.hosted)('ProgressApiKeyRetryController', (it) => {
  it.effect(
    'does not retry when a depleted provider key was not changed',
    () => {
      const secrets = new FakeSecrets({
        [apiKeySecretName('anthropic')]: 'old-key',
      });
      const runId = Schema.decodeUnknownSync(RunIdSchema)('a0000a');
      return Effect.gen(function* () {
        const prompts: ApiKeyProviderId[] = [];
        const sent: RuntimeCommand[] = [];
        // The controller reads only the pending retry and sends its decision.
        // cast: a test double of those two members.
        const session = {
          view: {
            current: () => ({
              requests: [
                { runId, requestId: 'retry-a', payload: { kind: 'retry' } },
              ],
            }),
          },
          request: (request: RuntimeCommand) =>
            Effect.sync(() => {
              sent.push(request);
            }),
        } as unknown as Pick<Session, 'request' | 'view'>;
        const controller = new ProgressApiKeyRetryController({
          // The person re-enters the same key: the store hands out sealed
          // values, which compare by value, so it reads unchanged.
          promptForApiKey: (provider) =>
            Effect.andThen(
              Effect.sync(() => prompts.push(provider)),
              secrets.set(apiKeySecretName('anthropic'), 'old-key'),
            ).pipe(Effect.orDie),
          session,
        });

        const error = yield* Effect.flip(
          controller.useOwnApiKey({
            kind: 'useOwnApiKey',
            runId,
            requestId: 'retry-a',
            credentialSwitch: { kind: 'new-key', provider: 'anthropic' },
          }),
        );

        expect(prompts).toStrictEqual(['anthropic']);
        expect(sent).toStrictEqual([]);
        // The retry stays pending, and the user hears why.
        expect(error._tag).toBe('Rejected');
      }).pipe(Effect.provide(Secrets.layer(secrets)));
    },
  );
});
