import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { applyHelperModelPreference } from '@agent/runtime/helperModelName';
import { installedHost } from '@test/support/setupPlatform';
import { withEnv } from '@test/support/testEnv';
import { SessionGraph } from '@test/support/testKernel';
import type { AgentConfig } from '@texra-ai/harness/schemas';

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
          const config = {
            agent: 'latexFixer',
            model: selected,
          } as unknown as AgentConfig;

          const result = yield* applyHelperModelPreference(
            config,
            installedHost().roots,
          ).pipe(withEnv({}));

          expect(result.model).toBe(selected);
        }),
    );
  },
);
