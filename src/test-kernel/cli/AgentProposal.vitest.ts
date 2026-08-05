import { describe, expect, it } from 'vitest';

import { agentProposalMetadataRows } from '@cli/chat/tui/modals/AgentProposal';
import {
  boundedModalTextLines,
  modalTextDisplayLines,
  scrollableModalTextRowsBudget,
} from '@cli/chat/tui/modals/ScrollableModalText';
import {
  AgentCategory,
  agentProposalCategoryLabel,
  type AgentProposalPermission,
} from '@shared/schemas';

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
    expect(agentProposalCategoryLabel(AgentCategory.ToolUse)).toBe(
      'tool-use agent',
    );
    expect(agentProposalCategoryLabel(AgentCategory.Workflow)).toBe(
      'workflow agent',
    );
  });

  it('counts metadata rows against the shared prompt budget', () => {
    const metadataRows = agentProposalMetadataRows({
      fileGroups: [],
      payload: {
        agent: 'review',
        agentCategory: AgentCategory.ToolUse,
        instruction: LONG_AGENT_PROMPT,
        model: 'deepseekT',
      } as unknown as AgentProposalPermission,
      width: 76,
    });
    const budget = scrollableModalTextRowsBudget({
      availableRows: 16,
      columns: 80,
      extraFixedRows: metadataRows,
      title: 'Spawn review?',
    });
    const allRows = modalTextDisplayLines({
      text: LONG_AGENT_PROMPT,
      width: 76,
    });

    expect(metadataRows).toBe(4);
    expect(budget).toBe(4);
    expect(allRows.length).toBeGreaterThan(budget);

    const visible = boundedModalTextLines({
      hiddenNoun: 'prompt rows',
      lines: allRows,
      maxRows: budget,
      width: 76,
    });
    expect(visible).toHaveLength(budget);
    expect(visible.at(-1)?.kind).toBe('overflow');
  });

  it('includes the pulse prefix when a dynamic proposal title reaches the width boundary', () => {
    const title = `Spawn ${'a'.repeat(57)}?`;
    expect(title).toHaveLength(64);

    expect(
      scrollableModalTextRowsBudget({
        availableRows: 16,
        columns: 68,
        extraFixedRows: 3,
        title,
      }),
    ).toBe(4);
  });
});
