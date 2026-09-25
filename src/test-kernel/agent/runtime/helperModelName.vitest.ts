import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { getHelperModelName } from '@agent/runtime/helperModelName';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installedHost, installPlatform } from '@test/support/setupPlatform';

describe('getHelperModelName', () => {
  it.effect(
    'falls back to the built-in default when the configured model is not enabled',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            globalState: {
              [GlobalStateKey.HELPER_MODEL]: 'retired-model',
            },
          }),
        );

        expect(yield* getHelperModelName(installedHost().roots)).toBe(
          DEFAULT_HELPER_MODEL,
        );
      }),
  );
});
