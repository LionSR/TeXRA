import { describe, expect, it } from 'vitest';

import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  emptyUsageStats,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import { emptySessionView } from '@shared/session/sessionView';
import type { TraceDocument } from '@transcript';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { traceFrame } from '../../../packages/trace-viewer/src/traceFrames';

/** The view the fold reaches over the trace's listing and transcript rows,
 *  with the transcript tier subscribed for the run's stream. */
function foldTrace(trace: TraceDocument) {
  const frame = traceFrame(trace, 'trace', {
    kind: 'subscribe',
    session: 'trace',
    generation: 1,
    cursor: 0,
    aggregates: [{ id: qualifyAggregateId('run', trace.runId), fromSeq: 0 }],
  });
  const view = fold(emptySessionView('trace', 0), [
    {
      _tag: 'subscriptions',
      set: [{ id: qualifyAggregateId('run', trace.runId), fromSeq: 0 }],
    },
    ...frame.events,
    { _tag: 'local', local: { self: [], dead: [], unreadable: [] } },
    { _tag: 'replay.complete', existence: frame.existence! },
  ]);
  return view.runs.get(trace.runId);
}

function parseConfig(category: AgentCategory): AgentConfig {
  return AgentConfigSchema.parse({
    agent: 'correct',
    model: 'gemini35f',
    agentCategory: category,
  });
}

/** A trace document over the run's folded facts, as `assembleTrace` writes it. */
function traceDocument(
  outcome: RunOutcome | null,
  category: AgentCategory = AgentCategory.Workflow,
  meta: Partial<TraceDocument['meta']> = {},
): TraceDocument {
  const runId = 'abc123' as RunId;
  return {
    runId,
    config: parseConfig(category),
    meta: {
      identity: { kind: 'agent', agent: 'assistant' },
      launchedAt: 1_767_225_600_000,
      description: null,
      outcome,
      conversationProgress: { toolCallCount: 0 },
      usage: emptyUsageStats(),
      todos: [],
      plan: null,
      outputs: {},
      missingOutputs: {},
      compileFailures: {},
      ...meta,
    },
    entries: [],
    steps: [],
  };
}

describe('traceFrame replays the document through the one fold', () => {
  it('replays workflow content without tool-use state', () => {
    const trace = traceDocument(null);
    trace.entries.push(
      StreamLogEntrySchema.parse({
        id: 'archived-log',
        seqNo: 1,
        timestamp: 1,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'Archived derivation',
      }),
    );

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.Workflow,
      files: {},
      missingOutputs: {},
      compileFailures: {},
    });
    expect(replayed).not.toHaveProperty('todos');
    expect(replayed?.transcript.rows).toContainEqual(
      expect.objectContaining({
        id: 'archived-log',
        kind: 'log',
        text: expect.objectContaining({ full: 'Archived derivation' }),
      }),
    );
  });

  it('replays tool-use content without workflow output state', () => {
    const trace = traceDocument(null, AgentCategory.ToolUse, {
      todos: [
        {
          content: 'Replay the plan',
          status: 'pending',
          activeForm: 'Replaying the plan',
        },
      ],
    });

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.ToolUse,
      todos: [{ content: 'Replay the plan' }],
      plan: null,
    });
    expect(replayed).not.toHaveProperty('files');
  });

  it.each([
    { outcome: 'failed', expected: 'failed' },
    { outcome: 'completed', expected: 'completed' },
  ] as const)(
    'folds meta.outcome "$outcome" to the terminal status "$expected"',
    ({ outcome, expected }) => {
      const replayed = foldTrace(traceDocument(outcome));
      expect(replayed?.status).toBe(expected);
      expect(replayed?.durableOutcome).toBe(expected);
    },
  );

  it('reports no durable outcome when meta.outcome is null', () => {
    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(traceDocument(null))?.durableOutcome).toBeNull();
  });

  it('projects a process export instruction into the fold command', () => {
    const trace: TraceDocument = {
      ...traceDocument(null),
      config: { name: 'bash', instruction: 'ls -la' },
      meta: {
        ...traceDocument(null).meta,
        identity: { kind: 'process', tool: 'bash' },
      },
    };

    expect(foldTrace(trace)?.command).toBe('ls -la');
  });
});
