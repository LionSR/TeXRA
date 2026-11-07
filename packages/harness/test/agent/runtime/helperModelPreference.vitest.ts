import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { AgentConfigSchema } from '@texra-ai/harness/schemas';
import { applyHelperModelPreference } from '@agent/runtime/helperModelName';
import { withEnv } from '@test/support/testEnv';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'applyHelperModelPreference',
  (it) => {
    // No credential is stored or in the environment, so the helper model
    // cannot run: the launch keeps the model the user selected rather than
    // failing on the helper.
    it.effect(
      'falls back to the selected model when the helper model is unavailable',
      () =>
        Effect.gen(function* () {
          const selected = 'anthropic/claude-sonnet-4-6';
          const config = Schema.decodeUnknownSync(AgentConfigSchema)({
            agent: 'latexFixer',
            model: selected,
          });

          const result = yield* applyHelperModelPreference(
            config,
            (yield* FakeHost).roots,
          ).pipe(withEnv({}));

          expect(result.model).toBe(selected);
        }),
    );
  },
);
