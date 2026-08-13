import { describe, expect, it } from 'vitest';

import { isEnvFlagEnabled } from '@utils/system/envFlags';

describe('isEnvFlagEnabled', () => {
  it.each(['1', 'true', 'yes', ' TRUE '])(
    'reads any set value other than an off spelling as on: %j',
    (value) => {
      expect(isEnvFlagEnabled('FLAG', { FLAG: value })).toBe(true);
    },
  );

  // The whole point of a shared helper: `=0` used to mean "on" wherever the
  // caller tested `env[NAME]` for truthiness.
  it.each(['0', 'false', 'No', 'off', '  '])('reads %j as off', (value) => {
    expect(isEnvFlagEnabled('FLAG', { FLAG: value })).toBe(false);
  });

  it('reads an unset variable as off', () => {
    expect(isEnvFlagEnabled('FLAG', {})).toBe(false);
  });
});
