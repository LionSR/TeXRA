/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

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
import { loadChatExportInput } from '@agent/export/loadChatExportInput';

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

const CONVERSATION = [
  { role: 'user', content: 'Polish the lemma.' },
  { role: 'assistant', content: 'Done.' },
];

describe('loadChatExportInput (shared CLI/extension chat-export loader)', () => {
  beforeEach(() => {
    mocks.readConfig.mockResolvedValue(null);
    mocks.readConversation.mockResolvedValue(null);
    mocks.readMeta.mockResolvedValue(null);
  });

  it('assembles a ChatExportInput when config and a non-empty conversation are both present', async () => {
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue(CONVERSATION);
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      description: 'Polish pass',
    });

    const result = await loadChatExportInput('a1' as ExecutionId);

    expect(result.exportInput).toEqual({
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
      messages: CONVERSATION,
    });
    expect(result.conversation).toEqual(CONVERSATION);
    expect(result.hasTranscriptEvidence).toBe(true);
  });

  it('returns a null exportInput when nothing is stored at all', async () => {
    const result = await loadChatExportInput('missing' as ExecutionId);

    expect(result).toEqual({
      meta: null,
      config: null,
      conversation: null,
      hasTranscriptEvidence: false,
      exportInput: null,
    });
  });

  it('normalizes a stored-but-empty conversation array to null, matching "no conversation"', async () => {
    // An empty array is truthy in JS (`![]` is `false`) — a naive presence
    // check on the raw store value would treat it as "a conversation is
    // present". Every caller (CLI not_found/incomplete, extension
    // config_missing/conversation_missing) needs `conversation`/`exportInput`
    // to already reflect "absent" for this case, not just falsy-vs-array.
    mocks.readConversation.mockResolvedValue([]);

    const result = await loadChatExportInput('missing' as ExecutionId);

    expect(result.conversation).toBeNull();
    expect(result.exportInput).toBeNull();
  });

  it('reports a null exportInput when config is present but the conversation is empty', async () => {
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue([]);

    const result = await loadChatExportInput('a1' as ExecutionId);

    expect(result.config).toEqual(config);
    expect(result.conversation).toBeNull();
    expect(result.exportInput).toBeNull();
  });

  it('reports a null exportInput when conversation is present but config is missing', async () => {
    mocks.readConversation.mockResolvedValue([{ role: 'user', content: 'hi' }]);

    const result = await loadChatExportInput('a1' as ExecutionId);

    expect(result.config).toBeNull();
    expect(result.exportInput).toBeNull();
  });
});
