// Node.js built-in imports
import * as assert from 'assert';

// Local imports - shared constants
import {
  delegationAllowed,
  evaluateDelegationGate,
  UNKNOWN_DELEGATION_DEPTH,
} from '@shared/constants/delegationPolicy';

describe('delegationPolicy', () => {
  it('allows root delegation at the default max depth', () => {
    const config = { maxDepth: 1 };

    assert.strictEqual(delegationAllowed(0, config), true);
    assert.deepStrictEqual(evaluateDelegationGate(0, config), {
      depth: 0,
      maxDepth: 1,
      allowed: true,
    });
  });

  it('blocks subagent delegation at the default max depth', () => {
    const result = evaluateDelegationGate(1, { maxDepth: 1 });

    assert.deepStrictEqual(result, {
      depth: 1,
      maxDepth: 1,
      allowed: false,
      blockReason: 'max_depth_reached',
    });
  });

  it('distinguishes unknown resumed lineage from ordinary max-depth blocks', () => {
    const result = evaluateDelegationGate(UNKNOWN_DELEGATION_DEPTH, {
      maxDepth: 5,
    });

    assert.deepStrictEqual(result, {
      depth: 'unknown',
      maxDepth: 5,
      allowed: false,
      blockReason: 'unknown_depth',
    });
  });
});
