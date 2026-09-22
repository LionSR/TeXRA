import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { getHelperModelName } from '@agent/runtime/helperModelName';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { installedHost, installPlatform } from '@test/support/setupPlatform';

describe('resolveEffectiveHelperModel', () => {
  it('returns the configured model when it is in the candidate list', () => {
    expect(resolveEffectiveHelperModel('gpt55', ['gpt55', 'opus'])).toBe(
      'gpt55',
    );
  });

  it('falls back to the built-in default when the configured model is not in the list', () => {
    expect(
      resolveEffectiveHelperModel('retired-model', ['gpt55', 'opus']),
    ).toBe(DEFAULT_HELPER_MODEL);
  });

  it('returns the built-in default when no model is configured', () => {
    expect(resolveEffectiveHelperModel(undefined, ['gpt55'])).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });
});

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

        expect(
          yield* getHelperModelName(installedHost().roots.globalState),
        ).toBe(DEFAULT_HELPER_MODEL);
      }),
  );
});
