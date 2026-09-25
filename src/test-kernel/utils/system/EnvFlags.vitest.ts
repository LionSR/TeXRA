import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { withEnv } from '@test/support/testEnv';
import { envFlag } from '@utils/system/envFlags';

const readFlag = (env: Record<string, string>): boolean =>
  Effect.runSync(envFlag('FLAG').pipe(withEnv(env)));

describe('envFlag', () => {
  it.each(['1', 'true', 'yes', ' TRUE '])(
    'reads any set value other than an off spelling as on: %j',
    (value) => {
      expect(readFlag({ FLAG: value })).toBe(true);
    },
  );

  // The whole point of a shared helper: `=0` used to mean "on" wherever the
  // caller tested `env[NAME]` for truthiness.
  it.each(['0', 'false', 'No', 'off', '  '])('reads %j as off', (value) => {
    expect(readFlag({ FLAG: value })).toBe(false);
  });

  it('reads an unset variable as off', () => {
    expect(readFlag({})).toBe(false);
  });
});
