import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import { AgentCategory } from '@shared/schemas/agent';

const mocks = vi.hoisted(() => ({
  listRuntimeHistoryExecutions: vi.fn(),
  readRuntimeHistoryWorkspaceFilePaths: vi.fn(),
}));

vi.mock('@agent/runtime/historyCommands', () => ({
  listRuntimeHistoryExecutions: mocks.listRuntimeHistoryExecutions,
  readRuntimeHistoryWorkspaceFilePaths:
    mocks.readRuntimeHistoryWorkspaceFilePaths,
}));

describe('settings history handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRuntimeHistoryWorkspaceFilePaths.mockResolvedValue([]);
  });

  it('includes persisted edited files for tool-use history items', async () => {
    mocks.listRuntimeHistoryExecutions.mockResolvedValue([
      {
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        agentConfig: {
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          agentCategory: AgentCategory.ToolUse,
        },
        category: 'toolUse',
      },
    ]);
    mocks.readRuntimeHistoryWorkspaceFilePaths.mockResolvedValue([
      'proofs/lemma.md',
    ]);

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
    expect(mocks.readRuntimeHistoryWorkspaceFilePaths).toHaveBeenCalledWith(
      'abc123',
    );
  });
});
