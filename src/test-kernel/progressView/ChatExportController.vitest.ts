/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readConversation: vi.fn(),
  readMeta: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    readConfig: mocks.readConfig,
    readMeta: mocks.readMeta,
  })),
}));

vi.mock('@transcript', () => ({
  hasCompletedRunConversationEvidence: vi.fn(
    ({ conversation }: { conversation: unknown[] | null }) =>
      (conversation?.length ?? 0) > 0,
  ),
  readCompletedRunConversation: vi.fn(async () => {
    const conversation = await mocks.readConversation();
    return {
      conversation,
      source: conversation === null ? 'none' : 'streamLog',
    };
  }),
}));

// Imported after vi.mock so the mocked dependency is in place.
import { ChatExportController } from '@controllers/progressView/ChatExportController';

const config = {
  agent: 'correct',
  model: 'deepseekT',
  instruction: 'Polish the introduction.',
  agentCategory: 'workflow',
  inputFiles: ['chapters/intro.tex'],
  outputFiles: ['chapters/intro.tex'],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  editedFiles: [],
  memories: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
} as AgentConfig;

describe('ChatExportController.buildExportInput', () => {
  const controller = new ChatExportController({ latexPreamble: '' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue(null);
    mocks.readConversation.mockResolvedValue(null);
    mocks.readMeta.mockResolvedValue(null);
  });

  it('builds export input from the stored config, conversation, and meta', async () => {
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue([
      { role: 'user', content: 'Polish the lemma.' },
      { role: 'assistant', content: 'Done.' },
    ]);
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      description: 'Polish pass',
    });

    const result = await controller.buildExportInput('a1');

    expect(result).toEqual({
      status: 'ok',
      exportInput: {
        timestamp: '2026-05-18T08:00:00.000Z',
        description: 'Polish pass',
        config: {
          agent: 'correct',
          model: 'deepseekT',
          instruction: 'Polish the introduction.',
          inputFiles: ['chapters/intro.tex'],
          mediaFiles: [],
          contextFiles: [],
          outputFiles: ['chapters/intro.tex'],
        },
        messages: [
          { role: 'user', content: 'Polish the lemma.' },
          { role: 'assistant', content: 'Done.' },
        ],
      },
    });
  });

  it('reports "config_missing" when nothing is stored at all', async () => {
    await expect(controller.buildExportInput('missing')).resolves.toEqual({
      status: 'config_missing',
    });
  });

  it('reports "conversation_missing" when config exists but conversation does not', async () => {
    mocks.readConfig.mockResolvedValue(config);

    await expect(controller.buildExportInput('a1')).resolves.toEqual({
      status: 'conversation_missing',
    });
  });

  it('reports "conversation_missing" (not "ok") when the stored conversation is only an empty array', async () => {
    // A stored-but-empty conversation array is truthy — this must not be
    // mistaken for "a conversation is present" (matches the CLI's
    // not_found/incomplete reconciliation for the same underlying case).
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue([]);

    await expect(controller.buildExportInput('a1')).resolves.toEqual({
      status: 'conversation_missing',
    });
  });
});
