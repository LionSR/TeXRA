import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { envFlag } from '@texra-ai/harness/node';
import { withEnv } from '@test/support/testEnv';

describe('envFlag', () => {
  // The whole point of a shared helper: `=0` used to mean "on" wherever the
  // caller tested `env[NAME]` for truthiness.
  it.effect.each([
    { value: '0', on: false },
    { value: ' off ', on: false },
    { value: 'yes', on: true },
  ])('reads $value as on=$on', ({ value, on }) =>
    Effect.gen(function* () {
      expect(yield* envFlag('FLAG').pipe(withEnv({ FLAG: value }))).toBe(on);
    }),
  );
});
