import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { servableHelperModel } from '@agent/runtime/helperModelName';
import { captureLogEntries } from '@test/support/logSinkCapture';
import { withEnv } from '@test/support/testEnv';
import { FakeHost } from '@test/support/testKernel';
import { texraHosted } from '@test/support/texraApp';

// TeXRA's catalog names a helper model by default; the harness's names none,
// and a launch with no helper keeps its model before availability is asked.
layer(texraHosted, { excludeTestServices: true })(
  'servableHelperModel',
  (it) => {
    // No credential is stored or in the environment, so the helper model
    // cannot run: the launch keeps the model the user selected rather than
    // failing on the helper.
    it.effect(
      'falls back to the selected model when the helper model is unavailable',
      () =>
        Effect.gen(function* () {
          const capture = yield* captureLogEntries;
          const selected = 'anthropic/claude-sonnet-4-6';
          const model = yield* servableHelperModel(
            (yield* FakeHost).roots,
            selected,
          ).pipe(withEnv({}));

          expect(model).toBe(selected);
          expect(
            capture.has(
              'WARN',
              'helperModel',
              `Using ${selected}: helper model deepseek/deepseek-flash@none is unavailable.`,
            ),
          ).toBe(true);
        }),
    );
  },
);
