import { describe, expect, it } from 'vitest';

import { AgentCategory, parseDelegationToolInput } from '@shared/schemas';

describe('parseDelegationToolInput', () => {
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
});
