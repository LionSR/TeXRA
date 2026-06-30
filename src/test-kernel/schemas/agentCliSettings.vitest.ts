import { describe, expect, it } from 'vitest';

import {
  parseClaudeAgentModel,
  parseCodexApprovalPolicy,
} from '@shared/schemas/agentCliSettings';

describe('parseCodexApprovalPolicy', () => {
  it('accepts SDK approval policies', () => {
    expect(parseCodexApprovalPolicy('never')).toBe('never');
    expect(parseCodexApprovalPolicy('on-request')).toBe('on-request');
    expect(parseCodexApprovalPolicy('on-failure')).toBe('on-failure');
    expect(parseCodexApprovalPolicy('untrusted')).toBe('untrusted');
  });

  it('defaults to automatic approval for invalid persisted values', () => {
    expect(parseCodexApprovalPolicy('ask')).toBe('never');
  });
});

describe('parseClaudeAgentModel', () => {
  it('maps retired Opus selections to the current Opus model', () => {
    expect(parseClaudeAgentModel('claude-opus-4-7')).toBe('claude-opus-4-8');
  });

  it('defaults invalid persisted selections to Sonnet', () => {
    expect(parseClaudeAgentModel('claude-opus-3')).toBe('claude-sonnet-4-6');
  });
});
