import stripAnsi from 'strip-ansi';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allPresets: vi.fn(() => []),
  getAgentsByCategory: vi.fn(),
  loadAgents: vi.fn(),
  readCliAgentRoster: vi.fn(),
}));

vi.mock('@agent/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/index')>()),
  createWorkspaceAgentRosterController: () => ({
    allPresets: mocks.allPresets,
  }),
  getAgentsByCategory: mocks.getAgentsByCategory,
  loadAgents: mocks.loadAgents,
}));

vi.mock('@cli/runtime/agentRoster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agentRoster')>()),
  readCliAgentRoster: mocks.readCliAgentRoster,
}));

import type { AgentEntry } from '@agent/index';
import {
  AgentRosterForm,
  agentRosterSelectWindow,
  buildChatDefaultAgentItems,
  setChatDefaultAgent,
} from '@cli/chat/tui/forms/AgentRosterForm';
import { formatCliAgentRoster } from '@cli/runtime/agentRoster';
import { waitForCondition } from '@test/support/asyncTestUtils';
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadAgents.mockResolvedValue(undefined);
  mocks.getAgentsByCategory.mockImplementation((category: string) =>
    category === 'toolUse' ? agents : [],
  );
  mocks.readCliAgentRoster.mockResolvedValue({
    selection: { kind: 'custom' },
    effectiveSelection: { kind: 'custom' },
    agentKeys: {
      workflow: [],
      toolUse: ['builtInToolUse:assistant'],
    },
    unresolvedNames: [],
  });
});

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

  it('excludes stale hidden keys from custom-selection counts and chat picker', async () => {
    mocks.readCliAgentRoster.mockResolvedValue({
      selection: { kind: 'custom' },
      effectiveSelection: { kind: 'custom' },
      agentKeys: {
        workflow: [],
        toolUse: ['builtInToolUse:assistant', 'builtInToolUse:changeReviewer'],
      },
      unresolvedNames: [],
    });
    const { ink, React } = await loadInk();
    const { instance, stdin, stdout } = renderWithTerminalSize(
      ink,
      React.createElement(AgentRosterForm, { onClose: () => undefined }),
      80,
      24,
      { debug: true },
    );

    try {
      await waitForCondition(() =>
        stripAnsi(stdout.output).includes('0 workflow, 1 tool-use'),
      );
      stdin.write('3');
      await waitForCondition(() =>
        stripAnsi(stdout.output).includes('Automatic'),
      );

      const output = stripAnsi(stdout.output);
      expect(output).toContain('0 workflow, 1 tool-use');
      expect(output).not.toContain('2 tool-use');
      expect(output).toContain('assistant');
      expect(output).not.toContain('changeReviewer');
    } finally {
      instance.unmount();
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
