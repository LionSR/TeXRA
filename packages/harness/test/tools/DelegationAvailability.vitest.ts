import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { apiKeySecretName } from '@texra-ai/llm';
import { selectAvailableDelegationModel } from '@agent/runtime/delegation/delegationAvailability';
import { withEnv } from '@test/support/testEnv';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

layer(SessionGraph.hosted)('delegation model availability', (it) => {
  // Only an OpenAI key is stored, so a named Anthropic model cannot run: the
  // launch is refused, never silently swapped for a model that can. The
  // environment is the fake host's, which holds no key.
  it.effect(
    'rejects an explicitly requested model that is not currently available',
    () =>
      Effect.gen(function* () {
        const host = yield* FakeHost;
        yield* host.secrets.set(apiKeySecretName('openai'), 'sk-key');
        const failure = yield* Effect.flip(
          selectAvailableDelegationModel({
            requestedModel: 'anthropic/claude-opus-5-5',
            parentModel: 'anthropic/claude-sonnet-5-5',
            settings: host.roots,
          }),
        );

        expect(failure.message).toContain(
          'Model "anthropic/claude-opus-5-5" is not currently available for delegation',
        );
      }).pipe(withEnv({})),
  );

  // The parent's model is not runnable here, so the child takes the first
  // available model; the decision carries the notice the launch shows.
  it.effect("tells when the parent run's model falls back", () =>
    Effect.gen(function* () {
      const host = yield* FakeHost;
      yield* host.secrets.set(apiKeySecretName('openai'), 'sk-key');
      const selected = yield* selectAvailableDelegationModel({
        parentModel: 'anthropic/claude-sonnet-5-5',
        settings: host.roots,
      });

      expect(selected._tag).toBe('Fallback');
      expect(selected._tag === 'Fallback' && selected.notice).toContain(
        'Model "anthropic/claude-sonnet-5-5" is not available',
      );
    }).pipe(withEnv({})),
  );

  // The parent runs on a model the person never enabled (an embedder names
  // its run's model; the catalog curates others): the child keeps it, since
  // the parent's own run shows it can run, instead of falling back to a
  // model from the enabled list.
  it.effect("keeps the parent run's model when it is not an enabled one", () =>
    Effect.gen(function* () {
      const host = yield* FakeHost;
      yield* host.secrets.set(apiKeySecretName('openai'), 'sk-key');
      const selected = yield* selectAvailableDelegationModel({
        parentModel: 'openai/gpt-6.2-sol',
        settings: host.roots,
      });

      expect(selected).toMatchObject({
        _tag: 'Chosen',
        model: 'openai/gpt-6.2-sol',
        reason: 'parent-run',
      });
    }).pipe(withEnv({})),
  );
});
