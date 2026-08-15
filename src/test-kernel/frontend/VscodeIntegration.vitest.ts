import { describe, expect, it } from 'vitest';

import { vscodeLeanLanguageServices } from '@frontend/lean/VscodeIntegration';

describe('vscodeLeanLanguageServices', () => {
  it('is frozen so no consumer can reassign a member', () => {
    expect(Object.isFrozen(vscodeLeanLanguageServices)).toBe(true);
    const original = vscodeLeanLanguageServices.getGoalState;
    expect(() => {
      Object.assign(vscodeLeanLanguageServices, {
        getGoalState: async () => undefined,
      });
    }).toThrow(TypeError);
    expect(vscodeLeanLanguageServices.getGoalState).toBe(original);
  });
});
