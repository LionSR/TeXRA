// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import { getAgentRegistrationSkipReason } from '@frontend/agents/register';

describe('getAgentRegistrationSkipReason', () => {
  it('returns alreadyRegistered when the agent is present', () => {
    const reason = getAgentRegistrationSkipReason('polish', ['polish']);
    assert.equal(reason, 'alreadyRegistered');
  });

  it('returns undefined when the agent should be prompted', () => {
    const reason = getAgentRegistrationSkipReason('polish_multiple', [
      'correct',
    ]);
    assert.equal(reason, undefined);
  });
});
