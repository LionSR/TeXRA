import stripAnsi from 'strip-ansi';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index';
import {
  AgentRosterForm,
  buildChatDefaultAgentItems,
} from '@cli/chat/tui/forms/AgentRosterForm';
import { formatCliAgentRoster } from '@cli/runtime/agentRoster';
import {
  loadInk,
  renderWithTerminalSize,
} from '@test/support/inkTestHarness.ts';

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
  it('reports open categories without materializing the current catalog', () => {
    const output = formatCliAgentRoster({
      selection: { kind: 'team', teamId: 'deleted-team' },
      effectiveSelection: { kind: 'all' },
      missingTeamId: 'deleted-team',
      agentKeys: {
        workflow: 'all',
        toolUse: ['future-assistant'],
      },
      unresolvedNames: ['future-assistant'],
    });

    expect(output).toContain('Workflow agents: all');
    expect(output).toContain(
      'Unavailable team: deleted-team; showing all agents instead',
    );
  });
});
