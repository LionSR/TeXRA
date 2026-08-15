import { describe, expect, it } from 'vitest';

import { AgentCategory, parseDelegationToolInput } from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';

describe('parseDelegationToolInput', () => {
  it('returns null for non-delegation tools', () => {
    expect(parseDelegationToolInput({ agent: 'a' }, 'bash')).toBeNull();
  });

  it('routes delegate_agent to a tool-use proposal', () => {
    const proposal = parseDelegationToolInput(
      { agent: 'orchestrator', instruction: 'do it' },
      'delegate_agent',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.ToolUse);
    expect(proposal?.agent).toBe('orchestrator');
  });

  it('routes delegate_workflow to a workflow proposal', () => {
    const proposal = parseDelegationToolInput(
      { agent: 'correct', instruction: 'fix', inputFiles: ['paper.tex'] },
      'delegate_workflow',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.Workflow);
    if (proposal?.agentCategory === AgentCategory.Workflow) {
      expect(proposal.inputFiles).toEqual(['paper.tex']);
    }
  });

  it('defaults the model to DEFAULT_AGENT_MODEL when omitted', () => {
    const proposal = parseDelegationToolInput(
      { agent: 'correct', instruction: 'fix' },
      'delegate_workflow',
    );
    expect(proposal?.model).toBe(DEFAULT_AGENT_MODEL);
  });

  it('maps extractFigures / extractTikz shorthand into toolConfig', () => {
    const proposal = parseDelegationToolInput(
      {
        agent: 'correct',
        instruction: 'fix',
        extractFigures: true,
        extractTikz: false,
      },
      'delegate_workflow',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.Workflow);
    if (proposal?.agentCategory === AgentCategory.Workflow) {
      expect(proposal.toolConfig.autoExtractFigure).toBe(true);
      expect(proposal.toolConfig.autoExtractTikzFigure).toBe(false);
    }
  });

  it('leaves toolConfig flags at their defaults when shorthand is absent', () => {
    const proposal = parseDelegationToolInput(
      { agent: 'correct', instruction: 'fix' },
      'delegate_workflow',
    );
    if (proposal?.agentCategory === AgentCategory.Workflow) {
      expect(proposal.toolConfig.autoExtractFigure).toBe(false);
      expect(proposal.toolConfig.autoExtractTikzFigure).toBe(false);
    }
  });

  it('returns null when required fields are missing', () => {
    // instruction is required by the canonical proposal schema.
    expect(
      parseDelegationToolInput({ agent: 'correct' }, 'delegate_agent'),
    ).toBeNull();
  });

  it('tolerates non-object input', () => {
    expect(parseDelegationToolInput(null, 'delegate_agent')).toBeNull();
    expect(parseDelegationToolInput('nope', 'delegate_workflow')).toBeNull();
  });
});
