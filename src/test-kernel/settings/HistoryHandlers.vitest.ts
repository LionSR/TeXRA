import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_CATEGORY } from '@shared/schemas/agent';

const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  readWorkspaceFiles: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    readWorkspaceFiles: mocks.readWorkspaceFiles,
  })),
  listExecutions: mocks.listExecutions,
}));

import { buildHistoryMessage } from '@shared/settingsView/handlers/historyHandlers';

describe('settings history handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  it('includes persisted edited files for tool-use history items', async () => {
    mocks.listExecutions.mockResolvedValue([
      {
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        agentConfig: {
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          agentCategory: AGENT_CATEGORY.TOOL_USE,
        },
        category: 'toolUse',
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
});
