// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { createRunTrace, type TexraTrace } from '@logger';

// Local imports - shared
import { MESSAGE_TYPES } from '@shared/schemas';
import type { StreamTabId } from '@shared/schemas';

// Local imports - tools
import { runStreamedTurn } from '@tools/claudeAgent';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@tools/claudeAgentImport', () => ({
  importClaudeAgentSdk: async () => mocks.query,
  findClaudeBinaryPath: () => undefined,
}));

const streamId = 'stream:claude-child' as StreamTabId;

async function* streamMessages(messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) {
    yield message;
  }
}

async function runWithLoggerStore<T>(
  fn: (store: StreamLogStore, logger: TexraTrace) => Promise<T>,
): Promise<T> {
  const previousStore = getDefaultStreamLogStore();
  const store = new StreamLogStore();
  setDefaultStreamLogStore(store);
  await store.clear();

  try {
    return await fn(store, createRunTrace(streamId).trace);
  } finally {
    setDefaultStreamLogStore(previousStore);
  }
}

function collectToolLogs(store: StreamLogStore): unknown[] {
  const log = store.get(streamId);
  const entries = log?.getRange(0, log.head) ?? [];
  return entries
    .filter((entry) => entry.messageType === MESSAGE_TYPES.TOOL_USE)
    .map((entry) => entry.data);
}

function runTurn(logger: TexraTrace) {
  return runStreamedTurn({
    prompt: 'Run lint',
    childStreamId: streamId,
    logger,
    abortController: new AbortController(),
    model: 'claude-sonnet-4-6',
    permissionMode: 'acceptEdits',
    effort: 'high',
    cwd: undefined,
    additionalDirectories: undefined,
    env: {},
    resumeSessionId: undefined,
    pathToClaudeCodeExecutable: undefined,
  });
}

describe('claude agent progress events', () => {
  afterEach(() => {
    mocks.query.mockReset();
  });

  it('updates Claude tool-use logs without dropping the original tool metadata', async () => {
    mocks.query.mockReturnValue(
      streamMessages([
        { type: 'system', subtype: 'init', session_id: 'sess-1' },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Bash',
                input: { command: 'npm run lint' },
              },
              { type: 'text', text: 'I will run lint.' },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-1',
                content: 'lint passed',
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          result: 'Lint passed.',
          usage: { input_tokens: 12, output_tokens: 4 },
          total_cost_usd: 0.01,
        },
      ]),
    );

    await runWithLoggerStore(async (store, logger) => {
      const result = await runTurn(logger);

      expect(result).toMatchObject({
        finalResponse: 'I will run lint.\n\nLint passed.',
        sessionId: 'sess-2',
        usage: { input_tokens: 12, output_tokens: 4 },
        totalCostUsd: 0.01,
        isError: false,
      });

      expect(collectToolLogs(store)).toEqual([
        expect.objectContaining({
          toolName: 'claude:Bash',
          summary: 'npm run lint',
          input: { command: 'npm run lint' },
          output: 'lint passed',
          status: 'completed',
        }),
      ]);
    });
  });

  it('keeps Claude tool-result errors on the completed tool log', async () => {
    mocks.query.mockReturnValue(
      streamMessages([
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'toolu-err',
                name: 'Read',
                input: { file_path: 'missing.tex' },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu-err',
                content: [{ type: 'text', text: 'File not found' }],
                is_error: true,
              },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'error',
          session_id: 'sess-error',
          result: 'Claude failed',
        },
      ]),
    );

    await runWithLoggerStore(async (store, logger) => {
      const result = await runTurn(logger);

      expect(result).toMatchObject({
        sessionId: 'sess-error',
        isError: true,
        errorMessage: 'Claude failed',
      });

      expect(collectToolLogs(store)).toEqual([
        expect.objectContaining({
          toolName: 'claude:Read',
          summary: 'Read missing.tex',
          input: { file_path: 'missing.tex' },
          error: 'File not found',
          isError: true,
          status: 'completed',
        }),
      ]);
    });
  });
});
