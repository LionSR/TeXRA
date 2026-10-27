import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import {
  fakeProcessServices,
  hostStores,
  installedHost,
} from '@test/support/setupPlatform';
import { selectAvailableDelegationModel } from '@tools/delegation/delegationAvailability';

describe('delegation model availability', () => {
  // Only an OpenAI key is stored, so a named Anthropic model cannot run: the
  // launch is refused, never silently swapped for a model that can.
  it.effect(
    'rejects an explicitly requested model that is not currently available',
    () =>
      Effect.gen(function* () {
        yield* installedHost().secrets.set(
          apiKeySecretName('openai'),
          'sk-key',
        );
        const failure = yield* Effect.flip(
          selectAvailableDelegationModel({
            requestedModel: 'anthropic/claude-opus-5-5',
            parentModel: 'anthropic/claude-sonnet-5-5',
            settings: hostStores(),
          }),
        );

        expect(failure.message).toContain(
          'Model "anthropic/claude-opus-5-5" is not currently available for delegation',
        );
        expect(failure.message).toMatch(/Available models: openai\//);
      }).pipe(Effect.provide(fakeProcessServices())),
  );
});
