// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { type AgentTrace, TraceEmitter } from '@agent/trace';
import {
  MESSAGE_TYPES,
  CODEX_THREAD_TOOL,
  CODEX_TURN_TOOL,
} from '@shared/schemas';
import type { RunId, TodoItem } from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import { publishCodexTodos, runStreamedTurn } from '@tools/codex';

// Local file imports
import { recordTraceEvents, traceEventsOfType } from '../progressTestUtils';
import type {
  CommandExecutionItem,
  Thread,
  ThreadEvent,
} from '@openai/codex-sdk';

const runId = 'run:codex-child' as RunId;

const todos: TodoItem[] = [
  {
    content: 'Route Codex progress through the runtime host',
    status: 'pending',
    activeForm: 'Routing Codex progress through the runtime host',
  },
];

async function* streamEvents(
  events: ThreadEvent[],
): AsyncGenerator<ThreadEvent> {
  yield* events;
}

async function createLogger(): Promise<{
  store: StreamLog;
  logger: AgentTrace;
}> {
  const store = new StreamLog();

  return { store, logger: createTestRunTrace(runId, store).trace };
}

function turnCompleted(inputTokens: number, outputTokens: number): ThreadEvent {
  return {
    type: 'turn.completed',
    usage: {
      input_tokens: inputTokens,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: outputTokens,
      reasoning_output_tokens: 0,
    },
  };
}

function threadOf(events: ThreadEvent[]): Thread {
  return {
    runStreamed: async () => ({ events: streamEvents(events) }),
  } as unknown as Thread;
}

function toolLogs(store: StreamLog): Record<string, unknown>[] {
  const entries = store.getRange(0, store.head);
  return entries
    .filter((entry) => entry.messageType === MESSAGE_TYPES.TOOL_USE)
    .map((entry) => entry.data as Record<string, unknown>);
}

describe('codex progress events', () => {
  it('publishes todos as run facts', () => {
    const trace = new TraceEmitter();
    const recorded = recordTraceEvents(trace);

    publishCodexTodos(todos, trace);

    expect(traceEventsOfType(recorded.events, 'updateTodos')).toMatchObject([
      { todos },
    ]);
  });

  it('updates in-flight Codex command items in place', async () => {
    const { store, logger } = await createLogger();
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
    const thread = threadOf([
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
      turnCompleted(12, 4),
    ]);

    const result = await runStreamedTurn(
      thread,
      'Build the project',
      runId,
      logger,
    );

    expect(result.finalResponse).toBe('Build succeeded.');

    const logs = toolLogs(store);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      toolName: 'bash',
      summary: 'npm run build',
      input: { command: 'npm run build' },
      output: 'building...\ndone',
      status: 'completed',
    });
  });

  it('emits Codex thread and turn cards across the turn lifecycle', async () => {
    const { store, logger } = await createLogger();
    const thread = threadOf([
      { type: 'thread.started', thread_id: 'thread_abc' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'msg-1', type: 'agent_message', text: 'Done.' },
      },
      turnCompleted(5, 2),
    ]);

    const result = await runStreamedTurn(thread, 'Do the thing', runId, logger);

    expect(result.finalResponse).toBe('Done.');

    const logs = toolLogs(store);

    // A one-shot thread card, then a running->completed turn card.
    expect(logs.map((data) => data.toolName)).toEqual([
      CODEX_THREAD_TOOL,
      CODEX_TURN_TOOL,
    ]);

    expect(logs[0]).toMatchObject({
      toolName: CODEX_THREAD_TOOL,
      input: { threadId: 'thread_abc' },
      status: 'completed',
    });

    expect(logs[1]).toMatchObject({
      toolName: CODEX_TURN_TOOL,
      input: { state: 'completed' },
      status: 'completed',
    });

    const turnInput = (logs[1] as { input?: { wallTimeMs?: number } }).input;
    expect(typeof turnInput?.wallTimeMs).toBe('number');
  });

  it('finalizes the running turn card when the stream errors', async () => {
    const { store, logger } = await createLogger();
    const thread = threadOf([
      { type: 'turn.started' },
      { type: 'error', message: 'boom' },
    ]);

    await expect(
      runStreamedTurn(thread, 'Do the thing', runId, logger),
    ).rejects.toThrow('boom');

    const turnEntry = findTurnEntry(store);
    expect(turnEntry).toMatchObject({
      toolName: CODEX_TURN_TOOL,
      input: { state: 'failed' },
      error: 'boom',
      status: 'failed',
    });
  });

  it('finalizes the running turn card when the stream ends without a terminal turn event', async () => {
    const { store, logger } = await createLogger();
    // No turn.completed / turn.failed — the loop exits with the card open.
    const thread = threadOf([{ type: 'turn.started' }]);

    await runStreamedTurn(thread, 'Do the thing', runId, logger);

    const turnEntry = findTurnEntry(store);
    // Even without an error message the card is failed so the progress view
    // renders failure chrome instead of a success check.
    expect(turnEntry).toMatchObject({
      toolName: CODEX_TURN_TOOL,
      input: { state: 'failed' },
      status: 'failed',
    });
    expect(turnEntry).not.toHaveProperty('error');
  });
});

function findTurnEntry(store: StreamLog): Record<string, unknown> | undefined {
  return toolLogs(store).find((data) => data.toolName === CODEX_TURN_TOOL);
}
