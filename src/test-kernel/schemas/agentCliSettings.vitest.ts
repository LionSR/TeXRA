// Standard library imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import {
  parseClaudeAgentModel,
  parseCodexApprovalPolicy,
} from '@shared/schemas/agentCliSettings';

describe('parseCodexApprovalPolicy', () => {
  it('accepts SDK approval policies', () => {
    assert.equal(parseCodexApprovalPolicy('never'), 'never');
    assert.equal(parseCodexApprovalPolicy('on-request'), 'on-request');
    assert.equal(parseCodexApprovalPolicy('on-failure'), 'on-failure');
    assert.equal(parseCodexApprovalPolicy('untrusted'), 'untrusted');
  });

  it('defaults to automatic approval for invalid persisted values', () => {
    assert.equal(parseCodexApprovalPolicy('ask'), 'never');
  });
});

describe('parseClaudeAgentModel', () => {
  it('maps retired Opus selections to the current Opus model', () => {
    assert.equal(parseClaudeAgentModel('claude-opus-4-7'), 'claude-opus-4-8');
  });

  it('defaults invalid persisted selections to Sonnet', () => {
    assert.equal(parseClaudeAgentModel('claude-opus-3'), 'claude-sonnet-4-6');
  });
});
