/* eslint-disable import/order -- Vitest mocks must be declared before importing the module under test. */
import { Effect } from 'effect';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { emptySessionView } from '@shared/session/sessionView';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readConversation: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getRunRecords: vi.fn(() => ({
    readConfig: () => Effect.promise(() => mocks.readConfig()),
  })),
}));

vi.mock('@transcript', () => ({
  hasCompletedRunConversationEvidence: vi.fn(
    ({ conversation }: { conversation: unknown[] | null }) =>
      (conversation?.length ?? 0) > 0,
  ),
  readCompletedRunConversation: vi.fn(() =>
    Effect.promise(async () => {
      const conversation = await mocks.readConversation();
      return {
        conversation,
        source: conversation === null ? 'none' : 'streamLog',
      };
    }),
  ),
}));

// Imported after vi.mock so the mocked dependency is in place.
import { loadChatExportInput as loadChatExportInputEffect } from '@agent/export/loadChatExportInput';

// The run itself comes from the session's cold fold; these cases are about
// the config/conversation triple, so the view holds no run.
const session = {
  readView: (_runIds: readonly RunId[]) =>
    Effect.succeed(emptySessionView('export-test')),
} as SessionHandle;

const loadChatExportInput = (id: RunId) =>
  Effect.runPromise(loadChatExportInputEffect(id, session));

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

describe('loadChatExportInput (shared CLI/extension chat-export loader)', () => {
  beforeEach(() => {
    mocks.readConfig.mockResolvedValue(null);
    mocks.readConversation.mockResolvedValue(null);
  });

  it('normalizes a stored-but-empty conversation array to null, matching "no conversation"', async () => {
    // An empty array is truthy in JS (`![]` is `false`) — a naive presence
    // check on the raw store value would treat it as "a conversation is
    // present". Every caller (CLI not_found/incomplete, extension
    // config_missing/conversation_missing) needs `conversation`/`exportInput`
    // to already reflect "absent" for this case, not just falsy-vs-array.
    mocks.readConversation.mockResolvedValue([]);

    const result = await loadChatExportInput('missing' as RunId);

    expect(result.conversation).toBeNull();
    expect(result.exportInput).toBeNull();
  });

  it('reports a null exportInput when conversation is present but config is missing', async () => {
    mocks.readConversation.mockResolvedValue([
      { kind: 'assistant-text', text: 'hi' },
    ]);

    const result = await loadChatExportInput('a1' as RunId);

    expect(result.config).toBeNull();
    expect(result.exportInput).toBeNull();
  });
});
