import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import { AgentCategory } from '@shared/schemas/agent';

const mocks = vi.hoisted(() => ({
  listRuntimeHistoryExecutions: vi.fn(),
  readRuntimeHistoryExecutionRecord: vi.fn(),
}));

vi.mock('@agent/runtime/historyCommands', () => ({
  listRuntimeHistoryExecutions: mocks.listRuntimeHistoryExecutions,
  readRuntimeHistoryExecutionRecord: mocks.readRuntimeHistoryExecutionRecord,
}));

describe('settings history handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRuntimeHistoryExecutionRecord.mockResolvedValue({
      workspaceFilePaths: [],
    });
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
    mocks.readRuntimeHistoryExecutionRecord.mockResolvedValue({
      workspaceFilePaths: ['proofs/lemma.md'],
    });

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
    expect(mocks.readRuntimeHistoryExecutionRecord).toHaveBeenCalledWith(
      'abc123',
    );
  });
});
