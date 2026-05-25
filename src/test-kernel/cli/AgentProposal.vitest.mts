import { describe, expect, it } from 'vitest';

import { agentProposalCategoryLabel } from '@cli/chat/tui/modals/AgentProposalDisplay';
import { AGENT_CATEGORY } from '@shared/schemas';

describe('CLI AgentProposal display model', () => {
  it('uses human-facing category labels', () => {
    expect(agentProposalCategoryLabel(AGENT_CATEGORY.TOOL_USE)).toBe(
      'tool-use agent',
    );
    expect(agentProposalCategoryLabel(AGENT_CATEGORY.WORKFLOW)).toBe(
      'workflow agent',
    );
  });
});
