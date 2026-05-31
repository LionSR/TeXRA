import { describe, expect, it } from 'vitest';

import {
  agentProposalInstructionDisplayLines,
  agentProposalInstructionRowsBudget,
  boundedAgentProposalInstructionLines,
  maxAgentProposalInstructionScrollOffset,
} from '@cli/chat/tui/modals/AgentProposal';
import { agentProposalCategoryLabel } from '@cli/chat/tui/modals/AgentProposalDisplay';
import { textDisplayWidth } from '@cli/chat/tui/render/terminalText';
import { AGENT_CATEGORY } from '@shared/schemas';

const LONG_AGENT_PROMPT = [
  'Review the mathematical proof in triangular_square_mod5.tex for correctness, completeness, and rigor.',
  '',
  '1. Check the reduction to the Pell equation and every hidden parity assumption.',
  '2. Verify that the recurrence generates every positive solution below the bound.',
  '3. Recompute every square triangular number and the mod 5 filter.',
  '4. Write a structured report with any gaps or a confirmation of correctness.',
].join('\n');

describe('CLI agent proposal approval layout', () => {
  it('uses human-facing category labels', () => {
    expect(agentProposalCategoryLabel(AGENT_CATEGORY.TOOL_USE)).toBe(
      'tool-use agent',
    );
    expect(agentProposalCategoryLabel(AGENT_CATEGORY.WORKFLOW)).toBe(
      'workflow agent',
    );
  });

  it('caps long delegation prompts so the approval footer stays visible', () => {
    const budget = agentProposalInstructionRowsBudget({
      availableRows: 16,
      columns: 80,
      metadataRows: 3,
      title: 'Spawn review?',
    });
    const allRows = agentProposalInstructionDisplayLines({
      instruction: LONG_AGENT_PROMPT,
      width: 76,
    });

    expect(budget).toBe(5);
    expect(allRows.length).toBeGreaterThan(budget);

    const visible = boundedAgentProposalInstructionLines({
      instruction: LONG_AGENT_PROMPT,
      maxDisplayLines: budget,
      width: 76,
    });

    expect(visible).toHaveLength(budget);
    expect(visible.at(-1)).toEqual({
      kind: 'overflow',
      text: '... 5 more rows',
    });
    expect(visible.map((line) => line.text)).not.toContain(
      '4. Write a structured report with any gaps or a confirmation of correctness.',
    );
  });

  it('lets users scroll to the hidden delegation prompt tail', () => {
    const budget = 5;
    const allRows = agentProposalInstructionDisplayLines({
      instruction: LONG_AGENT_PROMPT,
      width: 76,
    });
    const offset = maxAgentProposalInstructionScrollOffset(
      allRows.length,
      budget,
    );
    const visible = boundedAgentProposalInstructionLines({
      instruction: LONG_AGENT_PROMPT,
      maxDisplayLines: budget,
      scrollOffset: offset,
      width: 76,
    });

    expect(visible.at(0)).toEqual({
      kind: 'overflow',
      text: `... ${offset} previous rows`,
    });
    expect(visible.map((line) => line.text).join('\n')).toContain(
      'Write a structured report',
    );
  });

  it('keeps one-row compact previews within their row and column budget', () => {
    const visible = boundedAgentProposalInstructionLines({
      instruction: LONG_AGENT_PROMPT,
      maxDisplayLines: 1,
      width: 40,
    });

    expect(visible).toHaveLength(1);
    expect(visible[0]?.text).toContain('prompt rows hidden');
    expect(textDisplayWidth(visible[0]?.text ?? '')).toBeLessThanOrEqual(40);
  });
});
