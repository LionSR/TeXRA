// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  getAgentRegistrationSkipReason,
  type AgentVariantMetadata,
} from '@frontend/agents/register';

describe('getAgentRegistrationSkipReason', () => {
  it('returns alreadyRegistered when the agent is present', () => {
    const reason = getAgentRegistrationSkipReason('polish', ['polish'], {});
    assert.equal(reason, 'alreadyRegistered');
  });

  it('returns baseRegistered when a multiple agent has its base configured', () => {
    const metadata: AgentVariantMetadata = {
      isMultipleOutput: true,
      baseAgentName: 'polish',
    };
    const reason = getAgentRegistrationSkipReason(
      'polish_multiple',
      ['polish'],
      metadata,
    );
    assert.equal(reason, 'baseRegistered');
  });

  it('returns multipleRegistered when the sibling multiple agent exists', () => {
    const metadata: AgentVariantMetadata = {
      isMultipleOutput: false,
      multipleAgentName: 'polish_multiple',
    };
    const reason = getAgentRegistrationSkipReason(
      'polish',
      ['polish_multiple'],
      metadata,
    );
    assert.equal(reason, 'multipleRegistered');
  });

  it('returns undefined when the agent should be prompted', () => {
    const metadata: AgentVariantMetadata = {
      isMultipleOutput: true,
      baseAgentName: 'polish',
    };
    const reason = getAgentRegistrationSkipReason(
      'polish_multiple',
      ['correct'],
      metadata,
    );
    assert.equal(reason, undefined);
  });
});
