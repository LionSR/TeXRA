import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import { selectAvailableDelegationModel } from '@agent/runtime/delegation/delegationAvailability';
import { installedHost } from '@test/support/setupPlatform';
import { withEnv } from '@test/support/testEnv';
import { SessionGraph } from '@test/support/testKernel';

layer(SessionGraph.hosted)('delegation model availability', (it) => {
  // Only an OpenAI key is stored, so a named Anthropic model cannot run: the
  // launch is refused, never silently swapped for a model that can. The
  // environment is the fake host's, which holds no key.
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
            settings: installedHost().roots,
          }),
        );

        expect(failure.message).toContain(
          'Model "anthropic/claude-opus-5-5" is not currently available for delegation',
        );
      }).pipe(withEnv({})),
  );
});
