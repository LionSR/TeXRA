import { beforeEach, describe, expect, it, vi } from 'vitest';

const historyMocks = vi.hoisted(() => ({
  readRuntimeHistoryExecutionRecord: vi.fn(),
}));

vi.mock('@agent/runtime/historyCommands', () => ({
  readRuntimeHistoryExecutionRecord:
    historyMocks.readRuntimeHistoryExecutionRecord,
}));

import { ChatExportController } from '@controllers/settingsView/ChatExportController';
import type { ExecutionId } from '@shared/schemas';

describe('ChatExportController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds export input from a runtime history record', async () => {
    historyMocks.readRuntimeHistoryExecutionRecord.mockResolvedValue({
      meta: {
        timestamp: '2026-06-27T10:00:00.000Z',
        description: 'A proof discussion',
      },
      config: {
        agent: 'proof',
        model: 'deepseekT',
        instruction: 'Check the lemma.',
        inputFiles: ['main.tex'],
        mediaFiles: ['diagram.png'],
        contextFiles: ['notes.md'],
        outputFiles: ['report.md'],
      },
      conversation: [{ role: 'user', content: 'Please check this.' }],
    });

    const result = await new ChatExportController().buildExportInput(
      'abcdef123456',
    );

    expect(result).toEqual({
      status: 'ok',
      exportInput: {
        timestamp: '2026-06-27T10:00:00.000Z',
        description: 'A proof discussion',
        config: {
          agent: 'proof',
          model: 'deepseekT',
          instruction: 'Check the lemma.',
          inputFiles: ['main.tex'],
          mediaFiles: ['diagram.png'],
          contextFiles: ['notes.md'],
          outputFiles: ['report.md'],
        },
        messages: [{ role: 'user', content: 'Please check this.' }],
      },
    });
    expect(historyMocks.readRuntimeHistoryExecutionRecord).toHaveBeenCalledWith(
      'abcdef123456' as ExecutionId,
    );
  });

  it('reports missing config before constructing export input', async () => {
    historyMocks.readRuntimeHistoryExecutionRecord.mockResolvedValue({
      meta: null,
      config: null,
      conversation: [{ role: 'user', content: 'Hello.' }],
    });

    await expect(
      new ChatExportController().buildExportInput('abcdef123456'),
    ).resolves.toEqual({ status: 'config_missing' });
  });

  it('reports missing conversation before constructing export input', async () => {
    historyMocks.readRuntimeHistoryExecutionRecord.mockResolvedValue({
      meta: null,
      config: {
        agent: 'proof',
        model: 'deepseekT',
        instruction: 'Check the lemma.',
      },
      conversation: null,
    });

    await expect(
      new ChatExportController().buildExportInput('abcdef123456'),
    ).resolves.toEqual({ status: 'conversation_missing' });
  });
});
