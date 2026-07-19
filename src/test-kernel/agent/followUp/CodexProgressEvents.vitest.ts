// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { TraceEmitter } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type {
  ExecutionId,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { MESSAGE_TYPES } from '@shared/schemas';
import { publishAgentCliStreamUsage } from '@tools/agentCliShared';
import { publishCodexTodos, runStreamedTurn } from '@tools/codex';
import { createRunTrace, StreamLogStore } from '@transcript';

// Local file imports
import { recordSessionEvents, runEventsOfType } from '../progressTestUtils';

// Third-party imports
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
  it('publishes todos and usage as run facts', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const recorded = recordSessionEvents(hub, { scope: 'run' });
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );

    publishCodexTodos(streamId, todos, trace);
    publishAgentCliStreamUsage(streamId, executionId, usage, trace);

    expect(runEventsOfType(recorded.events, 'updateTodos')).toMatchObject([
      {
        streamId,
        todos,
      },
    ]);
    expect(runEventsOfType(recorded.events, 'usage')).toMatchObject([
      {
        payload: {
          streamId,
          storageKey: executionId,
          executionId,
          usage,
        },
      },
    ]);

    recorded.detach();
    detachTrace();
  });

  it('updates in-flight Codex command items in place', async () => {
    const store = StreamLogStore.ephemeral('test');
    await store.clear();

    const logger = createRunTrace(streamId, store).trace;
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

    const result = await runStreamedTurn(
      thread,
      'Build the project',
      streamId,
      logger,
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
  });
});
