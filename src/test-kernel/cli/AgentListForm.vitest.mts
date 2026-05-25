import { describe, expect, it } from 'vitest';

import { agentSelectWindow } from '@cli/chat/tui/forms/AgentListForm';

describe('CLI AgentListForm row budget', () => {
  it('windows long agent lists inside the available foreground rows', () => {
    expect(
      agentSelectWindow({
        availableRows: 12,
        itemCount: 12,
        workflowCount: 10,
      }),
    ).toEqual({
      maxVisibleItems: 2,
      showOverflow: true,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    });
  });

  it('shows workflows only when the row budget has room for them', () => {
    expect(
      agentSelectWindow({
        availableRows: 24,
        itemCount: 6,
        workflowCount: 3,
      }),
    ).toEqual({
      maxVisibleItems: 6,
      showOverflow: false,
      maxVisibleWorkflows: 3,
      showWorkflowOverflow: false,
    });
  });
});
