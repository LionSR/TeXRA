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
  it('renders loading through the shared Ink indicator', async () => {
    const { ink, React } = await loadInk();
    vi.useFakeTimers();
    const { instance, stdout } = renderWithTerminalSize(
      ink,
      React.createElement(AgentRosterForm, { onClose: () => undefined }),
      80,
    );

    try {
      await vi.advanceTimersByTimeAsync(100);
      const loadingLines = stripAnsi(stdout.output)
        .split('\n')
        .filter((line) => line.includes('Loading agents...'));
      const loadingCopy = loadingLines[0]
        ?.replace(/^│\s*/, '')
        .replace(/\s*│$/, '');

      expect(loadingLines).toHaveLength(1);
      expect(loadingCopy).toMatch(/^[|/\\-] Loading agents\.\.\.$/);
    } finally {
      instance.unmount();
      vi.useRealTimers();
    }
  });

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
