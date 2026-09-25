// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { MESSAGE_TYPES, CODEX_TURN_TOOL } from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { StreamLog } from '@shared/session/traceEntries';
import { createTestRunTrace } from '@test/support/sessionTestUtils';
import { runStreamedTurn } from '@tools/codex';

// Local file imports
import { recordTraceEvents, runFactsOfKey } from '../progressTestUtils';
import type {
  CommandExecutionItem,
  Thread,
  ThreadEvent,
} from '@openai/codex-sdk';

const runId = 'run:codex-child' as RunId;

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
  const entries = store.toJSON();
  return entries
    .filter((entry) => entry.messageType === MESSAGE_TYPES.TOOL_USE)
    .map((entry) => entry.data as Record<string, unknown>);
}

describe('codex progress events', () => {
  it.effect('publishes a todo_list item as run facts', () =>
    Effect.gen(function* () {
      const { logger } = yield* Effect.promise(() => createLogger());
      const recorded = recordTraceEvents(logger);
      const thread = threadOf([
        {
          type: 'item.completed',
          item: {
            id: 'todo-1',
            type: 'todo_list',
            items: [
              {
                text: 'Route Codex progress through the runtime host',
                completed: false,
              },
            ],
          },
        },
        turnCompleted(1, 1),
      ]);

      yield* runStreamedTurn(thread, 'Do the thing', logger);

      expect(runFactsOfKey(recorded.events, 'todos')).toMatchObject([
        {
          todos: [
            {
              content: 'Route Codex progress through the runtime host',
              status: 'pending',
              activeForm: 'Route Codex progress through the runtime host',
            },
          ],
        },
      ]);
    }),
  );

  it.effect('updates in-flight Codex command items in place', () =>
    Effect.gen(function* () {
      const { store, logger } = yield* Effect.promise(() => createLogger());
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

      const result = yield* runStreamedTurn(
        thread,
        'Build the project',
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
    }),
  );

  it.effect('finalizes the running turn card when the stream errors', () =>
    Effect.gen(function* () {
      const { store, logger } = yield* Effect.promise(() => createLogger());
      const thread = threadOf([
        { type: 'turn.started' },
        { type: 'error', message: 'boom' },
      ]);

      const error = yield* Effect.flip(
        runStreamedTurn(thread, 'Do the thing', logger),
      );
      expect(error.message).toContain('boom');

      const turnEntry = findTurnEntry(store);
      expect(turnEntry).toMatchObject({
        toolName: CODEX_TURN_TOOL,
        input: { state: 'failed' },
        error: 'boom',
        status: 'failed',
      });
    }),
  );

  it.effect(
    'finalizes the running turn card when the stream ends without a terminal turn event',
    () =>
      Effect.gen(function* () {
        const { store, logger } = yield* Effect.promise(() => createLogger());
        // No turn.completed / turn.failed — the loop exits with the card open.
        const thread = threadOf([{ type: 'turn.started' }]);

        yield* runStreamedTurn(thread, 'Do the thing', logger);

        const turnEntry = findTurnEntry(store);
        // Even without an error message the card is failed so the progress view
        // renders failure chrome instead of a success check.
        expect(turnEntry).toMatchObject({
          toolName: CODEX_TURN_TOOL,
          input: { state: 'failed' },
          status: 'failed',
        });
        expect(turnEntry).not.toHaveProperty('error');
      }),
  );
});

function findTurnEntry(store: StreamLog): Record<string, unknown> | undefined {
  return toolLogs(store).find((data) => data.toolName === CODEX_TURN_TOOL);
}
