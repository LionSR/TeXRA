// Claude Agent SDK boundary tests: authoritative usage folding, current Task
// tool summaries, and replace-semantics background-task projection.

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentTrace } from '@agent/trace';
import { ClaudeBackgroundTaskTracker } from '@tools/claudeAgentBackgroundTasks';
import {
  aggregateClaudeModelUsage,
  buildClaudeToolUseLog,
  buildClaudeUsageStats,
} from '@tools/claudeAgentShared';

function fakeTrace(): {
  trace: AgentTrace;
  toolStart: ReturnType<typeof vi.fn>;
  toolEnd: ReturnType<typeof vi.fn>;
} {
  const toolStart = vi.fn();
  const toolEnd = vi.fn();
  return {
    trace: {
      activeStageId: () => undefined,
      toolStart,
      toolEnd,
    } as unknown as AgentTrace,
    toolStart,
    toolEnd,
  };
}

describe('Claude Agent SDK adapter', () => {
  it('folds authoritative modelUsage across main and nested model calls', () => {
    const usage = aggregateClaudeModelUsage({
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
    });

    expect(usage).toEqual({
      input_tokens: 170,
      output_tokens: 50,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 7,
      cost_usd: 0.03,
    });
    if (!usage) throw new Error('Expected folded Claude usage');
    expect(buildClaudeUsageStats(usage)).toMatchObject({
      inputTokens: 170,
      outputTokens: 50,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 7,
      cost: 0.03,
    });
  });

  it('keeps absent and empty model usage out of progress accounting', () => {
    expect(aggregateClaudeModelUsage(undefined)).toBeNull();
    expect(aggregateClaudeModelUsage({})).toBeNull();
  });

  it.each([
    [
      'TaskCreate',
      { subject: 'Check the proof' },
      'Create task: Check the proof',
    ],
    [
      'TaskUpdate',
      { taskId: '7', status: 'completed' },
      'Update task: 7 → completed',
    ],
    ['TaskGet', { taskId: '7' }, 'Get task: 7'],
    ['TaskList', {}, 'List tasks'],
    [
      'Agent',
      { description: 'Inspect the parser' },
      'Agent Inspect the parser',
    ],
  ])('summarizes current %s calls', (toolName, input, summary) => {
    expect(
      buildClaudeToolUseLog({
        toolName,
        input,
        status: 'in_progress',
      }).summary,
    ).toBe(summary);
  });

  it('replaces the complete background-task level without pairing task edges', () => {
    const { trace, toolStart, toolEnd } = fakeTrace();
    const tracker = new ClaudeBackgroundTaskTracker(trace);

    tracker.replace([
      {
        task_id: 'task-1',
        task_type: 'subagent',
        description: 'Check the proof',
      },
    ]);

    expect(toolStart).toHaveBeenCalledOnce();
    expect(toolStart.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'claude:background_tasks',
      input: { source: 'background_tasks_changed' },
    });
    expect(toolEnd.mock.calls.at(-1)?.[0]).toMatchObject({
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
    expect(toolEnd.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'in_progress',
      result: {
        summary: '2 Claude background tasks',
        output: { tasks: [{ task_id: 'task-1' }, { task_id: 'task-2' }] },
      },
    });

    tracker.replace([]);
    expect(toolEnd.mock.calls.at(-1)?.[0]).toMatchObject({
      status: 'completed',
      result: {
        summary: 'No Claude background tasks remain',
        output: { tasks: [] },
      },
    });
  });
});
