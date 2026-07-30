import { describe, expect, it } from 'vitest';

import { isEnvFlagEnabled } from '@utils/system/envFlags';

describe('isEnvFlagEnabled', () => {
  it('reads any set value other than an off spelling as on', () => {
    expect(isEnvFlagEnabled('FLAG', { FLAG: '1' })).toBe(true);
    expect(isEnvFlagEnabled('FLAG', { FLAG: 'true' })).toBe(true);
    expect(isEnvFlagEnabled('FLAG', { FLAG: 'yes' })).toBe(true);
    expect(isEnvFlagEnabled('FLAG', { FLAG: ' TRUE ' })).toBe(true);
  });

  // The whole point of a shared helper: `=0` used to mean "on" wherever the
  // caller tested `env[NAME]` for truthiness.
  it('reads the off spellings and an unset variable as off', () => {
    expect(isEnvFlagEnabled('FLAG', { FLAG: '0' })).toBe(false);
    expect(isEnvFlagEnabled('FLAG', { FLAG: 'false' })).toBe(false);
    expect(isEnvFlagEnabled('FLAG', { FLAG: 'No' })).toBe(false);
    expect(isEnvFlagEnabled('FLAG', { FLAG: 'off' })).toBe(false);
    expect(isEnvFlagEnabled('FLAG', { FLAG: '  ' })).toBe(false);
    expect(isEnvFlagEnabled('FLAG', {})).toBe(false);
  });
});
