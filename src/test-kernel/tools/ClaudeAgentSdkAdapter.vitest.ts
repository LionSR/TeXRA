// Claude Agent SDK boundary tests: authoritative usage folding, current Task
// tool summaries, and replace-semantics background-task projection.

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentEvent, AgentTrace } from '@agent/trace';
import { noopTrace } from '@test/support/noopTrace';
import { ClaudeBackgroundTaskTracker } from '@texra/tools/agentCli/claudeAgentBackgroundTasks';
import { claudeResultUsage } from '@texra/tools/agentCli/claudeAgentShared';

function fakeTrace(): {
  trace: AgentTrace;
  toolStarts: () => AgentEvent[];
  lastToolEnd: () => AgentEvent | undefined;
} {
  const events: AgentEvent[] = [];
  return {
    trace: { ...noopTrace, emit: (event) => void events.push(event) },
    toolStarts: () => events.filter((event) => event.type === 'tool.start'),
    lastToolEnd: () => events.findLast((event) => event.type === 'tool.end'),
  };
}

describe('Claude Agent SDK adapter', () => {
  it('folds authoritative modelUsage across main and nested model calls', () => {
    const usage = claudeResultUsage({
      modelUsage: {
        main: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 5,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
        subagent: {
          inputTokens: 70,
          outputTokens: 30,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 2,
          webSearchRequests: 1,
          costUSD: 0.02,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    } as never);

    expect(usage).toEqual({
      inputTokens: 170,
      outputTokens: 50,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 7,
      cost: 0.03,
    });
  });

  it('keeps empty model usage out of progress accounting', () => {
    expect(claudeResultUsage({ modelUsage: {} } as never)).toBeNull();
  });

  it('replaces the complete background-task level without pairing task edges', () => {
    const { trace, toolStarts, lastToolEnd } = fakeTrace();
    const tracker = new ClaudeBackgroundTaskTracker(trace);

    tracker.replace([
      {
        task_id: 'task-1',
        task_type: 'subagent',
        description: 'Check the proof',
      },
    ]);

    expect(toolStarts()).toHaveLength(1);
    expect(toolStarts()[0]).toMatchObject({
      toolName: 'claude:background_tasks',
      input: { source: 'background_tasks_changed' },
    });
    expect(lastToolEnd()).toMatchObject({
      status: 'in_progress',
      result: {
        summary: '1 Claude background task',
        output: { tasks: [{ task_id: 'task-1' }] },
      },
    });

    tracker.replace([
      {
        task_id: 'task-1',
        task_type: 'subagent',
        description: 'Check the proof',
      },
      {
        task_id: 'task-2',
        task_type: 'shell',
        description: 'Run tests',
      },
    ]);
    expect(lastToolEnd()).toMatchObject({
      status: 'in_progress',
      result: {
        summary: '2 Claude background tasks',
        output: { tasks: [{ task_id: 'task-1' }, { task_id: 'task-2' }] },
      },
    });

    tracker.replace([]);
    expect(lastToolEnd()).toMatchObject({
      status: 'completed',
      result: {
        summary: 'No Claude background tasks remain',
        output: { tasks: [] },
      },
    });
  });
});
