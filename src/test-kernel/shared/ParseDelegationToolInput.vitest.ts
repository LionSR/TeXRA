import { describe, expect, it } from 'vitest';

import { AgentCategory, parseDelegationToolInput } from '@shared/schemas';

describe('parseDelegationToolInput', () => {
  it('routes an agent call without input files to a tool-use proposal', () => {
    const proposal = parseDelegationToolInput(
      { agentName: 'orchestrator', prompt: 'do it' },
      'agent',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.ToolUse);
    expect(proposal?.agent).toBe('orchestrator');
  });

  it('routes an agent call with input files to a workflow proposal', () => {
    const proposal = parseDelegationToolInput(
      { agentName: 'correct', prompt: 'fix', inputFiles: ['paper.tex'] },
      'agent',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.Workflow);
    if (proposal?.agentCategory === AgentCategory.Workflow) {
      expect(proposal.inputFiles).toEqual(['paper.tex']);
    }
  });

  it('maps extractFigures / extractTikz shorthand into toolConfig', () => {
    const proposal = parseDelegationToolInput(
      {
        agentName: 'correct',
        prompt: 'fix',
        inputFiles: ['paper.tex'],
        extractFigures: true,
        extractTikz: false,
      },
      'agent',
    );
    expect(proposal?.agentCategory).toBe(AgentCategory.Workflow);
    if (proposal?.agentCategory === AgentCategory.Workflow) {
      expect(proposal.toolConfig.autoExtractFigure).toBe(true);
      expect(proposal.toolConfig.autoExtractTikzFigure).toBe(false);
    }
  });
});
