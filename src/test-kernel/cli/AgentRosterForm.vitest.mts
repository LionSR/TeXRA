import { describe, expect, it } from 'vitest';

import type { AgentEntry } from '@agent/index';
import {
  agentRosterSelectWindow,
  buildChatDefaultAgentItems,
  selectedAgentKeys,
  setChatDefaultAgent,
} from '@cli/chat/tui/forms/AgentRosterForm';
import { formatCliAgentRoster } from '@cli/runtime/agentRoster';

const agents: AgentEntry[] = [
  {
    category: 'toolUse',
    source: 'builtInToolUse',
    name: 'assistant',
    description: 'General assistant',
    path: '/agents/assistant.yaml',
  },
  {
    category: 'toolUse',
    source: 'custom',
    name: 'review',
    description: 'Review agent',
    path: '/agents/review.yaml',
  },
];

describe('AgentRosterForm', () => {
  it('offers chat defaults only from the effective tool-use roster', () => {
    expect(
      buildChatDefaultAgentItems(agents, ['builtInToolUse:assistant']),
    ).toEqual([
      {
        value: '',
        label: 'Automatic',
        description: 'Choose from the effective workspace roster',
      },
      {
        value: 'builtInToolUse:assistant',
        label: 'assistant',
        description: 'General assistant',
      },
    ]);
  });

  it('resolves legacy bare selections to the catalog identity', () => {
    expect(selectedAgentKeys(['assistant'], agents)).toEqual([
      'builtInToolUse:assistant',
    ]);
  });

  it('windows long roster lists to the available terminal rows', () => {
    expect(
      agentRosterSelectWindow({ availableRows: 10, itemCount: 20 }),
    ).toEqual({ maxVisibleItems: 3, showOverflow: true });
    expect(
      agentRosterSelectWindow({ availableRows: undefined, itemCount: 20 }),
    ).toEqual({ maxVisibleItems: undefined, showOverflow: false });
  });

  it('rejects default-chat selection when there is no workspace', async () => {
    await expect(
      setChatDefaultAgent(undefined, 'builtInToolUse:assistant'),
    ).rejects.toThrow('Default chat-agent selection requires a workspace.');
  });

  it('reports open categories without materializing the current catalog', () => {
    expect(
      formatCliAgentRoster({
        selection: { kind: 'all' },
        effectiveSelection: { kind: 'all' },
        workflowAgentKeys: 'all',
        toolUseAgentKeys: ['future-assistant'],
        unresolvedNames: ['future-assistant'],
      }),
    ).toContain('Workflow agents: all');
  });
});
