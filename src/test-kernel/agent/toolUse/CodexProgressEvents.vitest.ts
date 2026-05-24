// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - agent
import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';

import { createRunTrace } from '@logger';

// Local imports - shared
import { MESSAGE_TYPES } from '@shared/schemas';
import type {
  ExecutionId,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';

// Local imports - tools
import {
  publishCodexStreamUsage,
  publishCodexTodos,
  runStreamedTurn,
} from '@tools/codex';

// Local imports - test
import { createRecordingHost } from '../progressTestUtils';

// Type-only imports
import type {
  CommandExecutionItem,
  Thread,
  ThreadEvent,
} from '@openai/codex-sdk';

const streamId = 'stream:codex-child' as StreamTabId;
const executionId = 'exec:codex-child' as ExecutionId;

const todos: TodoItem[] = [
  {
    content: 'Route Codex progress through the runtime host',
    status: 'pending',
    activeForm: 'Routing Codex progress through the runtime host',
  },
];

const usage: TokenUsageStats = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0,
};

async function* streamEvents(
  events: ThreadEvent[],
): AsyncGenerator<ThreadEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('codex progress events', () => {
  it('publishes todos and usage through the explicit runtime host', () => {
    const active = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    setDefaultAgentRuntimeHost(fallback.host);

    try {
      publishCodexTodos(streamId, todos, active.host);
      publishCodexStreamUsage(streamId, executionId, usage, active.host);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }

    expect(active.events).toEqual([
      {
        event: 'updateTodos',
        payload: { streamId, todos },
      },
      {
        event: 'updateStreamUsage',
        payload: {
          streamId,
          storageKey: executionId,
          executionId,
          usage,
        },
      },
    ]);
    expect(fallback.events).toEqual([]);
  });

  it('updates in-flight Codex command items in place', async () => {
    const previousStore = getDefaultStreamLogStore();
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    await store.clear();

    const logger = createRunTrace(streamId).trace;
    const runtime = createRecordingHost();
    const startedCommand: CommandExecutionItem = {
      id: 'cmd-1',
      type: 'command_execution',
      command: 'npm run build',
      aggregated_output: '',
      status: 'in_progress',
    };
    const updatedCommand: CommandExecutionItem = {
      ...startedCommand,
      aggregated_output: 'building...',
    };
    const completedCommand: CommandExecutionItem = {
      ...startedCommand,
      aggregated_output: 'building...\ndone\n',
      exit_code: 0,
      status: 'completed',
    };
    const thread = {
      runStreamed: async () => ({
        events: streamEvents([
          { type: 'item.started', item: startedCommand },
          { type: 'item.updated', item: updatedCommand },
          { type: 'item.completed', item: completedCommand },
          {
            type: 'item.completed',
            item: {
              id: 'msg-1',
              type: 'agent_message',
              text: 'Build succeeded.',
            },
          },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 12,
              cached_input_tokens: 0,
              output_tokens: 4,
              reasoning_output_tokens: 0,
            },
          },
        ]),
      }),
    } as unknown as Thread;

    try {
      const result = await runStreamedTurn(
        thread,
        'Build the project',
        streamId,
        logger,
        runtime.host,
      );

      expect(result.finalResponse).toBe('Build succeeded.');

      const log = store.get(streamId);
      const entries = log?.getRange(0, log.head) ?? [];
      const toolEntries = entries.filter(
        (entry) => entry.messageType === MESSAGE_TYPES.TOOL_USE,
      );

      expect(toolEntries).toHaveLength(1);
      expect(toolEntries[0].data).toMatchObject({
        toolName: 'bash',
        summary: 'npm run build',
        input: { command: 'npm run build' },
        output: 'building...\ndone',
        status: 'completed',
      });
    } finally {
      setDefaultStreamLogStore(previousStore);
    }
  });
});
