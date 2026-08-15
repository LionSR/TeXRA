import { describe, expect, it } from 'vitest';

import { vscodeLeanLanguageServices } from '@frontend/lean/VscodeIntegration';

const EXPECTED_MEMBERS = [
  'executeFileCommand',
  'getGoalState',
  'getTermGoal',
  'getHoverInfo',
  'fetchDiagnosticsForFile',
  'navigateToFirstError',
  'executeProjectCommand',
] as const;

describe('vscodeLeanLanguageServices', () => {
  it('exposes exactly the LeanLanguageServices operations as functions', () => {
    expect(Object.keys(vscodeLeanLanguageServices).sort()).toEqual(
      [...EXPECTED_MEMBERS].sort(),
    );
    for (const member of EXPECTED_MEMBERS) {
      expect(typeof vscodeLeanLanguageServices[member]).toBe('function');
    }
  });

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
