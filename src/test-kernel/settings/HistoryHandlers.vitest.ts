import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import { AgentCategory } from '@shared/schemas/agent';

const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  readWorkspaceFiles: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    getExecutionStore: vi.fn(() => ({
      readWorkspaceFiles: mocks.readWorkspaceFiles,
    })),
    listExecutions: mocks.listExecutions,
  };
});

describe('settings history handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  it('includes persisted edited files for tool-use history items', async () => {
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        agentConfig: {
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          agentCategory: AgentCategory.ToolUse,
        },
      },
    ]);
    mocks.readWorkspaceFiles.mockResolvedValue(['proofs/lemma.md']);

    const message = await buildHistoryMessage();

    expect(message.historyItems).toEqual([
      {
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        agentConfig: {
          agentCategory: 'toolUse',
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          editedFiles: ['proofs/lemma.md'],
        },
        description: undefined,
      },
    ]);
  });

  it('hides internal process-bookkeeping and configless entries', async () => {
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        agentConfig: {
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          agentCategory: AgentCategory.ToolUse,
        },
      },
      {
        kind: 'process',
        id: 'bash-process',
        timestamp: '2026-05-31T12:01:00.000Z',
        agentConfig: {
          agent: 'bash',
          model: 'deepseekT',
          instruction: 'ls -la',
          agentCategory: AgentCategory.ToolUse,
        },
      },
      {
        kind: 'incomplete',
        id: 'configless',
        timestamp: '2026-05-31T12:02:00.000Z',
      },
    ]);

    const message = await buildHistoryMessage();

    expect(message.historyItems.map((item) => item.id)).toEqual(['abc123']);
  });
});
