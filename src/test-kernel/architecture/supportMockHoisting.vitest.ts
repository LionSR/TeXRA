// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  supportMockHoistingOrder,
  supportMockHoistingValue,
} from './supportMockHoistingFixture';

/**
 * Runtime proof that Vitest hoists `vi.hoisted` bags in ordinary imported
 * support modules (not just `.vitest.ts` test files or setup files). The
 * shared `@test/support/*Mock` modules rely on this so their `vi.mock`
 * factories can close over a bag that is initialized before the mock is
 * registered. If a future Vitest version stops hoisting imported modules,
 * in-place evaluation resets the pre-hoisted `'before'` marker inside the
 * factory, so this test fails with `['hoisted-factory', 'after']` instead of
 * hoisting the factory ahead of the module body.
 */
describe('shared test-kernel mock hoisting', () => {
  it('hoists vi.hoisted bags ahead of the importing support module body', () => {
    expect(supportMockHoistingValue()).toBe(1);
    expect(supportMockHoistingOrder()).toEqual([
      'hoisted-factory',
      'before',
      'after',
    ]);
  });
});
