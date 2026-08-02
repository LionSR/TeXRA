import stripAnsi from 'strip-ansi';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEntry } from '@agent/index';
import {
  AgentRosterForm,
  agentRosterSelectWindow,
  buildChatDefaultAgentItems,
  selectedAgentKeys,
  setChatDefaultAgent,
} from '@cli/chat/tui/forms/AgentRosterForm';
import { formatCliAgentRoster } from '@cli/runtime/agentRoster';
import {
  loadInk,
  renderWithTerminalSize,
} from '@test/support/inkTestHarness.mts';

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

const agentsWithDuplicateName: AgentEntry[] = [
  ...agents,
  {
    category: 'toolUse',
    source: 'remote',
    name: 'review',
    description: 'Remote review agent',
    path: '',
  },
];

const selectedAgentKeyCases: Array<{
  name: string;
  selection: 'all' | string[];
  catalog: AgentEntry[];
  expected: string[];
}> = [
  {
    name: 'expands all to the catalog keys',
    selection: 'all',
    catalog: agents,
    expected: ['builtInToolUse:assistant', 'custom:review'],
  },
  {
    name: 'deduplicates bare and source-qualified aliases',
    selection: ['assistant', 'builtInToolUse:assistant'],
    catalog: agents,
    expected: ['builtInToolUse:assistant'],
  },
  {
    name: 'preserves unknown bare and source-qualified identifiers',
    selection: ['future', 'remote:future'],
    catalog: agents,
    expected: ['future', 'remote:future'],
  },
  {
    name: 'resolves an exact remote source key',
    selection: ['remote:review'],
    catalog: agentsWithDuplicateName,
    expected: ['remote:review'],
  },
  {
    name: 'leaves category-like qualified identifiers unresolved',
    selection: ['toolUse:assistant'],
    catalog: agents,
    expected: ['toolUse:assistant'],
  },
  {
    name: 'uses the first same-name agent for bare names and retains exact identities',
    selection: ['review', 'remote:review', 'custom:review'],
    catalog: agentsWithDuplicateName,
    expected: ['custom:review', 'remote:review'],
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
        .filter((line) => line.includes('Loading agent roster...'));
      const loadingCopy = loadingLines[0]
        ?.replace(/^│\s*/, '')
        .replace(/\s*│$/, '');

      expect(loadingLines).toHaveLength(1);
      expect(loadingCopy).toMatch(/^[|/\\-] Loading agent roster\.\.\.$/);
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

  it.each(selectedAgentKeyCases)(
    '$name',
    ({ selection, catalog, expected }) => {
      expect(selectedAgentKeys(selection, catalog)).toEqual(expected);
    },
  );

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
    const output = formatCliAgentRoster({
      selection: { kind: 'team', teamId: 'deleted-team' },
      effectiveSelection: { kind: 'all' },
      missingTeamId: 'deleted-team',
      workflowAgentKeys: 'all',
      toolUseAgentKeys: ['future-assistant'],
      unresolvedNames: ['future-assistant'],
    });

    expect(output).toContain('Workflow agents: all');
    expect(output).toContain(
      'Unavailable team: deleted-team; showing all agents instead',
    );
  });
});
