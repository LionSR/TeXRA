// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import { getAgentRegistrationSkipReason } from '@frontend/agents';

describe('getAgentRegistrationSkipReason', () => {
  it('returns alreadyRegistered when the agent is present', () => {
    const reason = getAgentRegistrationSkipReason('polish', ['polish']);
    assert.equal(reason, 'alreadyRegistered');
  });

  it('returns undefined when the agent should be prompted', () => {
    const reason = getAgentRegistrationSkipReason('polish_multiple', ['correct']);
    assert.equal(reason, undefined);
  });
});
