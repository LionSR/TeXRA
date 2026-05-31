import { describe, expect, it } from 'vitest';

import { formatUnavailableApprovalInstruction } from '@cli/commands/_helpers/approvalPolicyInstruction';
import { formatMultiAgentRunInstruction } from '@cli/commands/_helpers/multiAgentInstruction';

const preset = {
  id: 'mathematician',
  name: 'Mathematician',
  description: 'Coordinate proof-oriented agents.',
  workflowAgents: ['polish'],
  toolUseAgents: ['team'],
  source: 'built-in',
};

describe('formatUnavailableApprovalInstruction', () => {
  it('describes never as an automatic approval rejection', () => {
    for (const mode of ['headless', 'interactive'] as const) {
      const instruction = formatUnavailableApprovalInstruction({
        mode,
        approvalPolicy: 'never',
      });

      expect(instruction).toContain('Approval policy for this run is "never"');
      expect(instruction).toContain('will be rejected automatically');
    }
  });

  it('warns headless ask runs that approval prompts cannot be answered', () => {
    const instruction = formatUnavailableApprovalInstruction({
      mode: 'headless',
      approvalPolicy: 'ask',
    });

    expect(instruction).toContain('headless run with approval policy "ask"');
    expect(instruction).toContain('approval prompts cannot be answered');
  });

  it('does not warn for interactive ask because prompts are available', () => {
    const instruction = formatUnavailableApprovalInstruction({
      mode: 'interactive',
      approvalPolicy: 'ask',
    });

    expect(instruction).toBeUndefined();
  });

  it('does not warn for yolo because approvals are automatic', () => {
    for (const mode of ['headless', 'interactive'] as const) {
      const instruction = formatUnavailableApprovalInstruction({
        mode,
        approvalPolicy: 'yolo',
      });

      expect(instruction).toBeUndefined();
    }
  });
});

describe('formatMultiAgentRunInstruction', () => {
  it('reminds the orchestrator to check domain edge cases before claiming completeness', () => {
    for (const mode of ['headless', 'interactive'] as const) {
      for (const approvalPolicy of ['never', 'ask', 'yolo'] as const) {
        const instruction = formatMultiAgentRunInstruction(preset, {
          inputFiles: [],
          instruction: 'Solve x^2 - 2y^2 = 1 for integer x and 0 < y < 20.',
          approvalContext: { mode, approvalPolicy },
        });

        expect(instruction).toContain(
          'check the full domain stated by the user',
        );
        expect(instruction).toContain('sign choices');
        expect(instruction).toContain('zero and boundary cases');
        expect(instruction).toContain('symmetry branches');
      }
    }
  });

  it('warns the orchestrator when approval policy never denies tools', () => {
    const instruction = formatMultiAgentRunInstruction(preset, {
      inputFiles: ['problem.md'],
      instruction: 'Solve the problem.',
      approvalContext: { mode: 'headless', approvalPolicy: 'never' },
    });

    expect(instruction).toContain('Approval policy for this run is "never"');
    expect(instruction).toContain('will be rejected automatically');
    expect(instruction).toContain('Do not call approval-gated tools');
    expect(instruction).toContain('Additional user instruction:');
  });

  it('warns headless ask runs that approval prompts cannot be answered', () => {
    const instruction = formatMultiAgentRunInstruction(preset, {
      inputFiles: [],
      instruction: 'Solve the problem.',
      approvalContext: { mode: 'headless', approvalPolicy: 'ask' },
    });

    expect(instruction).toContain('headless run with approval policy "ask"');
    expect(instruction).toContain('approval prompts cannot be answered');
    expect(instruction).toContain('User instruction:');
  });

  it('does not add approval warnings when yolo can auto-approve', () => {
    const instruction = formatMultiAgentRunInstruction(preset, {
      inputFiles: ['problem.md'],
      instruction: '',
      approvalContext: { mode: 'headless', approvalPolicy: 'yolo' },
    });

    expect(instruction).not.toContain('approval prompts cannot be answered');
    expect(instruction).not.toContain('Do not call approval-gated tools');
  });
});
